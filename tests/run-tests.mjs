// npm test — SPECTROM self-tests (no network): the headless tester boots small BASIC and machine-code tapes with the same
// WebAssembly core the browser uses, and the .Z80 save codec writes and reads a snapshot back.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { testGame } from '../src/tester/spectest.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectrom-test-'));
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : '')); if (!ok) failed++; };

execFileSync(process.execPath, [path.join(ROOT, 'tests', 'mktap.mjs'), path.join(tmp, 'good.tap'), path.join(tmp, 'bad.tap')]);
const assets = path.join(ROOT, 'public', 'jsspeccy');
console.log('headless tester');
const good = await testGame({ assets, name: 'good.tap', data: fs.readFileSync(path.join(tmp, 'good.tap')), machine: 48, seconds: 40 });
check('a working tape boots and runs', good.ok, good.reason);
check('it produces a screenshot', !!(good.png && good.png.length > 100));
const bad = await testGame({ assets, name: 'bad.tap', data: fs.readFileSync(path.join(tmp, 'bad.tap')), machine: 48, seconds: 15 });
check('a broken tape is rejected', !bad.ok, bad.reason);
execFileSync(process.execPath, [path.join(ROOT, 'tests', 'mkmc.mjs'), tmp]);
const mc = (f, machine) => testGame({ assets, name: f, data: fs.readFileSync(path.join(tmp, f)), machine, seconds: 30 });
const g1 = await mc('game.tap', 48);
check('a machine-code game that starts with SPACE passes', g1.ok && g1.stats.reactsTo === 'SPACE', g1.reason);
const g2 = await mc('back.tap', 48);
check('a game that drops back to BASIC after SPACE is rejected', !g2.ok && /BASIC/.test(g2.reason), g2.reason);
const g3 = await mc('only128.tap', 48), g4 = await mc('only128.tap', 128);
check('a 128K-only game fails on 48K and passes on 128K', !g3.ok && g4.ok, g3.reason + ' / ' + g4.reason);
const g5 = await mc('hang.tap', 48);
check('a game that hangs after SPACE is rejected', !g5.ok && /hangs/.test(g5.reason), g5.reason);

console.log('save codec (.Z80 v3)');
const src = fs.readFileSync(path.join(ROOT, 'public', 'spectrom.js'), 'utf8');
const codec = src.slice(src.indexOf('const Z80 = (() => {'), src.indexOf('})();', src.indexOf('const Z80 = (() => {')) + 5);
const Z80 = new Function(codec + '\nreturn Z80;')();
const page = (seed) => Uint8Array.from({ length: 0x4000 }, (_, i) => (i % 97 < 40 ? 0 : (i * seed) & 255));
const regs = { AF: 0x1234, BC: 2, DE: 3, HL: 4, AF_: 5, BC_: 6, DE_: 7, HL_: 8, IX: 9, IY: 10, SP: 0xff00, IR: 0x3f81, PC: 0x8000, iff1: 1, iff2: 1, im: 1 };
for (const model of [48, 128]) {
    const pages = model === 48 ? { 5: page(3), 2: page(5), 0: page(7) } : Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((p) => [p, page(p + 3)]));
    const snap = { model, registers: regs, memoryPages: pages, ay: { selected: 7, regs: [...Array(14).keys()] }, tstates: 12345, ulaState: { borderColour: 3, pagingFlags: model === 48 ? 0 : 0x13 } };
    const back = Z80.decode(Z80.encode(snap).buffer);
    const same = Object.keys(pages).every((p) => Buffer.compare(Buffer.from(back.memoryPages[p]), Buffer.from(pages[p])) === 0)
        && Object.keys(regs).every((k) => back.registers[k] === regs[k]) && back.tstates === 12345 && back.ulaState.borderColour === 3 && back.model === model;
    check(model + 'K snapshot round trip (memory, registers, border, T-states)', same);
}
const wk = fs.readFileSync(path.join(ROOT, 'public', 'jsspeccy', 'jsspeccy-worker.js'), 'utf8');
check('restoring a 128K save writes the AY registers over the next frames (no core hang)', wk.includes('self.__ayq') && !wk.includes('for(let t=0;t<14;t++)o.writePort(65533,t)'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
process.exit(failed ? 1 : 0);
