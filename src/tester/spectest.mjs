// spectest.mjs — SPECTROM headless tester. Boots a ZX Spectrum game with the same WebAssembly core
// the browser uses (JSSpeccy 3, GPL-3.0), checks that it really runs and grabs a screenshot (PNG).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { TAPFile, TZXFile } from '../jsspeccy/runtime/tape.js';
import { parseZ80File, parseSNAFile, parseSZXFile } from '../jsspeccy/runtime/snapshot.js';

const REG_NAMES = ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'];

// Spectrum keyboard matrix
export const KEYS = {
    '1': [3, 0x01], '2': [3, 0x02], '3': [3, 0x04], '4': [3, 0x08], '5': [3, 0x10],
    '6': [4, 0x10], '7': [4, 0x08], '8': [4, 0x04], '9': [4, 0x02], '0': [4, 0x01],
    Q: [2, 0x01], W: [2, 0x02], E: [2, 0x04], R: [2, 0x08], T: [2, 0x10],
    Y: [5, 0x10], U: [5, 0x08], I: [5, 0x04], O: [5, 0x02], P: [5, 0x01],
    A: [1, 0x01], S: [1, 0x02], D: [1, 0x04], F: [1, 0x08], G: [1, 0x10],
    H: [6, 0x10], J: [6, 0x08], K: [6, 0x04], L: [6, 0x02], ENTER: [6, 0x01],
    CAPS: [0, 0x01], Z: [0, 0x02], X: [0, 0x04], C: [0, 0x08], V: [0, 0x10],
    B: [7, 0x10], N: [7, 0x08], M: [7, 0x04], SYM: [7, 0x02], SPACE: [7, 0x01],
};

const PAL = [[0, 0, 0], [0, 0, 0xd7], [0xd7, 0, 0], [0xd7, 0, 0xd7], [0, 0xd7, 0], [0, 0xd7, 0xd7], [0xd7, 0xd7, 0], [0xd7, 0xd7, 0xd7]];
const PALB = [[0, 0, 0], [0, 0, 0xff], [0xff, 0, 0], [0xff, 0, 0xff], [0, 0xff, 0], [0, 0xff, 0xff], [0xff, 0xff, 0], [0xff, 0xff, 0xff]];

let wasmModule = null;

export class Machine {
    constructor(assetsDir) { this.assets = assetsDir; }
    async init() {
        if (!wasmModule) wasmModule = await WebAssembly.compile(fs.readFileSync(path.join(this.assets, 'jsspeccy-core.wasm')));
        const inst = await WebAssembly.instantiate(wasmModule, { env: { abort: () => { throw new Error('wasm abort'); } } });
        this.core = inst.exports;
        const buf = this.core.memory.buffer;
        this.mem = new Uint8Array(buf);
        this.regs = new Uint16Array(buf, this.core.REGISTERS, 12);
        const rom = (f, page) => this.mem.set(fs.readFileSync(path.join(this.assets, 'roms', f)), this.core.MACHINE_MEMORY + page * 0x4000);
        rom('128-0.rom', 8); rom('128-1.rom', 9); rom('48.rom', 10); rom('pentagon-0.rom', 12); rom('trdos.rom', 13);
        this.core.setAudioSamplesPerFrame(0);
        this.core.setTapeTraps(true);
        this.tape = null;
        this.frames = 0;
        return this;
    }
    setMachine(type) { this.core.setMachineType(type); this.core.reset(); this.machine = type; }
    loadSnapshot(s) {
        const c = this.core;
        c.setMachineType(s.model); this.machine = s.model;
        for (const page in s.memoryPages) this.mem.set(s.memoryPages[page], c.MACHINE_MEMORY + page * 0x4000);
        REG_NAMES.forEach((r, i) => { this.regs[i] = s.registers[r]; });
        c.setPC(s.registers.PC); c.setIFF1(s.registers.iff1); c.setIFF2(s.registers.iff2); c.setIM(s.registers.im);
        c.setHalted(!!s.halted);
        c.writePort(0x00fe, s.ulaState.borderColour);
        if (s.model != 48) c.writePort(0x7ffd, s.ulaState.pagingFlags);
        c.setTStates(s.tstates);
    }
    trapTapeLoad() {
        const c = this.core, regs = this.regs;
        if (!this.tape) return;
        const block = this.tape.getNextLoadableBlock();
        if (!block) return;
        const af_ = regs[4];
        const expected = af_ >> 8, shouldLoad = af_ & 1;
        let addr = regs[8]; const len = regs[2];
        let ok = true;
        if (expected != block[0]) ok = false;
        else if (shouldLoad) {
            let off = 1, n = 0, sum = block[0];
            while (n < len) {
                if (off >= block.length) { ok = false; break; }
                const b = block[off++]; n++; c.poke(addr, b); addr = (addr + 1) & 0xffff; sum ^= b;
            }
            ok = ok && off < block.length && sum === block[off];
        }
        if (ok) regs[0] |= 1; else regs[0] &= 0xfffe;
        this.tapeBlocks = (this.tapeBlocks || 0) + 1;
        c.setPC(0x05e2);
    }
    runFrame() {
        let st = this.core.runFrame();
        while (st) {
            if (st === 2) this.trapTapeLoad();
            else throw new Error(st === 1 ? 'unrecognised opcode' : 'runFrame status ' + st);
            st = this.core.resumeFrame();
        }
        this.frames++;
    }
    key(name, down) { const k = KEYS[name]; if (!k) return; if (down) this.core.keyDown(k[0], k[1]); else this.core.keyUp(k[0], k[1]); }
    setKempston(v) { this.core.setKempston(v & 0x1f); }
    screen() {   // 6912 bytes of the visible screen (normal or shadow screen on 128K)
        const out = new Uint8Array(6912);
        for (let i = 0; i < 6912; i++) out[i] = this.core.peek(0x4000 + i);
        return out;
    }
    pc() { return this.core.getPC(); }
}

