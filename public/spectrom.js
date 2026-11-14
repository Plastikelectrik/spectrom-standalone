// spectrom.js — SPECTROM standalone: ZX Spectrum 48K/128K suite (emulator + AI-curated catalog of games whose rights
// holders allow distribution). Emulator core: JSSpeccy 3 by Matt Westcott (GPL-3.0), served from /jsspeccy/ — see /jsspeccy/COPYING
// Copyright (C) 2026 Plastikelectrik — GNU GPL v3 or later (see LICENSE).
(function () {
    'use strict';
    const VERSION = '1.2.1';
    const API = (window.SPECTROM_API || (location.origin + '/api'));
    const VENDOR = (window.SPECTROM_VENDOR || '/jsspeccy/');
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let inited = false;

    // ---------------- API ----------------
    async function headers(json) { return json ? { 'Content-Type': 'application/json' } : {}; }   // local app: no login
    async function api(path, opts) {
        opts = opts || {};
        const r = await fetch(API + path, { method: opts.method || 'GET', headers: await headers(true), body: opts.body ? JSON.stringify(opts.body) : undefined });
        const d = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
        if (!r.ok && d.ok !== false) d.ok = false;
        if (!r.ok && !d.error) d.error = 'HTTP ' + r.status;
        return d;
    }
    async function apiBinary(path) {
        const r = await fetch(API + path, { headers: await headers(false) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || ('HTTP ' + r.status)); }
        return { buf: await r.arrayBuffer(), name: r.headers.get('X-Spectrom-Name') || 'game.tap', machine: Number(r.headers.get('X-Spectrom-Machine') || 48) };
    }

    // ---------------- save slots: .Z80 v3 codec (registers, RAM pages, 128K paging, AY, T-states). Plain browser JS, also testable in Node.
    const Z80 = (() => {
        const FRAME = { 48: 69888, 128: 70908, 5: 71680 };
        function rle(src) {   // ED ED nn bb: runs of 5+ bytes, or of 2+ 0xED; a byte right after a single 0xED is never in a run
            const out = []; let i = 0;
            while (i < src.length) {
                const b = src[i]; let n = 1;
                while (i + n < src.length && src[i + n] === b && n < 255) n++;
                if (n >= 5 || (b === 0xed && n >= 2)) { out.push(0xed, 0xed, n, b); i += n; continue; }
                out.push(b); i++;
                if (b === 0xed && i < src.length) { out.push(src[i]); i++; }
            }
            return Uint8Array.from(out);
        }
        function unrle(src, len) {
            const out = new Uint8Array(len); let i = 0, o = 0;
            while (i < src.length && o < len) {
                if (src[i] === 0xed && src[i + 1] === 0xed) { const n = src[i + 2], b = src[i + 3]; out.fill(b, o, Math.min(len, o + n)); o += n; i += 4; }
                else out[o++] = src[i++];
            }
            return out;
        }
        function encode(s) {
            const is128 = s.model !== 48, r = s.registers, h = new Uint8Array(86), w16 = (o, v) => { h[o] = v & 255; h[o + 1] = (v >> 8) & 255; };
            h[0] = r.AF >> 8; h[1] = r.AF & 255; w16(2, r.BC); w16(4, r.HL); w16(6, 0); w16(8, r.SP);
            h[10] = r.IR >> 8; h[11] = r.IR & 0x7f;
            h[12] = ((r.IR >> 7) & 1) | ((s.ulaState.borderColour & 7) << 1);
            w16(13, r.DE); w16(15, r.BC_); w16(17, r.DE_); w16(19, r.HL_); h[21] = r.AF_ >> 8; h[22] = r.AF_ & 255;
            w16(23, r.IY); w16(25, r.IX); h[27] = r.iff1 ? 1 : 0; h[28] = r.iff2 ? 1 : 0; h[29] = r.im & 3;
            w16(30, 54); w16(32, r.PC);
            h[34] = s.model === 5 ? 9 : is128 ? 4 : 0;
            h[35] = is128 ? s.ulaState.pagingFlags : 0;
            h[37] = is128 ? 4 : 0;   // AY in use
            if (s.ay) { h[38] = s.ay.selected; for (let i = 0; i < 14; i++) h[39 + i] = s.ay.regs[i]; }
            const q = (FRAME[s.model] || FRAME[48]) / 4, t = s.tstates % (q * 4);
            w16(55, q - 1 - (t % q)); h[57] = (Math.floor(t / q) + 3) % 4;
            const blocks = [h];
            for (const p in s.memoryPages) {
                const n = Number(p), num = is128 ? n + 3 : ({ 5: 8, 2: 4, 0: 5 })[n];
                const data = s.memoryPages[p], c = rle(data);
                const raw = c.length >= 0x4000;
                const head = new Uint8Array(3), body = raw ? data : c, len = raw ? 0xffff : c.length;
                head[0] = len & 255; head[1] = len >> 8; head[2] = num;
                blocks.push(head, body);
            }
            const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0)); let o = 0;
            blocks.forEach((b) => { out.set(b, o); o += b.length; });
            return out;
        }
        function decode(buf) {
            const d = new Uint8Array(buf), r16 = (o) => d[o] | (d[o + 1] << 8);
            const flags = d[12] === 255 ? 1 : d[12];
            const r = { AF: (d[0] << 8) | d[1], BC: r16(2), HL: r16(4), SP: r16(8), IR: (d[10] << 8) | (d[11] & 0x7f) | ((flags & 1) << 7),
                DE: r16(13), BC_: r16(15), DE_: r16(17), HL_: r16(19), AF_: (d[21] << 8) | d[22], IY: r16(23), IX: r16(25),
                iff1: d[27] ? 1 : 0, iff2: d[28] ? 1 : 0, im: d[29] & 3 };
            let pc = r16(6), model = 48, paging = 0, ay = null, tstates = 0, pages = {};
            if (pc !== 0) {   // version 1: 48K, one block
                const mem = (flags & 0x20) ? unrle(d.subarray(30), 0xc000) : d.slice(30, 30 + 0xc000);
                pages = { 5: mem.slice(0, 0x4000), 2: mem.slice(0x4000, 0x8000), 0: mem.slice(0x8000) };
            } else {
                const extra = r16(30), hw = d[34], ver3 = extra >= 54;
                pc = r16(32);
                model = (ver3 ? hw >= 4 : hw >= 3) ? (hw === 9 ? 5 : 128) : 48;
                if (model !== 48) paging = d[35];
                if (d[37] & 4 || model !== 48) ay = { selected: d[38], regs: Array.from(d.subarray(39, 53)) };
                if (ver3) { const q = (FRAME[model] || FRAME[48]) / 4; tstates = ((d[57] + 1) % 4) * q + (q - 1 - r16(55)); }
                let o = 32 + extra;
                while (o + 3 <= d.length) {
                    const len = r16(o), num = d[o + 2]; o += 3;
                    const data = len === 0xffff ? d.slice(o, o + 0x4000) : unrle(d.subarray(o, o + len), 0x4000);
                    o += len === 0xffff ? 0x4000 : len;
                    const page = model === 48 ? ({ 8: 5, 4: 2, 5: 0 })[num] : num - 3;
                    if (page != null && page >= 0 && page < 8) pages[page] = data;
                }
            }
            r.PC = pc;
            return { model, registers: r, memoryPages: pages, ay, halted: false, tstates, ulaState: { borderColour: (flags >> 1) & 7, pagingFlags: paging } };
        }
        return { encode, decode };
    })();

    const SLOTS = ['auto', '1', '2', '3', '4', '5'];
    const slotName = (s) => s === 'auto' ? 'AUTO (on exit)' : 'SLOT ' + s;
    const saveKey = (g) => (/^\d+$/.test(String(g.id)) ? String(g.id) : 'local-' + String(g.title || 'tape').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50));
    const canSave = (g) => !g.copyright;
    async function savePut(path, body, type, meta) {
        const h = await headers(false); h['Content-Type'] = type; if (meta) h['X-Save-Meta'] = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
        const r = await fetch(API + path, { method: 'PUT', headers: h, body });
        const d = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
        if (!r.ok && d.ok !== false) d.ok = false;
        return d;
    }
    async function saveGet(path) {
        const r = await fetch(API + path, { headers: await headers(false) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || ('HTTP ' + r.status)); }
        let meta = {}; try { meta = JSON.parse(decodeURIComponent(escape(atob(r.headers.get('X-Save-Meta') || '')))); } catch (e) { /* ignore */ }
        return { buf: await r.arrayBuffer(), meta };
    }
    const when = (iso) => { try { const d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

    // ---------------- Spectrum look ----------------
    const ZX = { black: '#000', blue: '#0000d7', red: '#d70000', magenta: '#d700d7', green: '#00d700', cyan: '#00d7d7', yellow: '#d7d700', white: '#d7d7d7', bblue: '#0000ff', bred: '#ff0000', bmag: '#ff00ff', bgreen: '#00ff00', bcyan: '#00ffff', byellow: '#ffff00', bwhite: '#ffffff' };
    let romFont = null;   // 96 glyphs × 8 bytes from the 48K ROM (character set at 0x3D00)
    async function loadRomFont() {
        if (romFont) return romFont;
        try { const r = await fetch(VENDOR + 'roms/48.rom'); const b = new Uint8Array(await r.arrayBuffer()); romFont = b.slice(0x3d00, 0x4000); } catch (e) { romFont = null; }
        return romFont;
    }
    const romCache = new Map();
    function romText(text, scale, ink, paper) {
        const key = text + '|' + scale + '|' + ink + '|' + paper;
        if (romCache.has(key)) return romCache.get(key);
        if (!romFont) return null;
        const c = document.createElement('canvas'); c.width = text.length * 8 * scale; c.height = 8 * scale;
        const g = c.getContext('2d');
        if (paper) { g.fillStyle = paper; g.fillRect(0, 0, c.width, c.height); }
        g.fillStyle = ink;
        for (let i = 0; i < text.length; i++) {
            let code = text.charCodeAt(i); if (code === 0xa9) code = 0x7f; if (code < 32 || code > 127) code = 63;
            for (let y = 0; y < 8; y++) {
                const row = romFont[(code - 32) * 8 + y];
                for (let x = 0; x < 8; x++) if (row & (0x80 >> x)) g.fillRect((i * 8 + x) * scale, y * scale, scale, scale);
            }
        }
        const url = c.toDataURL(); romCache.set(key, url); return url;
    }
    function romImg(text, scale, ink, paper, cls) {
        const u = romText(text, scale, ink, paper);
        return u ? `<img class="${cls || ''}" src="${u}" alt="${esc(text)}" style="height:${8 * scale}px;image-rendering:pixelated">` : `<span class="${cls || ''} zx-fallback">${esc(text)}</span>`;
    }

    const CSS = `#spectrom-app{--zx-bg:#000;--zx-panel:#0a0a0c;--zx-line:#26262e;--zx-text:#e9e9e9;--zx-mute:#9a9aa6;--zx-acc:#ff5a4e}
.zx-root{position:relative;font-family:"IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;color:var(--zx-text);background:var(--zx-bg);border-radius:18px;padding:18px 20px 24px;overflow:hidden;min-height:640px;box-shadow:inset 0 0 0 1px #1a1a1a}
.zx-root *{box-sizing:border-box}
.zx-rainbow{position:absolute;right:-40px;top:0;width:260px;height:100%;pointer-events:none;opacity:.9;display:flex;transform:skewX(-28deg);transform-origin:top}
.zx-rainbow i{flex:0 0 22px;margin-left:6px}
.zx-head{position:relative;display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap;margin-bottom:14px;z-index:1}
.zx-logo{display:flex;flex-direction:column;gap:6px;max-width:100%}
.zx-logo img{max-width:min(380px,100%);height:auto!important}
.zx-logorow{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.zx-ver{display:inline-block;border:1px solid #555;background:#111;padding:3px 6px;line-height:0}.zx-logo .zx-ver img{max-width:none;display:block}
.zx-sub{color:var(--zx-mute);font-size:11px;letter-spacing:.25em;text-transform:uppercase}
.zx-chips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;margin-right:220px}
.zx-chip{border:1px solid var(--zx-line);background:#0d0d10;border-radius:4px;padding:6px 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--zx-mute)}
.zx-chip b{color:#fff;font-weight:700}
.zx-chip.live{border-color:#00d700;color:#00ff00}
.zx-tabs{position:relative;z-index:1;display:flex;gap:4px;border-bottom:2px solid #d7d7d7;margin-bottom:16px}
.zx-tab{background:#111;border:0;color:#d7d7d7;padding:9px 16px;font:700 12px/1 "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;letter-spacing:.18em;cursor:pointer;border-radius:3px 3px 0 0}
.zx-tab.on{background:#d7d7d7;color:#000}
.zx-tab:hover:not(.on){background:#1d1d24}
.zx-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;position:relative;z-index:1}
.zx-in,.zx-sel{background:#000;border:2px solid #d7d7d7;color:#fff;padding:8px 10px;font:13px "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;border-radius:0;outline:none}
.zx-in:focus,.zx-sel:focus{border-color:#ffff00}
.zx-in{min-width:220px;flex:1}
.zx-btn{background:#000;border:2px solid #d7d7d7;color:#fff;padding:8px 14px;font:700 12px/1.1 "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
.zx-btn:hover{background:#d7d7d7;color:#000}
.zx-btn.red{border-color:#ff0000;color:#ff4d4d}.zx-btn.red:hover{background:#ff0000;color:#fff}
.zx-btn.go{border-color:#00ff00;color:#00ff00}.zx-btn.go:hover{background:#00d700;color:#000}
.zx-btn.yel{border-color:#ffff00;color:#ffff00}.zx-btn.yel:hover{background:#d7d700;color:#000}
.zx-btn:disabled{opacity:.4;cursor:not-allowed}
.zx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;position:relative;z-index:1}
.zx-card{background:var(--zx-panel);border:1px solid var(--zx-line);cursor:pointer;transition:transform .12s,border-color .12s,box-shadow .12s;position:relative;overflow:hidden}
.zx-card:hover{transform:translateY(-3px);border-color:#ffff00;box-shadow:0 8px 0 -4px #d70000,0 12px 0 -6px #d7d700,0 16px 0 -8px #00d700,0 20px 0 -10px #00d7d7}
.zx-thumb{aspect-ratio:4/3;background:#0000d7;display:block;width:100%;object-fit:cover;image-rendering:pixelated}
.zx-thumb.none{display:flex;align-items:center;justify-content:center;color:#ffff00;font-size:11px;letter-spacing:.2em;background:repeating-linear-gradient(0deg,#d70000 0 6px,#00d7d7 6px 12px)}
.zx-card .zx-swap{position:absolute;inset:0 0 auto 0;aspect-ratio:4/3;opacity:0;transition:opacity .25s}
.zx-card:hover .zx-swap{opacity:1}
.zx-cbody{padding:10px 11px 12px}
.zx-ctitle{font-weight:700;font-size:13px;color:#fff;line-height:1.3;margin-bottom:4px;min-height:34px}
.zx-cmeta{font-size:11px;color:var(--zx-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zx-onl{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.zx-online{width:100%;height:calc(100vh - 240px);min-height:640px;border:1px solid var(--zx-line);border-radius:6px;background:#000;display:block;position:relative;z-index:3}
.zx-badges{position:absolute;top:8px;left:8px;display:flex;gap:4px;flex-wrap:wrap;z-index:2}
.zx-machsw{cursor:pointer}.zx-machsw:hover{filter:brightness(1.3);outline:1px solid #ffff00}
.zx-badge{font:700 10px/1 "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;letter-spacing:.08em;padding:4px 6px;background:#000;border:1px solid #d7d7d7;color:#fff}
.zx-badge.k48{border-color:#00d7d7;color:#00ffff}.zx-badge.k128{border-color:#d700d7;color:#ff66ff}
.zx-badge.ok{border-color:#00d700;color:#00ff00}
.zx-badge.copy{background:#d70000;border-color:#ff0000;color:#fff}
.zx-badge.warn{border-color:#d7d700;color:#ffff00}
.zx-empty{border:2px dashed #333;padding:40px 20px;text-align:center;color:var(--zx-mute);line-height:1.8}
.zx-more{display:flex;justify-content:center;margin-top:16px}
.zx-modal{position:fixed;inset:0;background:rgba(0,0,0,.86);z-index:99990;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:30px 14px}
.zx-sheet{background:#050507;border:2px solid #d7d7d7;max-width:1100px;width:100%;position:relative;font-family:"IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;color:#e9e9e9}
.zx-sheet-top{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#d7d7d7;color:#000}
.zx-sheet-top .x{margin-left:auto;background:none;border:0;font:700 20px "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;cursor:pointer;color:#000}
.zx-sheet-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:20px;padding:18px}
@media(max-width:820px){.zx-sheet-body{grid-template-columns:1fr}.zx-chips{margin-right:0}.zx-rainbow{opacity:.35}}
.zx-gal-main{width:100%;aspect-ratio:4/3;background:#000;object-fit:contain;image-rendering:pixelated;border:1px solid #222}
.zx-gal-strip{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.zx-gal-strip img{width:86px;height:64px;object-fit:cover;image-rendering:pixelated;cursor:pointer;border:2px solid transparent;background:#000}
.zx-gal-strip img.on{border-color:#ffff00}
.zx-gal-cap{font-size:10px;color:var(--zx-mute);letter-spacing:.15em;text-transform:uppercase;margin-top:4px}
.zx-facts{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12px;margin:12px 0}
.zx-facts dt{color:#00d7d7;text-transform:uppercase;letter-spacing:.1em;font-size:10px;padding-top:2px}
.zx-facts dd{margin:0;color:#fff}
.zx-desc{font-size:13px;line-height:1.65;color:#ddd;margin:10px 0}
.zx-h{font:700 11px/1 "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;letter-spacing:.22em;color:#ffff00;margin:16px 0 8px;text-transform:uppercase}
.zx-keys{width:100%;border-collapse:collapse;font-size:12px}
.zx-keys td{padding:5px 6px;border-bottom:1px solid #1c1c22}
.zx-key{display:inline-block;min-width:26px;text-align:center;padding:4px 7px;background:#1a1a1a;border:1px solid #555;border-bottom-width:3px;border-radius:3px;color:#fff;font-weight:700;font-size:11px}
.zx-copy-note{border:2px solid #d70000;background:#1a0000;padding:10px 12px;font-size:12px;line-height:1.55;margin:12px 0;color:#ffd6d6}
.zx-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.zx-player{position:fixed;inset:0;z-index:99995;background:#000;display:flex;flex-direction:column;font-family:"IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;color:#eee}
.zx-pbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#0b0b0e;border-bottom:1px solid #222;flex-wrap:wrap}
.zx-pbar .t{font-weight:700;color:#fff;margin-right:8px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw}
.zx-pbar .zx-btn{padding:6px 10px;font-size:11px}
.zx-pbar .zx-sel{padding:5px 8px;font-size:12px}
.zx-pbar .sp{flex:1}
.zx-stagewrap{flex:1;display:flex;min-height:0}
.zx-stage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;outline:none;background:#000;min-width:0;overflow:hidden}
.zx-stage.loading{animation:zxload .09s steps(2) infinite}
@keyframes zxload{0%{box-shadow:inset 0 0 0 9999px transparent,inset 0 0 0 60px #d70000}50%{box-shadow:inset 0 0 0 60px #00d7d7}}
.zx-screen{position:relative;height:min(100%,calc((100vw - var(--zx-side,0px)) * .75));aspect-ratio:4/3;max-width:100%}
.zx-screen canvas{width:100%;height:100%;display:block;image-rendering:pixelated}
.zx-screen.smooth canvas{image-rendering:auto}
.zx-screen.crt{border-radius:18px/14px;overflow:hidden;filter:saturate(1.15) contrast(1.06) brightness(1.06)}
.zx-screen.crt::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 1px,transparent 1px 3px),radial-gradient(ellipse at center,transparent 58%,rgba(0,0,0,.55) 100%);mix-blend-mode:multiply}
.zx-screen.crt::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;box-shadow:inset 0 0 70px rgba(120,200,255,.10);animation:zxflick 4s infinite}
@keyframes zxflick{0%,100%{opacity:.9}50%{opacity:1}}
.zx-side{width:300px;flex:0 0 300px;background:#07070a;border-left:1px solid #222;overflow:auto;padding:12px 14px;font-size:12px}
.zx-side.hide{display:none}
.zx-msg{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:#000;border:2px solid #ffff00;color:#ffff00;padding:8px 14px;font-size:12px;letter-spacing:.08em;z-index:5;pointer-events:none;transition:opacity .3s}
.zx-help{position:absolute;inset:6%;background:rgba(0,0,0,.92);border:2px solid #d7d7d7;z-index:6;overflow:auto;padding:18px 22px;display:none;font-size:13px}
.zx-help.on{display:block}
.zx-saves{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:10px}
.zx-slot{border:2px solid #444;background:#0a0a0a;padding:8px;display:flex;flex-direction:column;gap:6px}
.zx-slot.has{border-color:#00d7d7}.zx-slot.auto{border-style:dashed}
.zx-slot .th{aspect-ratio:4/3;background:#111 center/cover no-repeat;image-rendering:pixelated;display:flex;align-items:center;justify-content:center;color:#555;font-size:12px}
.zx-slot .nm{font-weight:700;letter-spacing:.1em;font-size:12px;color:#ffff00}.zx-slot .dt{font-size:11px;color:#aaa;min-height:14px}
.zx-slot .bt{display:flex;gap:6px;flex-wrap:wrap}.zx-slot .zx-btn{padding:5px 8px;font-size:10px}
.zx-cont{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.zx-player:fullscreen .zx-pbar{position:absolute;top:0;left:0;right:0;z-index:7;opacity:0;transition:opacity .25s}
.zx-player:fullscreen .zx-pbar:hover,.zx-player:fullscreen.zx-ui .zx-pbar{opacity:1}
.zx-player:fullscreen .zx-side{display:none}
.zx-player:fullscreen .zx-screen{height:min(100vh,calc(100vw * .75))}
.zx-agent{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;position:relative;z-index:1}
@media(max-width:900px){.zx-agent{grid-template-columns:1fr}}
.zx-box{background:var(--zx-panel);border:1px solid var(--zx-line);padding:14px}
.zx-box h3{margin:0 0 10px;font:700 12px/1 "IBM Plex Mono","Fira Mono",Menlo,Consolas,monospace;letter-spacing:.2em;color:#ffff00;text-transform:uppercase}
.zx-stat{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px}
.zx-stat span:nth-child(odd){color:#00d7d7;text-transform:uppercase;font-size:10px;letter-spacing:.1em;padding-top:2px}
.zx-prog{height:14px;border:2px solid #d7d7d7;margin:10px 0;position:relative;background:#000}
.zx-prog i{position:absolute;inset:0 auto 0 0;background:repeating-linear-gradient(90deg,#d70000 0 8px,#d7d700 8px 16px,#00d700 16px 24px,#00d7d7 24px 32px);transition:width .4s}
.zx-console{background:#000;border:2px solid #333;height:360px;overflow:auto;padding:8px 10px;font-size:11.5px;line-height:1.5;color:#00ff00;white-space:pre-wrap;word-break:break-word}
.zx-console .warn{color:#ffff00}.zx-console .error{color:#ff4d4d}.zx-console .ts{color:#3a7a3a}
.zx-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
.zx-row label{font-size:11px;color:var(--zx-mute);letter-spacing:.08em}
.zx-results{max-height:300px;overflow:auto;margin-top:8px}
.zx-res{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #1a1a1f;font-size:12px}
.zx-res .n{flex:1;min-width:0}
.zx-res .n small{display:block;color:var(--zx-mute);font-size:10.5px}
.zx-drop{border:2px dashed #d7d7d7;padding:40px 20px;text-align:center;position:relative;z-index:1;line-height:1.9}
.zx-drop.over{border-color:#ffff00;background:#111100}
.zx-toast{position:fixed;right:18px;bottom:18px;z-index:99999;background:#000;border:2px solid #d7d7d7;color:#fff;padding:10px 14px;font:12px "IBM Plex Mono",monospace;max-width:380px}
.zx-toast.err{border-color:#ff0000;color:#ff8080}
.zx-fallback{font-weight:700;letter-spacing:.12em}
.zx-live{grid-column:1/-1}
.zx-live-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;align-items:start}
@media(max-width:900px){.zx-live-grid{grid-template-columns:1fr}}
.zx-tv{position:relative;background:#111;border:14px solid #1b1b1f;border-radius:22px;box-shadow:0 0 0 2px #333,0 10px 30px rgba(0,0,0,.6);aspect-ratio:4/3;overflow:hidden}
.zx-tv canvas{width:100%;height:100%;display:block;image-rendering:pixelated;filter:saturate(1.15) contrast(1.05)}
.zx-tv::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.25) 0 1px,transparent 1px 3px),radial-gradient(ellipse at center,transparent 60%,rgba(0,0,0,.6) 100%)}
.zx-tv-label{position:absolute;left:10px;top:10px;z-index:2;background:rgba(0,0,0,.75);border:1px solid #00d7d7;color:#00ffff;font-size:11px;padding:4px 8px;letter-spacing:.08em;max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.zx-tv-step{position:absolute;left:10px;bottom:10px;z-index:2;background:rgba(0,0,0,.75);color:#ffff00;font-size:10.5px;padding:3px 7px;letter-spacing:.1em;text-transform:uppercase}
.zx-stamp{position:absolute;right:14px;top:50%;z-index:3;transform:translateY(-50%) rotate(-12deg) scale(.4);opacity:0;font:700 34px/1 "IBM Plex Mono",monospace;padding:8px 16px;border:5px solid;letter-spacing:.1em;transition:all .25s cubic-bezier(.3,1.6,.6,1)}
.zx-stamp.on{opacity:1;transform:translateY(-50%) rotate(-12deg) scale(1)}
.zx-stamp.ok{color:#00ff00;border-color:#00ff00;background:rgba(0,40,0,.8)}.zx-stamp.fail{color:#ff3b3b;border-color:#ff3b3b;background:rgba(40,0,0,.8)}
.zx-team{display:flex;flex-direction:column;gap:8px}
.zx-role{display:grid;grid-template-columns:40px 1fr;gap:10px;align-items:center;border:1px solid #222;padding:9px 10px;background:#08080b;transition:all .2s}
.zx-role i.ic{font-size:20px;color:#555;text-align:center}
.zx-role b{display:block;font-size:12px;letter-spacing:.16em;color:#888}
.zx-role small{display:block;font-size:11px;color:#666;margin-top:3px;min-height:14px}
.zx-role.on{border-color:#ffff00;background:#14140a;box-shadow:inset 4px 0 0 #ffff00}
.zx-role.on i.ic{color:#ffff00}.zx-role.on b{color:#fff}.zx-role.on small{color:#e6e6a0}
.zx-role.on small::after{content:"\\2588";animation:zxblink 1s steps(1) infinite;margin-left:3px}
@keyframes zxblink{50%{opacity:0}}
.zx-badge.priv{background:#d700d7;border-color:#ff00ff;color:#fff}
.zx-vol{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#bbb}
.zx-vol input{width:90px;accent-color:#ffff00}
.zx-chip.btn{cursor:pointer}.zx-chip.btn:hover{border-color:#ffff00;color:#ffff00}
.zx-footer{margin-top:22px;font-size:10.5px;color:#55555f;line-height:1.6;position:relative;z-index:1}
.zx-footer a{color:#77778a}
.zx-heart{position:absolute;top:6px;right:6px;z-index:3;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.72);border:1px solid #555;color:#ddd;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:transform .12s,color .12s,border-color .12s}
.zx-heart svg{fill:none;stroke:currentColor;stroke-width:2}
.zx-heart:hover{color:#ff8fab;border-color:#ff8fab;transform:scale(1.08)}
.zx-heart.on{color:#ff3b6b;border-color:#ff3b6b}.zx-heart.on svg{fill:currentColor}
.zx-heart.big{position:static;width:auto;height:auto;border-radius:0;padding:10px 14px;gap:8px;font:600 12px "IBM Plex Mono",monospace;letter-spacing:.06em;background:#111}
.zx-heart.pop svg{animation:zxpop .35s}
@keyframes zxpop{50%{transform:scale(1.55)}}
.zx-favhead{display:flex;align-items:center;gap:10px;color:#ffb3c4;font-size:12px;margin-bottom:10px;position:relative;z-index:1}.zx-favhead svg{fill:#ff3b6b;stroke:#ff3b6b}
.zx-gal-open{display:block;position:relative;padding:0;border:0;background:none;cursor:zoom-in;width:100%}
.zx-gal-zoom{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.75);color:#fff;padding:2px 8px;font-size:16px;border:1px solid #555}
.zx-gal-group{margin-top:10px}.zx-gal-gh{font-size:10px;color:#00d7d7;letter-spacing:.15em;text-transform:uppercase;margin-bottom:4px}.zx-gal-gh small{color:#888;margin-left:4px}
.zx-gal-strip .zx-gal-th{padding:0;border:2px solid transparent;background:#000;cursor:pointer;width:86px;height:64px}
.zx-gal-strip .zx-gal-th img{width:100%;height:100%;object-fit:cover;display:block;border:0}
.zx-gal-strip .zx-gal-th.on{border-color:#ffff00}
.zx-gal-doc{display:inline-flex;flex-direction:column;justify-content:center;align-items:center;gap:2px;width:86px;height:64px;border:1px solid #444;color:#ddd;text-decoration:none;font-size:9px;line-height:1.2;text-align:center;padding:4px;box-sizing:border-box;background:#0b0b0b}
.zx-gal-doc b{color:#ff6b6b;font-size:13px}.zx-gal-doc:hover{border-color:#ffff00}
.zx-lb{position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,.95);display:flex;flex-direction:column}
.zx-lb-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 14px;color:#ddd;font:12px "IBM Plex Mono",monospace;letter-spacing:.08em;border-bottom:1px solid #333}
.zx-lb-bar button,.zx-lb-bar a{background:#111;border:1px solid #444;color:#fff;margin-left:6px;padding:5px 10px;cursor:pointer;text-decoration:none;font-size:14px}
.zx-lb-stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;min-height:0;padding:10px}
.zx-lb-stage img{max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in}
.zx-lb-stage.zoom{display:block;text-align:center}.zx-lb-stage.zoom img{max-width:none;max-height:none;cursor:zoom-out}
.zx-lb-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.6);border:1px solid #555;color:#fff;font-size:38px;width:52px;height:72px;cursor:pointer}
.zx-lb-nav.prev{left:10px}.zx-lb-nav.next{right:10px}
.zx-lb-text{flex:1;overflow:auto;margin:0;padding:18px 22px;color:#e8e8e8;font:13px/1.6 "IBM Plex Mono",monospace;white-space:pre-wrap}
.zx-inl{vertical-align:-1px;display:inline;height:.8em!important;width:auto}`;

    function toast(msg, err) {
        const t = document.createElement('div'); t.className = 'zx-toast' + (err ? ' err' : ''); t.textContent = msg;
        document.body.appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 3200);
    }
    const machineBadge = (g) => {
        const m = g.testedMachine || (g.machineType === 5 ? 128 : (/128/.test(g.machine || '') && !/48/.test(g.machine || '') ? 128 : 48));
        return `<span class="zx-badge ${m === 128 ? 'k128' : 'k48'}">${m}K</span>`;
    };

    // ---------------- prefs + sound effects (synthesized, nothing downloaded) ----------------
    function prefs() { try { return JSON.parse(localStorage.getItem('spectrom.prefs') || '{}'); } catch (e) { return {}; } }
    function savePrefs(patch) { const p = Object.assign(prefs(), patch); try { localStorage.setItem('spectrom.prefs', JSON.stringify(p)); } catch (e) { /* ignore */ } }
    const SFX = {
        ctx: null, on: prefs().sound !== false,
        ensure() {
            if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
            if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
            return this.ctx;
        },
        beep(freq, dur, vol, when) {
            if (!this.on) return; const c = this.ensure(); if (!c) return;
            const o = c.createOscillator(), g = c.createGain(); o.type = 'square'; o.frequency.value = freq; g.gain.value = vol || 0.05;
            o.connect(g); g.connect(c.destination); const t = c.currentTime + (when || 0); o.start(t); o.stop(t + dur);
        },
        click() { this.beep(1350, 0.018, 0.035); },
        ok() { [988, 1319, 1760].forEach((f, i) => this.beep(f, 0.08, 0.05, i * 0.09)); },
        fail() { this.beep(196, 0.16, 0.06); this.beep(147, 0.26, 0.06, 0.18); },
        // ZX Spectrum tape: pilot tone (2168 T half-periods, ~807 Hz), sync, then data bits (855/1710 T)
        tape(seconds, vol) {
            if (!this.on) return () => {}; const c = this.ensure(); if (!c) return () => {};
            const sr = c.sampleRate, n = Math.floor(sr * (seconds || 3)), buf = c.createBuffer(1, n, sr), d = buf.getChannelData(0);
            const T = 3500000, pilotEnd = Math.min(n, Math.floor(sr * 1.1));
            let i = 0, level = 0.9;
            const half = (tst) => { const len = Math.max(1, Math.round(tst / T * sr)); for (let k = 0; k < len && i < n; k++) d[i++] = level; level = -level; };
            while (i < pilotEnd) half(2168);
            half(667); half(735);
            while (i < n) { const bit = Math.random() < 0.5 ? 855 : 1710; half(bit); half(bit); }
            const src = c.createBufferSource(), g = c.createGain(); g.gain.value = vol || 0.04; src.buffer = buf; src.connect(g); g.connect(c.destination); src.start();
            return () => { try { src.stop(); } catch (e) { /* ignore */ } };
        },
    };
    // decode a 6912-byte Spectrum screen into a 256x192 canvas
    const PAL = [[0, 0, 0], [0, 0, 215], [215, 0, 0], [215, 0, 215], [0, 215, 0], [0, 215, 215], [215, 215, 0], [215, 215, 215]];
    const PALB = [[0, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 255], [0, 255, 0], [0, 255, 255], [255, 255, 0], [255, 255, 255]];
    function drawScr(ctx, b64) {
        const bin = atob(b64); const scr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) scr[i] = bin.charCodeAt(i);
        const img = ctx.createImageData(256, 192); const px = img.data;
        for (let y = 0; y < 192; y++) {
            const row = ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
            for (let x = 0; x < 256; x++) {
                const attr = scr[6144 + (y >> 3) * 32 + (x >> 3)], on = (scr[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                const col = (attr & 0x40 ? PALB : PAL)[on ? attr & 7 : (attr >> 3) & 7]; const o = (y * 256 + x) * 4;
                px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    function romCanvasText(ctx, text, x, y, ink, scale) {
        if (!romFont) return; ctx.fillStyle = ink; scale = scale || 1;
        for (let i = 0; i < text.length; i++) {
            let code = text.charCodeAt(i); if (code < 32 || code > 127) code = 63;
            for (let r = 0; r < 8; r++) { const bits = romFont[(code - 32) * 8 + r]; for (let c = 0; c < 8; c++) if (bits & (0x80 >> c)) ctx.fillRect(x + (i * 8 + c) * scale, y + r * scale, scale, scale); }
        }
    }

    // ---------------- emulator vendor ----------------
    let vendorPromise = null;
    function loadVendor() {
        if (window.JSSpeccyCore) return Promise.resolve(window.JSSpeccyCore);
        if (vendorPromise) return vendorPromise;
        vendorPromise = new Promise((ok, ko) => {
            const s = document.createElement('script'); s.src = VENDOR + 'jsspeccy.js?v=' + VERSION;
            s.onload = () => window.JSSpeccyCore ? ok(window.JSSpeccyCore) : ko(new Error('emulator core missing'));
            s.onerror = () => { vendorPromise = null; ko(new Error('cannot load the emulator (' + VENDOR + 'jsspeccy.js)')); };
            document.head.appendChild(s);
        });
        return vendorPromise;
    }

    // ---------------- input: Spectrum matrix, presets, remapping ----------------
    const SK = { '1': [3, 1], '2': [3, 2], '3': [3, 4], '4': [3, 8], '5': [3, 16], '6': [4, 16], '7': [4, 8], '8': [4, 4], '9': [4, 2], '0': [4, 1],
        Q: [2, 1], W: [2, 2], E: [2, 4], R: [2, 8], T: [2, 16], Y: [5, 16], U: [5, 8], I: [5, 4], O: [5, 2], P: [5, 1],
        A: [1, 1], S: [1, 2], D: [1, 4], F: [1, 8], G: [1, 16], H: [6, 16], J: [6, 8], K: [6, 4], L: [6, 2], ENTER: [6, 1],
        CAPS: [0, 1], Z: [0, 2], X: [0, 4], C: [0, 8], V: [0, 16], B: [7, 16], N: [7, 8], M: [7, 4], SYM: [7, 2], SPACE: [7, 1] };
    const KEMP = { up: 8, down: 4, left: 2, right: 1, fire: 16 };
    const TARGETS = [...Object.keys(SK).map((k) => [k, k === 'CAPS' ? 'CAPS SHIFT' : k === 'SYM' ? 'SYMBOL SHIFT' : k]),
        ['CAPS+SPACE', 'BREAK'], ['CAPS+0', 'DELETE'], ['J:up', 'Kempston ↑'], ['J:down', 'Kempston ↓'], ['J:left', 'Kempston ←'], ['J:right', 'Kempston →'], ['J:fire', 'Kempston FIRE']];
    const targetLabel = (t) => { const f = TARGETS.find((x) => x[0] === t); return f ? f[1] : String(t).replace('CAPS', 'CAPS SHIFT').replace('SYM', 'SYMBOL SHIFT'); };
    const PRESETS = {
        game: { label: 'From the game instructions' },
        kempston: { label: 'Kempston joystick', up: 'J:up', down: 'J:down', left: 'J:left', right: 'J:right', fire: 'J:fire' },
        cursor: { label: 'Cursor joystick (5 6 7 8 + 0)', up: '7', down: '6', left: '5', right: '8', fire: '0' },
        sinclair1: { label: 'Sinclair IF2 port 1 (6 7 8 9 + 0)', up: '9', down: '8', left: '6', right: '7', fire: '0' },
        sinclair2: { label: 'Sinclair IF2 port 2 (1 2 3 4 + 5)', up: '4', down: '3', left: '1', right: '2', fire: '5' },
        qaop: { label: 'Q A O P + SPACE', up: 'Q', down: 'A', left: 'O', right: 'P', fire: 'SPACE' },
        qaopm: { label: 'Q A O P + M', up: 'Q', down: 'A', left: 'O', right: 'P', fire: 'M' },
        zxkm: { label: 'Z X (left right) K M (up down) + SPACE', up: 'K', down: 'M', left: 'Z', right: 'X', fire: 'SPACE' },
        keys: { label: 'Keyboard only (arrows = cursor keys)', up: 'CAPS+7', down: 'CAPS+6', left: 'CAPS+5', right: 'CAPS+8', fire: null },
    };
    const PAD_EXTRA = { 'Pad:b': 'SPACE', 'Pad:x': 'ENTER', 'Pad:y': '1' };
    function codeLabel(code) {
        return String(code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/^Arrow(\w+)/, (m, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' }[d] || d))
            .replace(/(Left|Right)$/, (m) => (m === 'Left' ? ' L' : ' R')).replace(/^Pad:/, 'Pad ');
    }
    function baseMap() {
        const m = {};
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c) => { m['Key' + c] = c; });
        '0123456789'.split('').forEach((d) => { m['Digit' + d] = d; m['Numpad' + d] = d; });
        Object.assign(m, { Enter: 'ENTER', NumpadEnter: 'ENTER', Space: 'SPACE', ShiftLeft: 'CAPS', ShiftRight: 'CAPS', ControlLeft: 'SYM', ControlRight: 'SYM', AltLeft: 'SYM',
            Backspace: 'CAPS+0', Tab: 'CAPS+SYM', Comma: 'SYM+N', Period: 'SYM+M', Minus: 'SYM+J', Equal: 'SYM+L', Slash: 'SYM+V', Semicolon: 'SYM+O', Quote: 'SYM+P' });
        return m;
    }
    // directions from the keys the agent read in the instructions
    function gameKeysPreset(g) {
        const out = {}; const norm = (k) => { k = String(k).toUpperCase().trim(); if (k === 'SYMBOL SHIFT' || k === 'SYM SHIFT') return 'SYM'; if (k === 'CAPS SHIFT') return 'CAPS'; if (k === 'BREAK') return 'CAPS+SPACE'; return SK[k] ? k : null; };
        for (const k of g.keys || []) {
            const t = norm(k.key); if (!t) continue; const a = String(k.action).toLowerCase();
            const slot = /\bleft\b/.test(a) ? 'left' : /\bright\b/.test(a) ? 'right' : /\b(up|jump|thrust|climb)\b/.test(a) ? 'up' : /\b(down|crouch|duck|dive)\b/.test(a) ? 'down' : /\b(fire|shoot|action|kick|punch|use|bomb)\b/.test(a) ? 'fire' : null;
            if (slot && !out[slot]) out[slot] = t;
        }
        return out.left && out.right ? Object.assign({ label: 'From the game instructions' }, out) : null;
    }

    class Player {
        constructor(app, game) { this.app = app; this.game = game || {}; this.held = new Map(); this.keyCount = {}; this.kempCount = {}; this.padHeld = new Set(); }
        loadControls() {
            const pf = prefs(); const g = this.game;
            this.gamePreset = gameKeysPreset(g);
            const saved = pf['ctl.' + g.id] || pf['ctl.default'];
            if (saved && PRESETS[saved.preset] && (saved.preset !== 'game' || this.gamePreset)) { this.ctl = { preset: saved.preset, custom: Object.assign({}, saved.custom || {}) }; return; }
            const modes = g.joystick || [];
            const preset = this.gamePreset ? 'game' : modes.includes('kempston') ? 'kempston' : modes.includes('cursor') ? 'cursor' : modes.includes('sinclair1') ? 'sinclair1' : modes.includes('sinclair2') ? 'sinclair2' : 'qaop';
            this.ctl = { preset, custom: {} };
        }
        presetDef() { return this.ctl.preset === 'game' ? (this.gamePreset || PRESETS.qaop) : PRESETS[this.ctl.preset]; }
        buildMap() {
            this.releaseAll();
            const m = baseMap(); const p = this.presetDef();
            m.ArrowUp = p.up || 'CAPS+7'; m.ArrowDown = p.down || 'CAPS+6'; m.ArrowLeft = p.left || 'CAPS+5'; m.ArrowRight = p.right || 'CAPS+8';
            if (p.fire) { m.ControlLeft = p.fire; m.ControlRight = p.fire; }
            m['Pad:up'] = m.ArrowUp; m['Pad:down'] = m.ArrowDown; m['Pad:left'] = m.ArrowLeft; m['Pad:right'] = m.ArrowRight; m['Pad:a'] = p.fire || 'SPACE';
            Object.assign(m, PAD_EXTRA, this.ctl.custom);
            this.map = m;
        }
        saveControls(asDefault) {
            const patch = { ['ctl.' + this.game.id]: { preset: this.ctl.preset, custom: this.ctl.custom } };
            if (asDefault) patch['ctl.default'] = { preset: this.ctl.preset === 'game' ? 'qaop' : this.ctl.preset, custom: this.ctl.custom };
            savePrefs(patch);
        }
        // --- pressing Spectrum keys / Kempston bits with reference counts (two PC keys can share a target)
        apply(target, d) {
            const e = this.emu; if (!e || !target) return;
            let kempChanged = false;
            for (const part of String(target).split('+')) {
                if (part.startsWith('J:')) { const b = part.slice(2); this.kempCount[b] = Math.max(0, (this.kempCount[b] || 0) + d); kempChanged = true; continue; }
                const k = SK[part]; if (!k) continue;
                const before = this.keyCount[part] || 0, after = Math.max(0, before + d); this.keyCount[part] = after;
                if (before === 0 && after > 0) e.worker.postMessage({ message: 'keyDown', row: k[0], mask: k[1] });
                if (before > 0 && after === 0) e.worker.postMessage({ message: 'keyUp', row: k[0], mask: k[1] });
            }
            if (kempChanged) { let v = 0; for (const b in KEMP) if (this.kempCount[b] > 0) v |= KEMP[b]; e.setKempston(v); }
        }
        press(code, down) {
            const t = this.map && this.map[code]; if (!t) return false;
            if (down) { if (this.held.has(code)) return true; this.held.set(code, t); this.apply(t, +1); }
            else { const t0 = this.held.get(code); if (t0 == null) return true; this.held.delete(code); this.apply(t0, -1); }
            return true;
        }
        releaseAll() {
            for (const [code, t] of this.held) this.apply(t, -1);
            this.held.clear(); this.padHeld.clear();
            if (this.emu) { for (const k in this.keyCount) if (this.keyCount[k] > 0 && SK[k]) this.emu.worker.postMessage({ message: 'keyUp', row: SK[k][0], mask: SK[k][1] }); this.emu.setKempston(0); }
            this.keyCount = {}; this.kempCount = {};
        }
        async open(loader) {
            const g = this.game;
            this.loadControls(); this.buildMap();
            const pf = prefs();
            this.crt = pf.crt !== false; this.smooth = !!pf.smooth;
            const el = document.createElement('div'); el.className = 'zx-player'; this.el = el;
            el.innerHTML = `<div class="zx-pbar">
                <span class="t">${esc(g.title || 'ZX Spectrum')}</span>
                <button type="button" class="zx-badge zx-machsw" data-mach data-a="machine" title="Switch 48K / 128K and load the game again (F7) — remembered for this game">—</button>
                <button class="zx-btn" data-a="pause" title="Pause (F8)"><i class="fas fa-pause"></i></button>
                <button class="zx-btn" data-a="reset" title="Reset (F9)"><i class="fas fa-rotate-left"></i></button>
                <button class="zx-btn yel" data-a="controls" title="Remap the controls (F2)"><i class="fas fa-gamepad"></i> CONTROLS</button>
                <button class="zx-btn" data-a="saves" title="Save / load the game (F5 slots · F6 continue the last save)" style="border-color:#00d7d7;color:#7ff"><i class="fas fa-floppy-disk"></i> SAVES</button>
                <span class="zx-vol"><button class="zx-btn" data-a="mute" title="Mute"><i class="fas fa-volume-high"></i></button><input type="range" min="0" max="100" data-vol title="Volume"></span>
                <button class="zx-btn" data-a="crt" title="CRT effect">CRT</button>
                <button class="zx-btn" data-a="smooth" title="Pixel perfect / smooth">PIX</button>
                <span class="sp"></span>
                <button class="zx-btn" data-a="help" title="Game keys (F1)"><i class="fas fa-keyboard"></i> KEYS</button>
                <button class="zx-btn" data-a="side" title="Side panel"><i class="fas fa-table-columns"></i></button>
                <button class="zx-btn go" data-a="fs" title="Fullscreen (F11)"><i class="fas fa-expand"></i> FULLSCREEN</button>
                <button class="zx-btn red" data-a="close" title="Exit (power off)"><i class="fas fa-power-off"></i></button>
            </div>
            <div class="zx-stagewrap"><div class="zx-stage loading" tabindex="0"><div class="zx-screen"></div><div class="zx-help"></div><div class="zx-help zx-remap"></div><div class="zx-help zx-savep"></div><div class="zx-msg">LOADING…</div></div><aside class="zx-side"></aside></div>`;
            document.body.appendChild(el);
            this.stage = $('.zx-stage', el); this.screen = $('.zx-screen', el); this.msgEl = $('.zx-msg', el); this.side = $('.zx-side', el); this.remapEl = $('.zx-remap', el); this.saveEl = $('.zx-savep', el);
            this.applyView();
            this.renderHelp();
            el.addEventListener('click', (ev) => { const b = ev.target.closest('[data-a]'); if (b && b.tagName === 'BUTTON') this.action(b.dataset.a); });
            this.volume = pf.volume != null ? pf.volume : 80;
            $('[data-vol]', el).value = this.volume;
            $('[data-vol]', el).addEventListener('input', (ev) => { this.volume = Number(ev.target.value); savePrefs({ volume: this.volume }); this.applyVolume(); });
            // keyboard: captured on the whole window while the player is open, wherever the focus is
            this.onKey = (ev) => this.keyEvent(ev);
            window.addEventListener('keydown', this.onKey, true); window.addEventListener('keyup', this.onKey, true);
            this.onBlur = () => this.releaseAll();
            window.addEventListener('blur', this.onBlur); document.addEventListener('visibilitychange', this.onBlur);
            this.onFs = () => { el.classList.toggle('zx-ui', false); };
            document.addEventListener('fullscreenchange', this.onFs);
            let uiTimer = null;
            el.addEventListener('mousemove', () => { el.classList.add('zx-ui'); clearTimeout(uiTimer); uiTimer = setTimeout(() => el.classList.remove('zx-ui'), 2200); });
            document.documentElement.style.overflow = 'hidden';
            try {
                const core = await loadVendor();
                const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240; this.screen.appendChild(canvas);
                this.emu = new core.Emulator(canvas, { machine: 48, autoStart: false, autoLoadTapes: true, tapeAutoLoadMode: 'default', tapeTrapsEnabled: true, keyboardEnabled: false });
                await new Promise((ok) => { if (this.emu.isReady) ok(); else this.emu.onReadyHandlers.push(ok); });
                this.msg('LOADING ' + (g.title || '').toUpperCase().slice(0, 30) + '…', 0);
                this.stopTape = SFX.tape(8, 0.035 * (this.volume / 100));
                this.loader = loader;
                const file = await loader();
                const forced = Number(prefs()['mach.' + (g.id || g.title)]);
                const machine = forced === 48 || forced === 128 ? forced : file.machine === 128 ? 128 : 48;
                this.emu.setMachine(machine); this.machine = machine;
                this.showMachine(machine);
                await this.emu.openData(file.name, file.buf);
                file.buf = null;    // a © temporary copy only lives inside the emulator memory from here on
                await new Promise((r) => setTimeout(r, 650));   // let the border stripes play a moment
                this.stage.classList.remove('loading');
                if (this.stopTape) { this.stopTape(); this.stopTape = null; }
                this.emu.start();
                this.applyVolume();
                setTimeout(() => { if (this.emu && this.emu.getAudioState && this.emu.getAudioState() === 'suspended') this.msg('CLICK OR PRESS A KEY FOR SOUND', 3500); }, 900);
                const p = this.presetDef();
                this.msg((g.startKey ? 'PRESS ' + String(g.startKey).toUpperCase() + ' TO START · ' : '') + 'ARROWS = ' + [p.left, p.right, p.up, p.down].filter(Boolean).map(targetLabel).join(' ') + (p.fire ? ' · CTRL = ' + targetLabel(p.fire) : '') + ' · F2 = CONTROLS', 6000);
                this.startGamepad();
                this.started = true;
                if (this.resumeSlot) { await this.loadSlot(this.resumeSlot); this.resumeSlot = null; }
                else this.offerContinue();
            } catch (e) {
                this.stage.classList.remove('loading');
                if (this.stopTape) { this.stopTape(); this.stopTape = null; }
                SFX.fail();
                this.msg('R TAPE LOADING ERROR, 0:1', 0);
                toast(e.message || String(e), true);
            }
            return this;
        }
        applyVolume() {
            const v = this.muted ? 0 : this.volume / 100;
            if (this.emu && this.emu.setVolume) this.emu.setVolume(v);
            const b = this.el && $('[data-a="mute"] i', this.el); if (b) b.className = 'fas ' + (v === 0 ? 'fa-volume-xmark' : v < 0.4 ? 'fa-volume-low' : 'fa-volume-high');
        }
        msg(t, ms) { this.msgEl.textContent = t; this.msgEl.style.opacity = 1; clearTimeout(this.msgT); if (ms) this.msgT = setTimeout(() => { this.msgEl.style.opacity = 0; }, ms); }
        savePrefs(patch) { savePrefs(patch); }
        applyView() { this.screen.classList.toggle('crt', this.crt); this.screen.classList.toggle('smooth', this.smooth); this.el.style.setProperty('--zx-side', this.side.classList.contains('hide') ? '0px' : '300px'); }
        action(a) {
            const e = this.emu;
            if (a === 'close') return this.close();
            if (a === 'fs') { if (document.fullscreenElement) document.exitFullscreen(); else this.el.requestFullscreen().catch(() => toast('Fullscreen not allowed by the browser', true)); return; }
            if (a === 'help') { this.remapEl.classList.remove('on'); $('.zx-help', this.el).classList.toggle('on'); return; }
            if (a === 'controls') { $('.zx-help', this.el).classList.remove('on'); this.saveEl.classList.remove('on'); this.capturing = null; if (this.remapEl.classList.toggle('on')) this.renderRemap(); return; }
            if (a === 'saves') { $('.zx-help', this.el).classList.remove('on'); this.remapEl.classList.remove('on'); if (this.saveEl.classList.toggle('on')) { this.pauseFor('saves'); this.renderSaves(); } else this.resumeFrom('saves'); return; }
            if (a === 'continue') { this.continueLast(); return; }
            if (a === 'side') { this.side.classList.toggle('hide'); this.applyView(); return; }
            if (a === 'mute') { this.muted = !this.muted; this.applyVolume(); this.msg(this.muted ? 'SOUND OFF' : 'SOUND ON', 1200); return; }
            if (a === 'crt') { this.crt = !this.crt; this.savePrefs({ crt: this.crt }); this.applyView(); return; }
            if (a === 'smooth') { this.smooth = !this.smooth; this.savePrefs({ smooth: this.smooth }); this.applyView(); return; }
            if (!e) return;
            if (a === 'pause') { if (e.isRunning) { this.releaseAll(); e.pause(); this.msg('PAUSED — F8 TO CONTINUE', 0); } else { e.start(); this.msg('', 1); } }
            if (a === 'machine') { this.switchMachine(); return; }
            if (a === 'reset') { this.releaseAll(); e.reset(); this.msg('© 1982 Sinclair Research Ltd', 2000); }
        }
        keyEvent(ev) {
            if (!this.el) return;
            const down = ev.type === 'keydown';
            if (this.capturing) {   // remap panel waiting for a key
                ev.preventDefault(); ev.stopPropagation();
                if (down && ev.code !== 'Escape') { const cb = this.capturing; this.capturing = null; cb(ev.code); }
                else if (down) { this.capturing = null; this.renderRemap(); }
                return;
            }
            const t = ev.target || {}; const tag = t.tagName;
            const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)) || (tag === 'SELECT' && this.remapEl.classList.contains('on'));
            if (typing) return;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') t.blur();   // give the keys back to the game
            const fk = { F1: 'help', F2: 'controls', F5: 'saves', F6: 'continue', F7: 'machine', F8: 'pause', F9: 'reset', F11: 'fs' }[ev.key];
            if (fk) { ev.preventDefault(); ev.stopPropagation(); if (down && !ev.repeat) this.action(fk); return; }
            if (ev.code === 'Escape' || ev.metaKey) return;
            if (this.press(ev.code, down)) { ev.preventDefault(); ev.stopPropagation(); }
        }
        mappingRows() {
            const p = this.presetDef(); const rows = [['↑ ↓ ← →', [p.up || 'CAPS+7', p.down || 'CAPS+6', p.left, p.right].map(targetLabel).join(' · ')]];
            if (p.fire) rows.push(['Ctrl', targetLabel(p.fire)]);
            Object.entries(this.ctl.custom).forEach(([c, t]) => rows.push([codeLabel(c), targetLabel(t)]));
            return rows.map(([a, b]) => `<tr><td style="width:110px"><span class="zx-key">${esc(a)}</span></td><td>${esc(b)}</td></tr>`).join('');
        }
        renderHelp() {
            const g = this.game;
            const html = `<div class="zx-h">${esc(g.title || 'Controls')}</div>
                ${g.description ? `<p style="color:#bbb;line-height:1.6;font-size:12px">${esc(g.description)}</p>` : ''}
                <div class="zx-h">Your controls <button class="zx-btn yel" data-a="controls" style="padding:3px 8px;font-size:10px;margin-left:6px">REMAP (F2)</button></div>
                <p style="font-size:11px;color:#999;margin:0 0 6px">${esc(this.presetDef().label || '')}</p>
                <table class="zx-keys">${this.mappingRows()}</table>
                <div class="zx-h">Game keys (original instructions)</div>
                ${g.keys && g.keys.length ? `<table class="zx-keys">${g.keys.map((k) => `<tr><td style="width:110px"><span class="zx-key">${esc(k.key)}</span></td><td>${esc(k.action)}</td></tr>`).join('')}</table>` : '<p style="color:#999;font-size:12px">No key list in the original instructions. Most games use <span class="zx-key">Q</span><span class="zx-key">A</span><span class="zx-key">O</span><span class="zx-key">P</span> + <span class="zx-key">SPACE</span>/<span class="zx-key">M</span>, or a joystick. Try <span class="zx-key">1</span> <span class="zx-key">0</span> <span class="zx-key">ENTER</span> to start, then open CONTROLS to match the keys the game shows.</p>'}
                ${g.startKey ? `<p>Start: <span class="zx-key">${esc(g.startKey)}</span></p>` : ''}
                ${g.tips ? `<p style="color:#ffff00">TIP: ${esc(g.tips)}</p>` : ''}
                ${g.joystick && g.joystick.length ? `<p style="font-size:12px">Supports: ${esc(g.joystick.map((x) => (PRESETS[x] ? PRESETS[x].label : x)).join(', '))}${g.joystick.includes('kempston') ? ' — choose the Kempston option in the game menu and the Kempston preset here' : ''}</p>` : ''}
                <div class="zx-h">Emulator</div><p style="font-size:12px;line-height:1.8">
                <span class="zx-key">F1</span> keys · <span class="zx-key">F2</span> controls · <span class="zx-key">F5</span> saves · <span class="zx-key">F6</span> continue last save · <span class="zx-key">F7</span> switch 48K / 128K · <span class="zx-key">F8</span> pause · <span class="zx-key">F9</span> reset · <span class="zx-key">F11</span> fullscreen<br>
                <span class="zx-key">Shift</span> CAPS SHIFT · <span class="zx-key">Alt</span> SYMBOL SHIFT · <span class="zx-key">Backspace</span> DELETE · Gamepad: A fire · B SPACE · X ENTER · Y 1</p>`;
            $('.zx-help', this.el).innerHTML = html + '<p style="text-align:center;margin-top:14px"><button class="zx-btn yel" data-a="help">CLOSE</button></p>';
            this.side.innerHTML = html;
        }
        renderRemap() {
            const g = this.game; const r = this.remapEl;
            const opts = (sel) => TARGETS.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
            const presetOpts = Object.entries(PRESETS).filter(([k]) => k !== 'game' || this.gamePreset)
                .map(([k, v]) => `<option value="${k}" ${k === this.ctl.preset ? 'selected' : ''}>${esc(k === 'game' ? 'From the game instructions (' + [this.gamePreset.left, this.gamePreset.right, this.gamePreset.up, this.gamePreset.down].filter(Boolean).map(targetLabel).join(' ') + (this.gamePreset.fire ? ' + ' + targetLabel(this.gamePreset.fire) : '') + ')' : v.label)}</option>`).join('');
            const custom = Object.entries(this.ctl.custom);
            r.innerHTML = `<div class="zx-h">Controls — ${esc(g.title || '')}</div>
                <p style="font-size:12px;color:#bbb;line-height:1.6">Letters, numbers, ENTER and SPACE always work as on the Spectrum. Here you choose what the <b>arrow keys, Ctrl and the gamepad</b> do, and you can send any PC key to any Spectrum key or joystick direction. Saved for this game.</p>
                <div class="zx-row"><label>ARROWS + CTRL + GAMEPAD</label><select class="zx-sel" data-rp style="min-width:320px">${presetOpts}</select></div>
                <div class="zx-h">Your keys</div>
                <table class="zx-keys">
                    ${custom.length ? custom.map(([c, t]) => `<tr><td style="width:120px"><span class="zx-key">${esc(codeLabel(c))}</span></td><td>→ <select class="zx-sel" data-rt="${esc(c)}">${opts(t)}</select></td><td style="width:40px"><button class="zx-btn red" data-rdel="${esc(c)}" style="padding:4px 8px">✕</button></td></tr>`).join('') : '<tr><td style="color:#888">No custom keys yet.</td></tr>'}
                </table>
                <div class="zx-row">${this.capturing ? '<span class="zx-badge warn" style="font-size:12px;padding:8px 10px">PRESS THE PC KEY… (Esc cancels)</span>' : '<button class="zx-btn go" data-radd><i class="fas fa-plus"></i> ADD A KEY</button>'}
                    <button class="zx-btn" data-rdef>USE FOR ALL GAMES</button><button class="zx-btn red" data-rreset>RESET</button><button class="zx-btn yel" data-a="controls">DONE</button></div>
                <p style="font-size:11px;color:#888;line-height:1.6">Example: the game says "Z left, X right, ENTER jump" → choose the preset "Z X K M" or add keys: ← to Z, → to X, ↑ to ENTER (press the arrow when asked). Gamepad: A = fire, B = SPACE, X = ENTER, Y = 1.</p>`;
            const sel = $('[data-rp]', r); sel.addEventListener('change', () => { this.ctl.preset = sel.value; this.commit('PRESET: ' + PRESETS[sel.value].label.toUpperCase()); });
            $$('[data-rt]', r).forEach((s) => s.addEventListener('change', () => { this.ctl.custom[s.dataset.rt] = s.value; this.commit(); }));
            r.onclick = (ev) => {
                const del = ev.target.closest('[data-rdel]'); if (del) { delete this.ctl.custom[del.dataset.rdel]; this.commit(); return; }
                if (ev.target.closest('[data-radd]')) {
                    this.releaseAll();
                    this.capturing = (code) => { const d = baseMap()[code]; this.ctl.custom[code] = d && !String(d).includes('+') ? d : 'SPACE'; this.commit('KEY ' + codeLabel(code) + ' ADDED — CHOOSE ITS SPECTRUM KEY'); };
                    this.renderRemap(); return;
                }
                if (ev.target.closest('[data-rdef]')) { this.saveControls(true); this.msg('USED AS DEFAULT FOR ALL GAMES', 2000); return; }
                if (ev.target.closest('[data-rreset]')) { const pf = prefs(); delete pf['ctl.' + g.id]; try { localStorage.setItem('spectrom.prefs', JSON.stringify(pf)); } catch (e) { /* ignore */ } this.loadControls(); this.commit('CONTROLS RESET'); }
            };
        }
        commit(note) { this.buildMap(); this.saveControls(false); this.renderRemap(); this.renderHelp(); if (note) this.msg(note, 2200); }
        startGamepad() {
            const loop = () => {
                if (!this.el) return;
                const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
                const p = Array.from(pads).find((x) => x && x.connected);
                if (p) {
                    const ax = p.axes || [], b = p.buttons || [], pr = (i) => !!(b[i] && b[i].pressed);
                    const st = { 'Pad:left': ax[0] < -0.45 || pr(14), 'Pad:right': ax[0] > 0.45 || pr(15), 'Pad:up': ax[1] < -0.45 || pr(12), 'Pad:down': ax[1] > 0.45 || pr(13),
                        'Pad:a': pr(0) || pr(5) || pr(7), 'Pad:b': pr(1), 'Pad:x': pr(2), 'Pad:y': pr(3) };
                    for (const code in st) {
                        if (st[code] && !this.padHeld.has(code)) { this.padHeld.add(code); this.press(code, true); }
                        if (!st[code] && this.padHeld.has(code)) { this.padHeld.delete(code); this.press(code, false); }
                    }
                    if (!this.padSeen) { this.padSeen = true; this.msg('GAMEPAD CONNECTED: ' + (p.id || '').slice(0, 30).toUpperCase(), 2500); }
                }
                this.raf = requestAnimationFrame(loop);
            };
            this.raf = requestAnimationFrame(loop);
        }
        // ----- save slots: the whole Spectrum (RAM, registers, paging, AY) as a .Z80 file, kept on the server for the logged-in user
        pauseFor(why) { if (this.emu && this.emu.isRunning) { this.releaseAll(); this.emu.pause(); this.pausedBy = why; } }
        resumeFrom(why) { if (this.emu && this.pausedBy === why) { this.pausedBy = null; this.emu.start(); } }
        async listSaves() {
            if (!canSave(this.game)) return [];
            const d = await api('/saves/' + encodeURIComponent(saveKey(this.game))).catch(() => null);
            return d && d.ok ? d.saves : [];
        }
        async offerContinue() {
            if (!canSave(this.game)) return;
            const list = await this.listSaves(); if (!list.length || !this.el) return;
            const last = list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
            setTimeout(() => { if (this.el) this.msg('SAVED GAME FOUND (' + slotName(last.slot) + ', ' + when(last.date) + ') — F6 TO CONTINUE · F5 SAVES', 7000); }, 6200);
        }
        async continueLast() {
            if (!canSave(this.game)) { this.msg('© TITLE: LISTED ONLY, NOTHING TO SAVE', 3000); return; }
            const list = await this.listSaves();
            if (!list.length) { this.msg('NO SAVED GAME YET — F5 TO SAVE', 2500); return; }
            const last = list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
            await this.loadSlot(last.slot);
        }
        async renderSaves() {
            const el = this.saveEl, g = this.game;
            if (!canSave(g)) {
                el.innerHTML = `<div class="zx-h">Saved games</div><p style="color:#ffff00;line-height:1.6">Saved games are available for the games in your catalogue and for your own tapes.</p><p style="text-align:center"><button class="zx-btn yel" data-a="saves">CLOSE (F5)</button></p>`;
                return;
            }
            el.innerHTML = '<div class="zx-h">Saved games</div><p style="color:#aaa">Reading…</p>';
            const list = await this.listSaves(), by = {}; list.forEach((x) => { by[x.slot] = x; });
            el.innerHTML = `<div class="zx-h">Saved games — ${esc(g.title || '')}</div>
                <p style="font-size:12px;color:#bbb;line-height:1.6;margin:0">The whole Spectrum is saved (memory, processor, 128K banks and sound chip) as a standard <b>.Z80</b> snapshot in the <b>data/saves</b> folder of ${romImg('SPECTROM', 2, '#bbbbbb', null, 'zx-inl')}.
                AUTO is written every time you power off the game. <span class="zx-key">F6</span> continues the most recent save.</p>
                <div class="zx-saves">${SLOTS.map((sl) => { const x = by[sl]; return `<div class="zx-slot ${x ? 'has' : ''} ${sl === 'auto' ? 'auto' : ''}">
                    <div class="th" ${x && x.thumb ? `style="background-image:url('${esc(x.thumb)}')"` : ''}>${x && x.thumb ? '' : (x ? '' : 'EMPTY')}</div>
                    <div class="nm">${slotName(sl)}</div><div class="dt">${x ? esc(when(x.date)) + ' · ' + esc(x.machine || 48) + 'K' : ''}</div>
                    <div class="bt">${sl !== 'auto' ? `<button class="zx-btn go" data-sv="${sl}"><i class="fas fa-floppy-disk"></i> SAVE${x ? ' OVER' : ''}</button>` : ''}
                    ${x ? `<button class="zx-btn yel" data-ld="${sl}"><i class="fas fa-upload"></i> LOAD</button><a class="zx-btn" data-dl="${sl}" title="Download the .Z80 file"><i class="fas fa-download"></i></a><button class="zx-btn red" data-rm="${sl}" title="Delete">✕</button>` : ''}</div></div>`; }).join('')}</div>
                <p style="text-align:center;margin-top:14px"><button class="zx-btn yel" data-a="saves">BACK TO THE GAME (F5)</button></p>`;
            el.onclick = async (ev) => {
                const sv = ev.target.closest('[data-sv]'), ld = ev.target.closest('[data-ld]'), rm = ev.target.closest('[data-rm]'), dl = ev.target.closest('[data-dl]');
                if (sv) { await this.saveSlot(sv.dataset.sv); this.renderSaves(); }
                if (ld) { el.classList.remove('on'); this.pausedBy = null; await this.loadSlot(ld.dataset.ld); }
                if (rm && confirm('Delete ' + slotName(rm.dataset.rm) + '?')) { const r = await api('/saves/' + encodeURIComponent(saveKey(g)) + '/' + rm.dataset.rm, { method: 'DELETE' }); if (!r.ok) toast(r.error, true); this.renderSaves(); }
                if (dl) {
                    try { const f = await saveGet('/saves/' + encodeURIComponent(saveKey(g)) + '/' + dl.dataset.dl + '/z80');
                        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([f.buf], { type: 'application/octet-stream' }));
                        a.download = (saveKey(g) + '-' + dl.dataset.dl + '.z80'); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
                    } catch (e) { toast(e.message, true); }
                }
            };
        }
        async saveSlot(slot, quiet) {
            const g = this.game, e = this.emu;
            if (!e || !this.started) return false;
            if (!canSave(g)) { if (!quiet) this.msg('© TITLE: LISTED ONLY, NOTHING TO SAVE', 3000); return false; }
            try {
                const snap = await Promise.race([e.getSnapshot(), new Promise((_, ko) => setTimeout(() => ko(new Error('the emulator did not answer')), 3000))]);
                const z80 = Z80.encode(snap);
                const meta = { title: g.title || '', machine: snap.model, halted: !!snap.halted, tstates: snap.tstates, v: VERSION };
                const key = encodeURIComponent(saveKey(g));
                const r = await savePut('/saves/' + key + '/' + slot, z80, 'application/octet-stream', meta);
                if (!r.ok) throw new Error(r.error || 'not saved');
                const cv = $('canvas', this.screen);
                if (cv) { const jpg = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.85)); if (jpg) await savePut('/saves/' + key + '/' + slot + '/thumb', jpg, 'image/jpeg'); }
                if (!quiet) { SFX.ok(); this.msg('SAVED IN ' + slotName(slot), 2000); }
                return true;
            } catch (err) { if (!quiet) { SFX.fail(); this.msg('NOT SAVED: ' + String(err.message || err).toUpperCase().slice(0, 40), 3500); } return false; }
        }
        showMachine(m) { const b = this.el && $('[data-mach]', this.el); if (b) { b.textContent = m + 'K ⇄'; b.className = 'zx-badge zx-machsw ' + (m === 128 ? 'k128' : 'k48'); } }
        async switchMachine() {   // 48K ⇄ 128K: load the same game again on the other machine (remembered for this game)
            const g = this.game; if (!this.emu || !this.loader || this.switching) return;
            const to = this.machine === 128 ? 48 : 128; this.switching = true;
            this.msg('LOADING ON ' + to + 'K…', 0);
            try {
                const file = await this.loader();
                this.releaseAll();
                this.emu.setMachine(to);
                await this.emu.openData(file.name, file.buf); file.buf = null;
                if (!this.emu.isRunning) this.emu.start();
                this.machine = to; this.showMachine(to);
                savePrefs({ ['mach.' + (g.id || g.title)]: to });
                SFX.ok(); this.msg('NOW ON ' + to + 'K · REMEMBERED FOR THIS GAME', 3000);
            } catch (err) { SFX.fail(); this.msg('CANNOT SWITCH: ' + String(err.message || err).toUpperCase().slice(0, 40), 3500); }
            this.switching = false;
        }
        async loadSlot(slot) {
            const g = this.game, e = this.emu; if (!e) return;
            try {
                this.msg('LOADING ' + slotName(slot) + '…', 0);
                const f = await saveGet('/saves/' + encodeURIComponent(saveKey(g)) + '/' + slot + '/z80');
                const snap = Z80.decode(f.buf);
                if (f.meta && f.meta.machine == snap.model) { snap.halted = !!f.meta.halted; if (Number.isFinite(f.meta.tstates)) snap.tstates = f.meta.tstates; }
                this.releaseAll();
                await e.loadState(snap);
                const m = snap.model === 128 ? 128 : 48;
                this.machine = m; this.showMachine(m);
                if (!e.isRunning) e.start();
                SFX.ok(); this.msg(slotName(slot) + ' LOADED', 2000);
            } catch (err) { SFX.fail(); this.msg('CANNOT LOAD: ' + String(err.message || err).toUpperCase().slice(0, 40), 3500); }
        }
        async close() {
            if (this.closing) return; this.closing = true;
            if (this.emu && this.started && canSave(this.game)) { this.msg('SAVING (AUTO)…', 0); await Promise.race([this.saveSlot('auto', true), new Promise((ok) => setTimeout(ok, 4000))]); }
            this.teardown();
        }
        teardown() {
            try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
            cancelAnimationFrame(this.raf);
            window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('keyup', this.onKey, true);
            window.removeEventListener('blur', this.onBlur); document.removeEventListener('visibilitychange', this.onBlur);
            try { if (this.emu) this.emu.exit(); } catch (e) { /* ignore */ }   // terminates the worker: the game's RAM is gone
            this.emu = null;
            document.removeEventListener('fullscreenchange', this.onFs);
            document.documentElement.style.overflow = '';
            if (this.el) this.el.remove(); this.el = null;
            if (this.stopTape) this.stopTape();
        }
    }

    const GT = (s, ...a) => a.reduce((t, v, i) => t.split('{' + i + '}').join(v), s);   // texts (English in the standalone app)
    // ---------------- gallery of a game sheet (every picture ZXDB lists) + lightbox, and the favourite heart ----------------
    const GAL_CAPTION = {
        cover: 'Title screen (agent test)', shot: 'In-game (agent test)', load: 'Loading screen', run: 'In-game', open: 'Opening screen',
        inlay: 'Inlay — front', inlayb: 'Inlay — back', inlays: 'Inlay — side', media: 'Media scan', scan: 'Scanned instructions', booklet: 'Booklet',
        overlay: 'Keyboard overlay', codes: 'Code sheet', map: 'Game map', art: 'Original artwork', advert: 'Advertisement', poster: 'Poster', promo: 'Promotional material', insdoc: 'Instructions',
    };
    const GAL_GROUPS = [['Screens', ['cover', 'shot', 'load', 'run', 'open']], ['Box and media', ['inlay', 'inlayb', 'inlays', 'media']],
        ['Instructions', ['scan', 'booklet', 'overlay', 'codes', 'insdoc']], ['Maps', ['map']], ['Artwork and adverts', ['art', 'advert', 'poster', 'promo']]];
    const galKind = (name) => String(name).replace(/\d+$/, '');
    const galCaption = (name) => GT(GAL_CAPTION[galKind(name)] || name);
    const HEART = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.6 2 4.5 5.9 4.1 8.3 3.8 10.3 5 12 7c1.7-2 3.7-3.2 6.1-2.9C22 4.5 23.6 8.6 22 11.7 19.5 16.4 12 21 12 21z"/></svg>';
    const heartBtn = (id, on, big) => `<button type="button" class="zx-heart ${on ? 'on' : ''} ${big ? 'big' : ''}" data-fav="${id}" aria-pressed="${on ? 'true' : 'false'}" title="${esc(on ? GT('Remove from my favourites') : GT('Add to my favourites'))}" aria-label="${esc(on ? GT('Remove from my favourites') : GT('Add to my favourites'))}">${HEART}${big ? ' <span>' + esc(on ? GT('IN MY FAVOURITES') : GT('ADD TO FAVOURITES')) + '</span>' : ''}</button>`;
    function setHeart(btn, on) {
        btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        const t = on ? GT('Remove from my favourites') : GT('Add to my favourites'); btn.title = t; btn.setAttribute('aria-label', t);
        const s = btn.querySelector('span'); if (s) s.textContent = on ? GT('IN MY FAVOURITES') : GT('ADD TO FAVOURITES');
    }
    // the sheet's picture area: main picture (opens the lightbox), then every picture grouped, then the documents
    function galleryHtml(imgs, docs, hasText) {
        if (!imgs.length && !(docs || []).length && !hasText) return `<div class="zx-thumb none" style="aspect-ratio:4/3">${esc(GT('NO SCREEN'))}</div>`;
        const idx = new Map(imgs.map((i, n) => [i.name, n]));
        const groups = GAL_GROUPS.map(([label, kinds]) => [label, imgs.filter((i) => kinds.includes(galKind(i.name))), (docs || []).filter((d) => kinds.includes(galKind(d.name)))]);
        const other = imgs.filter((i) => !GAL_GROUPS.some(([, k]) => k.includes(galKind(i.name))));
        if (other.length) groups.push(['More', other, []]);
        return `${imgs.length ? `<button type="button" class="zx-gal-open" data-lb="0" title="${esc(GT('See it big'))}"><img class="zx-gal-main" src="${esc(imgs[0].url)}" alt="${esc(galCaption(imgs[0].name))}"><span class="zx-gal-zoom" aria-hidden="true">⤢</span></button>
            <div class="zx-gal-cap" data-cap>${esc(galCaption(imgs[0].name))} · 1/${imgs.length}</div>` : ''}
            ${groups.filter(([, li, dl]) => li.length || dl.length || false).map(([label, li, dl]) => `<div class="zx-gal-group"><div class="zx-gal-gh">${esc(GT(label))} <small>${li.length + dl.length}</small></div>
                <div class="zx-gal-strip">${li.map((i) => `<button type="button" class="zx-gal-th ${idx.get(i.name) ? '' : 'on'}" data-i="${idx.get(i.name)}" title="${esc(galCaption(i.name))}"><img loading="lazy" src="${esc(i.url)}" alt="${esc(galCaption(i.name))}"></button>`).join('')}
                ${dl.map((d) => `<a class="zx-gal-doc" href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(GT('Opens the original file on its archive'))}"><b>PDF</b><span>${esc(galCaption(d.name))}</span></a>`).join('')}</div></div>`).join('')}
            ${hasText ? `<button type="button" class="zx-btn" data-insttext style="margin-top:10px"><i class="fas fa-file-lines"></i> ${esc(GT('Read the original instructions'))}</button>` : ''}`;
    }
    // full-screen viewer: ← → to move, click or + to zoom to the real size, Esc to close
    function openLightbox(imgs, start) {
        let i = start || 0, zoom = false;
        const lb = document.createElement('div'); lb.className = 'zx-lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true');
        const draw = () => {
            const im = imgs[i];
            lb.innerHTML = `<div class="zx-lb-bar"><span>${esc(galCaption(im.name))} · ${i + 1}/${imgs.length}</span>
                <span><button type="button" data-lz title="${esc(GT('Zoom'))}">${zoom ? '⤡' : '⤢'}</button><a href="${esc(im.url)}" target="_blank" rel="noopener" title="${esc(GT('Open in a new tab'))}">↗</a><button type="button" data-lx aria-label="${esc(GT('Close'))}">✕</button></span></div>
                <div class="zx-lb-stage ${zoom ? 'zoom' : ''}" data-ls><img src="${esc(im.url)}" alt="${esc(galCaption(im.name))}"></div>
                ${imgs.length > 1 ? `<button type="button" class="zx-lb-nav prev" data-lp aria-label="${esc(GT('Previous'))}">‹</button><button type="button" class="zx-lb-nav next" data-ln aria-label="${esc(GT('Next'))}">›</button>` : ''}`;
        };
        const go = (d) => { i = (i + d + imgs.length) % imgs.length; zoom = false; draw(); };
        const close = () => { lb.remove(); document.removeEventListener('keydown', key, true); };
        const key = (ev) => {
            if (ev.key === 'Escape') { ev.stopPropagation(); close(); } else if (ev.key === 'ArrowRight') go(1); else if (ev.key === 'ArrowLeft') go(-1);
            else if (ev.key === '+' || ev.key === '-') { zoom = !zoom; draw(); }
        };
        lb.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-lx]') || ev.target === lb) return close();
            if (ev.target.closest('[data-lp]')) return go(-1);
            if (ev.target.closest('[data-ln]')) return go(1);
            if (ev.target.closest('[data-lz]') || ev.target.closest('[data-ls] img')) { zoom = !zoom; draw(); }
        });
        document.addEventListener('keydown', key, true);
        draw(); document.body.appendChild(lb);
        const b = lb.querySelector('[data-lx]'); if (b) b.focus();
    }
    function openTextViewer(title, text) {
        const lb = document.createElement('div'); lb.className = 'zx-lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true');
        lb.innerHTML = `<div class="zx-lb-bar"><span>${esc(GT('Original instructions'))} — ${esc(title)}</span><span><button type="button" data-lx aria-label="${esc(GT('Close'))}">✕</button></span></div>
            <pre class="zx-lb-text"></pre>`;
        lb.querySelector('pre').textContent = text;
        const close = () => { lb.remove(); document.removeEventListener('keydown', key, true); };
        const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
        lb.addEventListener('click', (ev) => { if (ev.target.closest('[data-lx]') || ev.target === lb) close(); });
        document.addEventListener('keydown', key, true);
        document.body.appendChild(lb);
    }
    // wires a sheet: thumbnails, lightbox, instructions text
    function wireGallery(m, imgs, gameId, title) {
        m.addEventListener('click', async (ev) => {
            const th = ev.target.closest('[data-i]');
            if (th) {
                const n = Number(th.dataset.i), im = imgs[n]; const main = $('.zx-gal-main', m);
                if (main) { main.src = im.url; main.alt = galCaption(im.name); main.closest('[data-lb]').dataset.lb = String(n); }
                const cap = $('[data-cap]', m); if (cap) cap.textContent = galCaption(im.name) + ' · ' + (n + 1) + '/' + imgs.length;
                $$('.zx-gal-th', m).forEach((x) => x.classList.toggle('on', x === th));
                return;
            }
            const lbb = ev.target.closest('[data-lb]'); if (lbb) return openLightbox(imgs, Number(lbb.dataset.lb) || 0);
            if (ev.target.closest('[data-insttext]')) {
                const d = await api('/text/' + gameId).catch(() => null);
                if (d && d.ok) openTextViewer(title, d.text); else toast(GT('The instructions could not be read'), true);
            }
        });
    }

    // ---------------- App ----------------
    class App {
        constructor(root) { this.root = root; this.tab = 'library'; this.f = { q: '', genre: '', machine: '', filter: 'all', sort: 'recent' }; this.list = []; this.total = 0; this.logSince = 0; this.status = null; }
        async boot() {
            await loadRomFont();
            this.root.innerHTML = `<div class="zx-rainbow"><i style="background:${ZX.red}"></i><i style="background:${ZX.yellow}"></i><i style="background:${ZX.green}"></i><i style="background:${ZX.cyan}"></i></div>
            <div class="zx-head"><div class="zx-logo"><div class="zx-logorow">${romImg('SPECTROM', 6, '#ffffff')}<span class="zx-ver" title="SPECTROM version">${romImg('v' + VERSION, 2, '#ffff00')}</span></div><div class="zx-sub">ZX Spectrum 48K · 128K suite · AI curated</div></div>
            <div class="zx-chips" data-chips><span class="zx-chip">Connecting…</span></div></div>
            <div class="zx-tabs">${[['library', 'LIBRARY'], ['favs', '♥ FAVOURITES'], ['agent', 'AI AGENT'], ['load', 'LOAD TAPE'], ['online', '🌐 ONLINE']].map(([k, l]) => `<button class="zx-tab ${k === this.tab ? 'on' : ''}" data-tab-x="${k}">${l}</button>`).join('')}</div>
            <div data-view></div>
            <div class="zx-footer">Emulator core: <a href="https://github.com/gasman/jsspeccy3" target="_blank" rel="noopener">JSSpeccy 3</a> by Matt Westcott (GPL-3.0, source and licence in /jsspeccy/). Game data: <a href="https://github.com/zxdb/ZXDB" target="_blank" rel="noopener">ZXDB</a>. Spectrum ROMs © Amstrad, distributed with permission for use in emulators. ${romImg('SPECTROM', 2, '#55555f', null, 'zx-inl')} only downloads and plays games whose rights holders allow distribution; titles marked © are listed only. <a href="https://github.com/Plastikelectrik/spectrom-standalone" target="_blank" rel="noopener">${romImg('SPECTROM', 2, '#77778a', null, 'zx-inl')} standalone</a> · GPL-3.0</div>`;
            this.root.addEventListener('click', (ev) => {
                if (ev.target.closest('button,.zx-card,.zx-tab,[data-sound]')) SFX.click();
                const t = ev.target.closest('[data-tab-x]'); if (t) this.show(t.dataset.tabX);
                if (ev.target.closest('[data-sound]')) { SFX.on = !SFX.on; savePrefs({ sound: SFX.on }); if (SFX.on) SFX.ok(); this.renderChips(); }
            });
            this.show(this.tab);
            this.poll();
        }
        async poll() {
            if (!document.body.contains(this.root)) return;
            const d = await api('/status').catch(() => null);
            if (d && d.ok) { this.status = d; this.renderChips(); if (this.tab === 'agent') this.renderAgentStatus(); }
            else $('[data-chips]', this.root).innerHTML = `<span class="zx-chip" style="border-color:#ff0000;color:#ff6b6b">AGENT OFFLINE</span>`;
            const busy = d && d.running && String(d.running).startsWith('hunt');
            if (this.tab === 'agent') await this.pullLog();
            if (this.wasBusy && !busy && this.tab === 'library') this.loadList(true);
            this.wasBusy = busy;
            setTimeout(() => this.poll(), busy || this.tab === 'agent' ? 2500 : 15000);
        }
        renderChips() {
            const s = this.status;
            $('[data-chips]', this.root).innerHTML = `<span class="zx-chip btn" data-sound title="Sound effects">${SFX.on ? '🔊 SOUND' : '🔇 MUTED'}</span><span class="zx-chip">Playable <b>${s.catalog.ready}</b></span><span class="zx-chip">© Listed <b>${s.catalog.listed}</b></span>
                <span class="zx-chip">ZXDB <b>${s.index && s.index.count ? s.index.count.toLocaleString() : '—'}</b></span>
                <span class="zx-chip ${s.running ? 'live' : ''}">${s.running ? '● AGENT ' + esc((s.phase || '').slice(0, 34)) + (s.total ? ' ' + s.done + '/' + s.total : '') : 'AGENT IDLE'}</span>`;
        }
        show(tab) {
            this.tab = tab;
            $$('.zx-tab', this.root).forEach((b) => b.classList.toggle('on', b.dataset.tabX === tab));
            const old = $('[data-view]', this.root); const v = old.cloneNode(false); old.replaceWith(v);   // fresh node: no stacked listeners
            if (tab === 'library') this.renderLibrary(v, false);
            else if (tab === 'favs') this.renderLibrary(v, true);
            else if (tab === 'online') this.renderOnline(v);
            else if (tab === 'agent') this.renderAgent(v);
            else this.renderLoad(v);
        }
        // ----- SPECTROM ONLINE: the multiplayer network (opt-in: nothing connects until CONNECT is pressed) -----
        async renderOnline(v) {
            v.innerHTML = '<div class="zx-empty">…</div>';
            const d = await api('/online').catch(() => null); const url = d && d.ok ? d.url : null;
            if (!url) { v.innerHTML = `<div class="zx-empty">SPECTROM ONLINE is turned off on this computer (SPECTROM_ONLINE=off).</div>`; return; }
            const host = (() => { try { return new URL(url).host; } catch (e) { return url; } })();
            const embed = url + (url.includes('?') ? '&' : '?') + 'embed=standalone';
            const on = (() => { try { return localStorage.getItem('spectrom.online') === url; } catch (e) { return false; } })();
            const head = `<div class="zx-onl"><div style="flex:1;min-width:260px;font-size:12px;line-height:1.6;color:#bbb"><b style="color:#7ff">SPECTROM ONLINE</b> · ${esc(host)} —
                play with anybody who has a Google account: friends by Gmail, chat, score challenges, relay games and live games (two screens,
                timed duel, watch me play, same Spectrum · 2 players, pass the controller).</div>
                <a class="zx-btn" href="${esc(url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> OPEN IN A NEW TAB</a>${on ? '<button class="zx-btn" data-offline>DISCONNECT</button>' : ''}</div>`;
            if (!on) {
                v.innerHTML = head + `<div class="zx-box" style="max-width:760px;line-height:1.7;font-size:13px">
                    <p style="margin-top:0">${romImg('SPECTROM', 2, '#ffffff', null, 'zx-inl')} standalone works <b>only on this computer</b>: your games, saves and favourites stay here.
                    The ONLINE tab is optional: when you press CONNECT, this tab shows the page of <b>${esc(host)}</b>, where you sign in with Google
                    and meet other players. From then on, what you do in this tab (your Google name and e-mail, friends, messages, scores and your
                    screen in live games) goes to that server, under its privacy notice.</p>
                    <p>Online, the games come from the shared collection of that server (legal games only), not from your local library.
                    If Google sign-in does not open inside the tab (some browsers block it in frames), use <b>OPEN IN A NEW TAB</b>.</p>
                    <p style="margin-bottom:0"><button class="zx-btn go" data-online style="font-size:14px;padding:12px 20px"><i class="fas fa-globe"></i> CONNECT</button></p></div>`;
            } else v.innerHTML = head + `<iframe class="zx-online" src="${esc(embed)}" title="SPECTROM ONLINE" allow="fullscreen; autoplay; gamepad" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
            this.onlViews = this.onlViews || new WeakSet();   // one listener per view (a data- attribute would be copied by show())
            if (this.onlViews.has(v)) return; this.onlViews.add(v);
            v.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-online]')) { try { localStorage.setItem('spectrom.online', url); } catch (e) { /* ignore */ } this.renderOnline(v); }
                if (ev.target.closest('[data-offline]')) { try { localStorage.removeItem('spectrom.online'); } catch (e) { /* ignore */ } this.renderOnline(v); }
            });
        }
        // ----- library -----
        renderLibrary(v, favMode) {
            this.favMode = !!favMode;
            v.innerHTML = `${favMode ? `<div class="zx-favhead">${HEART} ${esc('Your favourite games: press the heart on any card or game sheet to add or remove it.')}</div>` : ''}<div class="zx-filters">
                <input class="zx-in" data-f="q" placeholder="Search title, publisher, author…" value="${esc(this.f.q)}">
                <select class="zx-sel" data-f="genre"><option value="">All genres</option></select>
                <select class="zx-sel" data-f="machine"><option value="">48K + 128K</option><option value="48">48K</option><option value="128">128K</option></select>
                <select class="zx-sel" data-f="filter" ${favMode ? 'hidden' : ''}><option value="all">Playable + ©</option><option value="ready">Playable only</option><option value="copyright">© listed only</option><option value="failed">Failed tests</option></select>
                <select class="zx-sel" data-f="sort"><option value="recent">Recently added</option><option value="top">Most popular</option><option value="title">A–Z</option><option value="year">Year</option></select>
            </div><div class="zx-grid" data-grid></div><div class="zx-more" data-more></div>`;
            ['machine', 'filter', 'sort'].forEach((k) => { $(`[data-f="${k}"]`, v).value = this.f[k]; });
            let t = null;
            v.addEventListener('input', (ev) => { const k = ev.target.dataset.f; if (!k) return; this.f[k] = ev.target.value; clearTimeout(t); t = setTimeout(() => this.loadList(true), k === 'q' ? 300 : 0); });
            v.addEventListener('click', (ev) => {
                const h = ev.target.closest('[data-fav]');
                if (h) { ev.stopPropagation(); return this.toggleFav(Number(h.dataset.fav), !h.classList.contains('on'), h); }
                const c = ev.target.closest('[data-game]'); if (c) return this.openSheet(Number(c.dataset.game));
                if (ev.target.closest('[data-moreb]')) this.loadList(false);
                if (ev.target.closest('[data-goagent]')) this.show('agent');
            });
            this.loadList(true);
        }
        async loadList(reset) {
            const v = $('[data-view]', this.root); const grid = $('[data-grid]', v); if (!grid) return;
            if (reset) { this.list = []; }
            const p = new URLSearchParams(Object.assign({}, this.f, { offset: this.list.length, limit: 60 }, this.favMode ? { filter: 'fav' } : {}));
            const d = await api('/catalog?' + p.toString());
            if (!d.ok) { grid.innerHTML = `<div class="zx-empty">${esc(d.error || 'Cannot read the catalog')}</div>`; return; }
            this.list = this.list.concat(d.games); this.total = d.total;
            const gs = $('[data-f="genre"]', v);
            if (gs && gs.options.length <= 1) { d.genres.forEach((gn) => { const o = document.createElement('option'); o.value = gn; o.textContent = gn; gs.appendChild(o); }); gs.value = this.f.genre; }
            if (!this.list.length && this.favMode) {
                grid.innerHTML = `<div class="zx-empty" style="grid-column:1/-1">${romImg('NO FAVOURITES YET', 2, '#ff3b6b')}<br>${this.f.q || this.f.genre || this.f.machine ? 'None of your favourites matches this filter.' : 'Press the heart on any game card or sheet and it will be kept here.'}</div>`;
            } else if (!this.list.length) {
                grid.innerHTML = `<div class="zx-empty" style="grid-column:1/-1">${romImg('NO GAMES YET', 2, '#ffff00')}<br>The catalog is empty for this filter.<br><button class="zx-btn go" data-goagent><i class="fas fa-robot"></i> Send the AI agent hunting</button></div>`;
            } else grid.innerHTML = this.list.map((g) => this.card(g)).join('');
            $('[data-more]', v).innerHTML = this.list.length < this.total ? `<button class="zx-btn" data-moreb>LOAD MORE (${this.total - this.list.length})</button>` : '';
        }
        card(g) {
            const thumb = g.thumb ? `<img class="zx-thumb" loading="lazy" src="${esc(g.thumb)}" alt="">` : `<div class="zx-thumb none">NO SCREEN</div>`;
            const swap = g.thumb2 ? `<img class="zx-thumb zx-swap" loading="lazy" src="${esc(g.thumb2)}" alt="">` : '';
            const badges = [machineBadge(g), g.copyright ? '<span class="zx-badge copy">© LISTED</span>' : '', g.status === 'ready' ? '<span class="zx-badge ok">✓ TESTED</span>' : '',
                g.status === 'listed' ? '<span class="zx-badge ok">✓ TESTED</span>' : '', g.status === 'failed' ? '<span class="zx-badge warn">FAILED</span>' : '', g.status === 'listed-nocopy' ? '<span class="zx-badge warn">NO COPY</span>' : ''].join('');
            return `<div class="zx-card" data-game="${g.id}"><div class="zx-badges">${badges}</div>${heartBtn(g.id, g.fav)}${thumb}${swap}
                <div class="zx-cbody"><div class="zx-ctitle">${esc(g.title)}</div><div class="zx-cmeta">${esc([g.year, (g.publishers || [])[0]].filter(Boolean).join(' · '))}</div>
                <div class="zx-cmeta">${esc((g.genre || '').replace(/^.*?: /, ''))}${g.votes ? ' · ★ ' + Number(g.score).toFixed(1) : ''}</div></div></div>`;
        }
        async toggleFav(id, on, btn) {   // ♥: every heart of this game on the page follows
            const r = await api('/fav/' + id, { method: 'POST', body: { on } });
            if (!r.ok) return toast(r.error || 'Could not change the favourite', true);
            $$('[data-fav="' + id + '"]').forEach((b) => { setHeart(b, r.fav); b.classList.remove('pop'); void b.offsetWidth; if (r.fav) b.classList.add('pop'); });
            const g = (this.list || []).find((x) => Number(x.id) === Number(id)); if (g) g.fav = r.fav;
            if (r.fav) SFX.ok();
            if (!r.fav && this.favMode) { const c = $('[data-grid] [data-game="' + id + '"]', this.root); if (c) c.remove(); this.total = Math.max(0, (this.total || 1) - 1); if (!$('[data-grid] [data-game]', this.root)) this.loadList(true); }
        }
        // ----- game sheet -----
        async openSheet(id) {
            const d = await api('/game/' + id);
            if (!d.ok) return toast(d.error || 'Cannot open the game', true);
            const g = d.game;
            const imgs = g.images || [];
            const m = document.createElement('div'); m.className = 'zx-modal';
            const playable = g.status === 'ready' && !g.copyright;
            const facts = [['Year', g.year], ['Publisher', (g.publishers || []).join(', ')], ['Authors', (g.authors || []).join(', ')], ['Genre', g.genre], ['Machine', g.machine + (g.testedMachine ? ' · tested on ' + g.testedMachine + 'K' : '')],
                ['Players', g.players], ['Language', g.language ? g.language.toUpperCase() : ''], ['Rating', g.votes ? '★ ' + Number(g.score).toFixed(2) + ' (' + g.votes + ' votes)' : ''], ['Rights', g.availabilityText], ['Agent test', g.test ? g.test.reason : (g.failReason || '')], ['Source', g.source ? g.source.label || g.source.id : ''], ['Added', g.addedAt ? new Date(g.addedAt).toLocaleString() : '']]
                .filter((x) => x[1]).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
            const keys = (g.keys || []).length ? `<table class="zx-keys">${g.keys.map((k) => `<tr><td style="width:90px"><span class="zx-key">${esc(k.key)}</span></td><td>${esc(k.action)}</td></tr>`).join('')}</table>` : '<p style="color:#999;font-size:12px">The original instructions have no key list the agent could read. Most games use Q A O P + SPACE or a joystick (arrows + Ctrl in ' + romImg('SPECTROM', 2, '#999999', null, 'zx-inl') + ').</p>';
            m.innerHTML = `<div class="zx-sheet"><div class="zx-sheet-top">${romImg(String(g.title).toUpperCase().slice(0, 34), 2, '#000000')}<button class="x" data-x>✕</button></div>
            <div class="zx-sheet-body"><div>
                ${galleryHtml(imgs, g.docs || [], !!g.hasText)}
                <div class="zx-h">Controls</div>${keys}
                ${g.startKey ? `<p style="font-size:12px">Start key: <span class="zx-key">${esc(g.startKey)}</span></p>` : ''}
                ${(g.controlsZXDB || []).length ? `<p style="font-size:12px;color:#bbb">Joystick / options: ${esc(g.controlsZXDB.join(', '))}</p>` : ''}
            </div><div>
                <div class="zx-badges" style="position:static;margin-bottom:6px">${machineBadge(g)}${g.copyright ? '<span class="zx-badge copy">© LISTED ONLY</span>' : '<span class="zx-badge ok">FREE TO DISTRIBUTE</span>'}${g.status === 'ready' || g.status === 'listed' ? '<span class="zx-badge ok">✓ TESTED BY THE AGENT</span>' : ''}</div>
                <p class="zx-desc">${esc(g.description || '')}</p>
                ${g.tips ? `<p class="zx-desc" style="color:#ffff00">TIP: ${esc(g.tips)}</p>` : ''}
                ${g.test && g.test.warning ? `<div class="zx-copy-note" style="border-color:#d7d700;background:#1a1a00;color:#ffffaa"><b>Last re-test failed:</b> ${esc(g.test.warning)}. If it breaks into BASIC, try the other machine with the <b>48K / 128K</b> button of the player (F7), or SEARCH AGAIN from the AI AGENT tab.</div>` : ''}
                <dl class="zx-facts">${facts}</dl>
                ${g.notes ? `<div class="zx-h">Notes (ZXDB)</div><p class="zx-desc" style="font-size:12px;white-space:pre-line">${esc(g.notes)}</p>` : ''}
                ${g.copyright ? `<div class="zx-copy-note"><b>© ${esc(g.availabilityText)}.</b> Its rights holders do not allow its distribution, so ${romImg('SPECTROM', 2, '#ffb3b3', null, 'zx-inl')} only shows its sheet: it never looks for, downloads or plays this game. Look for an authorised release (re-releases, the publisher, the author) to play it.</div>` : ''}
                <div class="zx-actions">
                    ${playable ? `<button class="zx-btn go" data-play style="font-size:14px;padding:12px 20px"><i class="fas fa-play"></i> LOAD ""</button>` : ''}
                    ${heartBtn(g.id, g.fav, true)}
                    ${g.file && g.status === 'ready' ? '<button class="zx-btn" data-retest title="Test the stored copy again with the current tester (48K and 128K)"><i class="fas fa-vial"></i> RE-TEST</button>' : ''}
                    ${(g.status === 'failed' && !g.copyright) ? '<button class="zx-btn yel" data-again><i class="fas fa-rotate"></i> SEARCH AGAIN</button>' : ''}
                    <a class="zx-btn" href="${esc(g.zxdbUrl)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> ZXDB entry</a>
                    <button class="zx-btn red" data-del><i class="fas fa-trash"></i> Remove</button>
                </div></div></div></div>`;
            document.body.appendChild(m);
            const loader = () => apiBinary('/rom/' + g.id);
            if (playable && canSave(g)) {   // saved games of this title: CONTINUE button
                api('/saves/' + encodeURIComponent(saveKey(g))).then((d) => {
                    if (!d || !d.ok || !d.saves.length || !m.isConnected) return;
                    const last = d.saves.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
                    const b = document.createElement('button'); b.className = 'zx-btn'; b.style.cssText = 'border-color:#00d7d7;color:#7ff;font-size:14px;padding:12px 20px';
                    b.innerHTML = '<i class="fas fa-forward"></i> CONTINUE <small style="opacity:.8">(' + esc(slotName(last.slot)) + ' · ' + esc(when(last.date)) + ')</small>';
                    b.onclick = (ev) => { ev.stopPropagation(); close(); const p = new Player(this, g); p.resumeSlot = last.slot; p.open(loader); };
                    const play = $('[data-play]', m); if (play) play.after(b);
                }).catch(() => {});
            }
            const close = () => { m.remove(); document.removeEventListener('keydown', onEsc); };
            const onEsc = (ev) => { if (ev.key === 'Escape') close(); };
            document.addEventListener('keydown', onEsc);
            wireGallery(m, imgs, g.id, g.title);
            m.addEventListener('click', async (ev) => {
                if (ev.target === m || ev.target.closest('[data-x]')) return close();
                const hf = ev.target.closest('[data-fav]'); if (hf) return this.toggleFav(g.id, !hf.classList.contains('on'), hf);
                if (ev.target.closest('[data-play]')) {
                    close();
                    new Player(this, g).open(loader);
                }
                const rt = ev.target.closest('[data-retest]');
                if (rt) {
                    rt.disabled = true; rt.innerHTML = '<i class="fas fa-spinner fa-spin"></i> TESTING 48K / 128K…';
                    const r = await api('/game/' + g.id + '/retest', { method: 'POST', body: {} });
                    if (!r.ok) { toast(r.error, true); rt.disabled = false; rt.innerHTML = '<i class="fas fa-vial"></i> RE-TEST'; return; }
                    toast(r.passed ? 'Test OK on ' + r.machine + 'K: ' + r.reason : 'The test fails on 48K and 128K: ' + r.reason, !r.passed);
                    close(); this.openSheet(g.id); return;
                }
                if (ev.target.closest('[data-again]')) {
                    const r = await api('/hunt', { method: 'POST', body: { ids: [g.id], count: 1 } });
                    if (r.ok) { close(); toast('The agent is searching every source for "' + g.title + '"…'); this.show('agent'); } else toast(r.error, true);
                }
                if (ev.target.closest('[data-del]')) {
                    if (!confirm('Remove "' + g.title + '" from the catalog (files and sheet)?')) return;
                    const r = await api('/game/' + g.id + '/delete', { method: 'POST', body: {} });
                    if (r.ok) { close(); toast('Removed'); this.loadList(true); } else toast(r.error, true);
                }
            });
        }
        // ----- agent -----
        renderAgent(v) {
            v.innerHTML = `<div class="zx-agent">
                <div class="zx-box zx-live"><h3><i class="fas fa-tv"></i> Live test monitor — the agent team at work <button class="zx-btn" data-livesnd style="float:right;padding:4px 8px;font-size:10px">${prefs().liveSound ? '🔊 SOUND ON' : '🔈 SOUND OFF'}</button></h3>
                    <div class="zx-live-grid"><div class="zx-tv"><canvas width="256" height="192" data-tv></canvas><div class="zx-tv-label" data-tvl>${romImg('SPECTROM AGENT', 2, '#00ffff', null, 'zx-inl')}</div><div class="zx-tv-step" data-tvs>idle</div><div class="zx-stamp" data-stamp></div></div>
                    <div class="zx-team">${[['curator', 'fa-brain', 'AI CURATOR', 'Plans the hunt with the local AI'], ['scout', 'fa-satellite-dish', 'SCOUT', 'Finds the tape and its instructions'], ['tester', 'fa-microchip', 'TESTER', 'Boots it on a headless Spectrum'], ['archivist', 'fa-book-open', 'ARCHIVIST', 'Writes the game sheet']]
                        .map(([k, ic, n, d]) => `<div class="zx-role" data-role="${k}"><i class="fas ${ic} ic"></i><div><b>${n}</b><small data-rs>${d}</small></div></div>`).join('')}
                        <div style="font-size:11px;color:#777;line-height:1.6">Every test is recorded by the headless Spectrum and replayed here: tape loading, title screen, the agent pressing keys, and the verdict.</div></div></div></div>
                <div>
                <div class="zx-box"><h3><i class="fas fa-robot"></i> Agent status</h3><div data-ast>Loading…</div></div>
                <div class="zx-box" style="margin-top:14px"><h3>Send it hunting</h3>
                    <div class="zx-row"><input class="zx-in" data-req placeholder="Optional: what to look for, e.g. 'space shooters', '128K music games', 'Ultimate'"></div>
                    <div class="zx-row"><label>GAMES</label><input class="zx-in" data-count type="number" min="1" max="200" value="10" style="min-width:0;flex:0 0 80px">
                    <button class="zx-btn go" data-hunt><i class="fas fa-satellite-dish"></i> HUNT NOW</button><button class="zx-btn red" data-stop><i class="fas fa-stop"></i> STOP</button></div>
                    <p style="font-size:11px;color:#888;line-height:1.6">The agent reads ZXDB, chooses games (with your local AI when there is RAM for it), downloads the ones that may be distributed, boots each one in a headless Spectrum to prove it works, captures screenshots, reads the instructions for the keys and writes the game sheet. Only games whose rights holders allow distribution are downloaded; titles whose distribution is denied are listed with a © sheet (ZXDB data only): nothing of theirs is downloaded.</p></div>
                <div class="zx-box" style="margin-top:14px"><h3>Search all of ZXDB</h3>
                    <div class="zx-row"><input class="zx-in" data-zq placeholder="Any Spectrum title… (16,000+ games)"><button class="zx-btn" data-zs><i class="fas fa-magnifying-glass"></i></button></div>
                    <div class="zx-results" data-zr></div></div>
                <div class="zx-box" style="margin-top:14px"><h3><i class="fas fa-satellite-dish"></i> Game sources</h3><div data-srcs>Loading…</div>
                    <div class="zx-row"><button class="zx-btn" data-srccheck><i class="fas fa-stethoscope"></i> CHECK SOURCES</button><button class="zx-btn go" data-retry><i class="fas fa-rotate"></i> SEARCH MISSING AGAIN</button></div>
                    <p style="font-size:11px;color:#888;line-height:1.6">For every game the agent tries the sources in this order until one gives a file that passes the test. Games still without a copy are searched again automatically (after 12 h, 1 day, 2 days…, and at once when sources are added). A source that refuses requests is paused until the next check.</p></div>
                <div class="zx-box" style="margin-top:14px"><h3>Settings</h3><div data-aset></div></div>
            </div><div class="zx-box"><h3>Live log</h3><div class="zx-console" data-console></div></div></div>`;
            this.logSince = 0;
            v.addEventListener('click', async (ev) => {
                if (ev.target.closest('[data-hunt]')) {
                    const r = await api('/hunt', { method: 'POST', body: { count: Number($('[data-count]', v).value) || 10, request: $('[data-req]', v).value } });
                    toast(r.ok ? 'Agent started' : (r.error || 'Could not start'), !r.ok); setTimeout(() => this.refreshStatus(), 600);
                }
                if (ev.target.closest('[data-stop]')) { const r = await api('/stop', { method: 'POST', body: {} }); toast(r.ok ? 'Stopping after the current game…' : r.error, !r.ok); }
                if (ev.target.closest('[data-zs]')) this.zxdbSearch();
                const add = ev.target.closest('[data-add]');
                if (add) { const r = await api('/hunt', { method: 'POST', body: { ids: [Number(add.dataset.add)], count: 1 } }); toast(r.ok ? 'The agent is fetching and testing it…' : r.error, !r.ok); }
                if (ev.target.closest('[data-reindex]')) { if (confirm('Download ZXDB again from GitHub and rebuild the index?')) { const r = await api('/reindex', { method: 'POST', body: {} }); toast(r.ok ? 'Rebuilding the index…' : r.error, !r.ok); } }
                if (ev.target.closest('[data-srccheck]')) { const r = await api('/sources/check', { method: 'POST', body: {} }); toast(r.ok ? 'Checking every source…' : r.error, !r.ok); setTimeout(() => this.loadSources(), 4000); }
                if (ev.target.closest('[data-retry]')) { const r = await api('/retry', { method: 'POST', body: { count: 20 } }); toast(r.ok ? 'Searching the missing games again…' : r.error, !r.ok); }
                const tg = ev.target.closest('[data-srctoggle]');
                if (tg) { const r = await api('/sources', { method: 'POST', body: { id: tg.dataset.srctoggle, enabled: tg.checked } }); if (!r.ok) toast(r.error, true); this.loadSources(); }
                if (ev.target.closest('[data-livesnd]')) { const on = !prefs().liveSound; savePrefs({ liveSound: on }); ev.target.closest('[data-livesnd]').textContent = on ? '🔊 SOUND ON' : '🔈 SOUND OFF'; }
                if (ev.target.closest('[data-saveset]')) {
                    const r = await api('/settings', { method: 'POST', body: { autoHunt: $('[data-s="auto"]', v).checked, everyHours: Number($('[data-s="hours"]', v).value), batch: Number($('[data-s="batch"]', v).value), copyrightShare: Number($('[data-s="share"]', v).value) / 100, retryShare: Number($('[data-s="retry"]', v).value) / 100 } });
                    toast(r.ok ? 'Settings saved' : r.error, !r.ok);
                }
            });
            $('[data-zq]', v).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.zxdbSearch(); });
            this.refreshStatus(); this.pullLog();
            this.liveSeq = -1; this.liveQueue = []; this.idleScreen(); this.liveLoop(); this.loadSources();
        }
        idleScreen(text) {
            const c = $('[data-tv]', this.root); if (!c) return; const g = c.getContext('2d');
            g.fillStyle = '#0000d7'; g.fillRect(0, 0, 256, 192); g.fillStyle = '#d7d7d7'; g.fillRect(16, 16, 224, 160);
            romCanvasText(g, 'SPECTROM AGENT', 72, 40, '#000');
            ['#d70000', '#d7d700', '#00d700', '#00d7d7'].forEach((col, i) => { g.fillStyle = col; g.fillRect(150 + i * 10, 120, 8, 40); });
            romCanvasText(g, (text || 'WAITING FOR THE').slice(0, 26), 28, 80, '#000');
            romCanvasText(g, text ? '' : 'NEXT TAPE...', 28, 92, '#000');
            romCanvasText(g, '\u007f 1982 Sinclair', 28, 150, '#000');
        }
        async liveLoop() {
            if (this.tab !== 'agent' || !document.body.contains(this.root)) { this.liveRunning = false; return; }
            if (!this.liveRunning) { this.liveRunning = true; this.playLive(); }
            const d = await api('/live?since=' + this.liveSeq).catch(() => null);
            if (d && d.ok) {
                this.renderTeam(d);
                if (d.frames && d.seq !== this.liveSeq) {
                    if (d.frames.length) { this.liveQueue.push(d); if (this.liveQueue.length > 3) this.liveQueue.shift(); }
                    this.liveSeq = d.seq;
                }
            }
            this.liveTick = (this.liveTick || 0) + 1;
            this.pullLog();
            if (this.liveTick % 2 === 0) this.refreshStatus(false);
            if (this.liveTick % 6 === 0) this.loadSources();
            setTimeout(() => this.liveLoop(), 1000);
        }
        setText(sel, t) { const e = $(sel, this.root); if (e) e.textContent = t; }
        renderTeam(d) {
            $$('.zx-role', this.root).forEach((r) => { const on = r.dataset.role === d.role && d.running; r.classList.toggle('on', on); if (on) $('[data-rs]', r).textContent = d.step; });
            if (!this.playing) this.setText('[data-tvs]', d.running ? (d.step || '').slice(0, 60) : 'idle');
        }
        async playLive() {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            while (this.tab === 'agent' && document.body.contains(this.root)) {
                const rep = this.liveQueue.shift();
                if (!rep) { await sleep(300); continue; }
                const c = $('[data-tv]', this.root); if (!c) break; const g = c.getContext('2d');
                this.playing = true;
                const stamp = $('[data-stamp]', this.root); if (!stamp) break; stamp.className = 'zx-stamp'; stamp.textContent = '';
                this.setText('[data-tvl]', 'TESTING: ' + rep.title + ' · ' + rep.machine + 'K');
                const snd = prefs().liveSound; let stopTape = null;
                if (snd) stopTape = SFX.tape(Math.min(4, rep.frames.length * 0.12 + 0.5), 0.025);
                for (let i = 0; i < rep.frames.length; i++) {
                    if (!document.body.contains(c)) break;
                    drawScr(g, rep.frames[i]);
                    const lab = rep.labels[i] || ''; this.setText('[data-tvs]', lab === 'loading' ? 'LOADING TAPE…' : lab.startsWith('key') ? 'AGENT PRESSES ' + lab.slice(4) : lab.toUpperCase());
                    if (snd && lab.startsWith('key') && rep.labels[i - 1] !== lab) SFX.beep(1350, 0.03, 0.04);
                    if (stopTape && lab !== 'loading' && i > 2) { stopTape(); stopTape = null; }
                    await sleep(lab === 'loading' ? 90 : 160);
                }
                if (stopTape) stopTape();
                stamp.textContent = rep.verdict === 'ok' ? '✓ WORKS' : '✗ FAILED'; stamp.className = 'zx-stamp on ' + (rep.verdict === 'ok' ? 'ok' : 'fail');
                this.setText('[data-tvs]', (rep.reason || '').slice(0, 60));
                if (snd) { if (rep.verdict === 'ok') SFX.ok(); else SFX.fail(); }
                await sleep(1600);
                this.playing = false;
            }
        }
        async loadSources() {
            const box = $('[data-srcs]', this.root); if (!box) return;
            const d = await api('/sources'); if (!d.ok) { box.textContent = d.error || 'Cannot read the sources'; return; }
            const col = { ok: '#00ff00', blocked: '#ff4d4d', error: '#ffff00', off: '#666', unknown: '#9a9aa6' };
            box.innerHTML = `<table class="zx-keys">${d.sources.map((x, i) => `<tr><td style="width:22px;color:#666">${i + 1}</td>
                <td><label style="cursor:pointer"><input type="checkbox" data-srctoggle="${esc(x.id)}" ${x.enabled ? 'checked' : ''}> ${esc(x.label)}</label>
                <div style="font-size:10.5px;color:#777">${esc(x.health.detail || '')}</div></td>
                <td style="white-space:nowrap"><span class="zx-badge" style="border-color:${col[x.health.state] || '#999'};color:${col[x.health.state] || '#999'}">${esc(String(x.health.state || 'unknown').toUpperCase())}</span></td>
                <td style="white-space:nowrap;font-size:11px;color:#bbb">${x.stats.ok}/${x.stats.tries} ✓</td></tr>`).join('')}</table>
                <p style="font-size:11px;color:#bbb;margin:6px 0 0">${d.missing} game(s) still without a copy${d.mirrors && d.mirrors.length ? ' · extra mirrors: ' + esc(d.mirrors.join(', ')) : ''}</p>`;
            const rb = $('[data-retry]', this.root); if (rb) rb.innerHTML = `<i class="fas fa-rotate"></i> SEARCH MISSING AGAIN (${d.missing})`;
        }
        async refreshStatus(withSettings) { const d = await api('/status'); if (d.ok) { this.status = d; this.renderChips(); this.renderAgentStatus(withSettings !== false); } }
        renderAgentStatus(withSettings) {
            const v = $('[data-view]', this.root); const s = this.status; if (!s || !$('[data-ast]', v)) return;
            const pct = s.total ? Math.round(100 * s.done / s.total) : 0;
            $('[data-ast]', v).innerHTML = `<div class="zx-stat">
                <span>State</span><b style="color:${s.running ? '#00ff00' : '#ddd'}">${s.running ? 'RUNNING — ' + esc(s.phase) : 'IDLE'}</b>
                <span>Progress</span><span>${s.total ? s.done + ' / ' + s.total + (s.current ? ' · ' + esc(s.current) : '') : '—'}</span>
                <span>Catalog</span><span>${s.catalog.ready} playable · ${s.catalog.listed} © listed · ${s.catalog.failed} failed</span>
                <span>ZXDB index</span><span>${s.index ? (s.index.count ? s.index.count.toLocaleString() + ' games · ' : '') + esc(String(s.index.built).slice(0, 16).replace('T', ' ')) : 'not built yet (first hunt downloads it)'}</span>
                <span>Server</span><span>${s.memMB} MB RAM free · ${s.diskGB} GB disk free</span>
                <span>Last hunt</span><span>${s.settings.lastHunt ? esc(new Date(s.settings.lastHunt).toLocaleString()) : 'never'}</span></div>
                <div class="zx-prog"><i style="width:${s.running ? Math.max(4, pct) : 0}%"></i></div>`;
            if (withSettings && $('[data-aset]', v)) {
                const st = s.settings;
                $('[data-aset]', v).innerHTML = `<div class="zx-row"><label><input type="checkbox" data-s="auto" ${st.autoHunt ? 'checked' : ''}> AUTO HUNT EVERY</label>
                    <input class="zx-in" data-s="hours" type="number" min="1" max="168" value="${st.everyHours}" style="min-width:0;flex:0 0 72px"><label>HOURS ·</label>
                    <input class="zx-in" data-s="batch" type="number" min="1" max="200" value="${st.batch}" style="min-width:0;flex:0 0 72px"><label>GAMES</label></div>
                    <div class="zx-row"><label>© TITLES CATALOGUED IN EACH HUNT (SHEET ONLY)</label><input class="zx-in" data-s="share" type="number" min="0" max="100" value="${Math.round(st.copyrightShare * 100)}" style="min-width:0;flex:0 0 72px"><label>%</label></div>
                    <div class="zx-row"><label>RETRIES OF MISSING GAMES IN EACH HUNT</label><input class="zx-in" data-s="retry" type="number" min="0" max="100" value="${Math.round((st.retryShare != null ? st.retryShare : 0.3) * 100)}" style="min-width:0;flex:0 0 72px"><label>%</label></div>
                    <div class="zx-row"><button class="zx-btn yel" data-saveset>SAVE</button><button class="zx-btn" data-reindex><i class="fas fa-database"></i> REBUILD ZXDB INDEX</button></div>`;
            }
        }
        async pullLog() {
            const c = $('[data-console]', this.root); if (!c) return;
            const d = await api('/log?since=' + this.logSince); if (!d.ok) return;
            if (!d.lines.length && !this.logSince) { c.innerHTML = '<span class="ts">Ready.</span>\n'; return; }
            const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
            c.insertAdjacentHTML('beforeend', d.lines.map((l) => `<span class="ts">${esc(l.t.slice(11, 19))}</span> <span class="${l.level}">${esc(l.msg)}</span>\n`).join(''));
            if (d.lines.length) this.logSince = d.lines[d.lines.length - 1].n;
            if (atBottom) c.scrollTop = c.scrollHeight;
        }
        async zxdbSearch() {
            const v = $('[data-view]', this.root); const q = $('[data-zq]', v).value.trim(); const box = $('[data-zr]', v);
            if (q.length < 2) return;
            box.innerHTML = 'Searching…';
            const d = await api('/search?q=' + encodeURIComponent(q));
            if (!d.ok) { box.textContent = d.error; return; }
            box.innerHTML = d.games.length ? d.games.map((g) => `<div class="zx-res"><div class="n"><b>${esc(g.title)}</b> ${g.copyright ? '<span class="zx-badge copy">©</span>' : ''}<small>${esc([g.year, g.publishers.join(', '), g.genre].filter(Boolean).join(' · '))} · ${esc(g.availability)}</small></div>
                ${g.inCatalog ? `<span class="zx-badge ${g.inCatalog === 'failed' ? 'warn' : 'ok'}">${esc(g.inCatalog.toUpperCase())}</span>` : (g.playable || g.copyright ? `<button class="zx-btn go" data-add="${g.id}" style="padding:5px 9px">ADD</button>` : '<span class="zx-badge warn">NO FILE</span>')}</div>`).join('') : (d.note || 'Nothing found');
        }
        // ----- local file -----
        renderLoad(v) {
            v.innerHTML = `<div class="zx-drop" data-drop>${romImg('LOAD ""', 3, '#ffffff')}<br><br>Drop a <b>.TAP .TZX .Z80 .SNA .SZX</b> (or a .ZIP with one) here, or
                <label class="zx-btn yel" style="margin:6px"><i class="fas fa-cassette-tape"></i> CHOOSE FILE<input type="file" accept=".tap,.tzx,.z80,.sna,.szx,.zip" hidden data-file></label>
                <div class="zx-row" style="justify-content:center"><label>MACHINE</label><select class="zx-sel" data-lm><option value="48">ZX Spectrum 48K</option><option value="128">ZX Spectrum 128K</option></select></div>
                <p style="font-size:11px;color:#888">The file stays in your browser: it is not uploaded or added to the catalog.</p></div>`;
            const drop = $('[data-drop]', v);
            const go = (file) => { if (!file) return; const machine = Number($('[data-lm]', v).value); new Player(this, { id: 'local', title: file.name, joystick: [] }).open(async () => ({ buf: await file.arrayBuffer(), name: file.name, machine })); };
            $('[data-file]', v).addEventListener('change', (ev) => go(ev.target.files[0]));
            drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('over'));
            drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); go(ev.dataTransfer.files[0]); });
        }
    }

    function init() {
        const c = document.getElementById('spectrom-app');
        if (!c || inited) return;
        inited = true;
        const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
        c.innerHTML = '<div class="zx-root" id="spectrom-root"></div>';
        new App(document.getElementById('spectrom-root')).boot().catch((e) => { c.textContent = 'SPECTROM could not start: ' + e.message; });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
