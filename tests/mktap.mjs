// mktap.mjs — builds a small BASIC TAP (colour bars + moving border) used by the self-tests: node tests/mktap.mjs out.tap out-bad.tap
import fs from 'fs';
const num = (n) => { const s = String(n); return [...Buffer.from(s), 0x0e, 0, 0, n & 255, n >> 8, 0]; };
// 10 BORDER 1: PAPER 6: CLS: FOR i=0 TO 7: INK i: PRINT AT i,0;"SPECTROM TEST": NEXT i
// 20 BORDER 2: BORDER 5: PLOT 128,88: DRAW 60,40: GO TO 20
const L10 = [0xE7, ...num(1), 0x3A, 0xDA, ...num(6), 0x3A, 0xFB, 0x3A, 0xEB, 0x69, 0x3D, ...num(0), 0xCC, ...num(7), 0x3A,
  0xD9, 0x69, 0x3A, 0xF5, 0xAC, 0x69, 0x2C, ...num(0), 0x3B, 0x22, ...Buffer.from('SPECTROM TEST'), 0x22, 0x3A, 0xF3, 0x69, 0x0D];
const L20 = [0xE7, ...num(2), 0x3A, 0xE7, ...num(5), 0x3A, 0xF6, ...num(128), 0x2C, ...num(88), 0x3A, 0xFC, ...num(60), 0x2C, ...num(40), 0x3A, 0xEC, ...num(20), 0x0D];
const line = (n, b) => [n >> 8, n & 255, b.length & 255, b.length >> 8, ...b];
const prog = [...line(10, L10), ...line(20, L20)];
const blk = (flag, data) => { let x = flag; data.forEach(d => x ^= d); const b = [flag, ...data, x]; return [b.length & 255, b.length >> 8, ...b]; };
const hdr = [0, ...Buffer.from('spectrom  '), prog.length & 255, prog.length >> 8, 10, 0, prog.length & 255, prog.length >> 8];
fs.writeFileSync(process.argv[2], Buffer.from([...blk(0, hdr), ...blk(0xff, prog)]));
fs.writeFileSync(process.argv[3], Buffer.from([19, 0, 0, ...Array.from({length: 18}, (_, i) => (i * 37) & 255), 7, 0, 0xff, 1, 2, 3, 4, 5, 6]));