export function screenStats(scr) {
    let set = 0;
    for (let i = 0; i < 6144; i++) { let b = scr[i]; while (b) { set += b & 1; b >>= 1; } }
    const attrs = new Set();
    let colourful = 0;
    for (let i = 6144; i < 6912; i++) { attrs.add(scr[i] & 0x7f); if ((scr[i] & 0x3f) !== 0x38) colourful++; }
    return { pixelRatio: set / 49152, attrCount: attrs.size, colourfulCells: colourful };
}

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function screenToPng(scr, scale = 1) {
    const W = 256 * scale, H = 192 * scale;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < 192; y++) {
        const rowAddr = ((y & 0xc0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2);
        for (let x = 0; x < 256; x++) {
            const byte = scr[rowAddr + (x >> 3)];
            const attr = scr[6144 + (y >> 3) * 32 + (x >> 3)];
            const pal = attr & 0x40 ? PALB : PAL;
            const on = (byte >> (7 - (x & 7))) & 1;
            const col = pal[on ? attr & 7 : (attr >> 3) & 7];
            for (let sy = 0; sy < scale; sy++) {
                const o = (y * scale + sy) * (W * 3 + 1) + 1;
                for (let sx = 0; sx < scale; sx++) {
                    const p = o + (x * scale + sx) * 3;
                    raw[p] = col[0]; raw[p + 1] = col[1]; raw[p + 2] = col[2];
                }
            }
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hash = (u8) => { let h = 2166136261; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); } return h >>> 0; };

export function detectFormat(name, u8) {
    const n = String(name).toLowerCase();
    if (n.endsWith('.tzx') || (u8.length > 10 && String.fromCharCode(...u8.slice(0, 7)) === 'ZXTape!')) return 'tzx';
    if (n.endsWith('.szx') || (u8.length > 4 && String.fromCharCode(...u8.slice(0, 4)) === 'ZXST')) return 'szx';
    if (n.endsWith('.tap')) return 'tap';
    if (n.endsWith('.z80')) return 'z80';
    if (n.endsWith('.sna')) return 'sna';
    return null;
}

/**
 * Boot a game and decide if it works.
 * opts: { assets, name, data (Uint8Array), machine: 48|128, seconds (default 50) }
 * returns { ok, reason, machine, format, loadSeconds, stats, png, tapeBlocks }
 */
export async function testGame(opts) {
    const u8 = opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const format = detectFormat(opts.name, u8);
    const res = { ok: false, reason: '', machine: opts.machine || 48, format, loadSeconds: 0, stats: null, png: null, tapeBlocks: 0 };
    if (!format) { res.reason = 'unknown file format'; return res; }
    const m = await new Machine(opts.assets).init();
    try {
        if (format === 'tap' || format === 'tzx') {
            if (format === 'tap' && !TAPFile.isValid(ab)) { res.reason = 'invalid TAP'; return res; }
            if (format === 'tzx' && !TZXFile.isValid(ab)) { res.reason = 'invalid TZX'; return res; }
            m.tape = format === 'tap' ? new TAPFile(ab) : new TZXFile(ab);
            const loader = fs.readFileSync(path.join(opts.assets, 'tapeloaders', res.machine === 128 ? 'tape_128.szx' : 'tape_48.z80'));
            const lab = loader.buffer.slice(loader.byteOffset, loader.byteOffset + loader.byteLength);
            m.loadSnapshot(res.machine === 128 ? parseSZXFile(lab) : parseZ80File(lab));
        } else {
            const snap = format === 'z80' ? parseZ80File(ab) : format === 'sna' ? parseSNAFile(ab) : parseSZXFile(ab);
            m.loadSnapshot(snap);
            res.machine = snap.model == 48 ? 48 : 128;
        }
    } catch (e) { res.reason = 'cannot open: ' + (e.message || e); return res; }

    const totalFrames = Math.round((opts.seconds || 50) * 50);
    const hashes = new Set();
    let lastBlocks = 0, lastBlockFrame = 0, best = null, bestScore = -1;
    try {
        for (let f = 0; f < totalFrames; f++) {
            m.runFrame();
            if (m.tapeBlocks !== lastBlocks) { lastBlocks = m.tapeBlocks; lastBlockFrame = f; }
            if (f % 25 === 24) {
                const scr = m.screen();
                if (opts.onFrame) opts.onFrame(scr, f < lastBlockFrame + 50 ? 'loading' : 'running');
                hashes.add(hash(scr));
                const st = screenStats(scr);
                const score = st.attrCount * 4 + st.colourfulCells / 40 + Math.min(st.pixelRatio, 1 - st.pixelRatio) * 50;
                if (f > lastBlockFrame + 50 && score >= bestScore) { bestScore = score; best = scr; }
            }
            // stop early once everything is loaded and the game had ~12 s to show itself
            if (f > lastBlockFrame + 600 && f > 900) break;
        }
    } catch (e) { res.reason = 'crashed: ' + (e.message || e); return res; }

    res.tapeBlocks = m.tapeBlocks || 0;
    res.loadSeconds = Math.round(lastBlockFrame / 50);
    const final = m.screen();
    const stats = screenStats(best || final);
    res.stats = Object.assign(stats, { distinctScreens: hashes.size, frames: m.frames, pc: m.pc() });
    const pngSrc = best || final;
    if ((format === 'tap' || format === 'tzx') && res.tapeBlocks < 2) { res.reason = 'tape did not load (no blocks read)'; return res; }
    const blank = stats.attrCount <= 1 && (stats.pixelRatio < 0.005 || stats.pixelRatio > 0.995);
    const plainBasic = stats.attrCount <= 1 && stats.colourfulCells === 0 && stats.pixelRatio < 0.03;
    if (blank) { res.reason = 'screen stays empty'; return res; }
    if (plainBasic && hashes.size < 4) { res.reason = 'stuck in BASIC (looks like an error report)'; return res; }
    const rich = stats.attrCount >= 3 || stats.colourfulCells > 64;
    if (hashes.size < 2 && !rich) { res.reason = 'screen never changes (frozen)'; return res; }
    res.ok = true;
    res.png = screenToPng(pngSrc, 1);
    // key probe: does the game react to the usual start keys? (also gives an in-game screenshot)
    try {
        const before = hash(m.screen());
        let reacted = null;
        for (const k of ['SPACE', 'ENTER', '1', '0', 'S', 'P']) {
            m.key(k, true); for (let f = 0; f < 8; f++) m.runFrame(); m.key(k, false);
            for (let f = 0; f < 60; f++) { m.runFrame(); if (opts.onFrame && f % 20 === 19) opts.onFrame(m.screen(), 'key ' + k); }
            if (hash(m.screen()) !== before) { reacted = k; break; }
        }
        if (reacted) {
            for (let f = 0; f < 100; f++) { m.runFrame(); if (opts.onFrame && f % 10 === 9) opts.onFrame(m.screen(), 'playing'); }
            const scr2 = m.screen(); const st2 = screenStats(scr2);
            if (!(st2.attrCount <= 1 && st2.pixelRatio < 0.005)) res.png2 = screenToPng(scr2, 1);
        }
        res.stats.reactsTo = reacted;
    } catch (e) { res.stats.reactsTo = null; }
    res.reason = 'boots OK' + (hashes.size > 1 ? ', ' + hashes.size + ' screens' : ', static title') + (res.stats.reactsTo ? ', reacts to ' + res.stats.reactsTo : '');
    return res;
}
