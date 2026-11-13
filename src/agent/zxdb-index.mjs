// zxdb-index.mjs — builds SPECTROM's compact game index from the official ZXDB dump (github.com/zxdb/ZXDB).
// Streams ZXDB_mysql.sql out of the zip (two passes, low RAM) and keeps only ZX Spectrum 16/48/128K games.
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';

const SPECTRUM_MACHINES = new Set([1, 2, 3, 4, 5, 6, 7, 10]);   // 16K, 16/48K, 48K, 48/128K, 128K, +2, +2A/+3, +2B
const GAME_GENRE = /^(Adventure Game|Arcade Game|Casual Game|Game:|Puzzle Game|Sport Game|Strategy Game)/;
// filetypes: 8 tape image, 10 snapshot, 21 covertape version, 22 bugfix tape image, 28 instructions (text); pictures for the gallery:
// 1 loading screen, 2 running screen, 3 opening screen, 4/5/6 inlay side/front/back, 7 media scan, 29 scanned instructions, 30 keyboard overlay,
// 31 game map, 33 code sheet, 38 original artwork, 42/43 posters, 51 advertisement, 54 promotional material, 60 booklet
const FILETYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 21, 22, 28, 29, 30, 31, 33, 38, 42, 43, 51, 54, 60]);

function zipEntry(file, wanted) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 66000));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('not a zip file');
    const cdCount = tail.readUInt16LE(eocd + 10), cdOff = tail.readUInt32LE(eocd + 16), cdSize = tail.readUInt32LE(eocd + 12);
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    let p = 0;
    for (let i = 0; i < cdCount; i++) {
        const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20);
        const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
        const lho = cd.readUInt32LE(p + 42);
        const name = cd.toString('utf8', p + 46, p + 46 + nlen);
        p += 46 + nlen + xlen + clen;
        if (!wanted.test(name)) continue;
        const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, lho);
        const start = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        fs.closeSync(fd);
        return { name, method, start, end: start + csize - 1 };
    }
    fs.closeSync(fd);
    throw new Error('entry not found in zip: ' + wanted);
}

export function parseTuple(line) {
    // "\t(1, 'a\'b', NULL, 2.5)," -> [1, "a'b", null, 2.5]
    const out = []; let i = line.indexOf('(') + 1; const n = line.length;
    while (i < n) {
        const ch = line[i];
        if (ch === ' ' || ch === ',') { i++; continue; }
        if (ch === ')') break;
        if (ch === "'") {
            let s = ''; i++;
            while (i < n) {
                const c = line[i];
                if (c === '\\') { const e = line[i + 1]; s += e === 'n' ? '\n' : e === 'r' ? '' : e === 't' ? '\t' : e === '0' ? '' : e; i += 2; continue; }
                if (c === "'") { if (line[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
                s += c; i++;
            }
            out.push(s);
        } else {
            let j = i; while (j < n && line[j] !== ',' && line[j] !== ')') j++;
            const tok = line.slice(i, j).trim();
            out.push(tok === 'NULL' ? null : Number(tok));
            i = j;
        }
    }
    return out;
}

async function scan(zipFile, onRow) {
    const z = zipEntry(zipFile, /\.sql$/i);
    const src = fs.createReadStream(zipFile, { start: z.start, end: z.end });
    const stream = z.method === 8 ? src.pipe(zlib.createInflateRaw()) : src;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let table = null, cols = null;
    for await (const line of rl) {
        if (line.startsWith('INSERT INTO `')) {
            const m = /^INSERT INTO `([a-z_0-9]+)` \((.*)\) VALUES/.exec(line);
            table = m ? m[1] : null;
            cols = m ? m[2].split(',').map((c) => c.trim().replace(/`/g, '')) : null;
            continue;
        }
        if (table && line.charCodeAt(0) === 9 && line[1] === '(') {
            const want = onRow(table, null);
            if (want) {
                const v = parseTuple(line); const row = {};
                for (let k = 0; k < cols.length; k++) row[cols[k]] = v[k];
                onRow(table, row);
            }
            if (line.endsWith(';')) table = null;
        } else if (table && !line.startsWith('\t')) table = null;
    }
}

export async function buildIndex(zipFile, outFile, log = console.log) {
    const t0 = Date.now();
    const genres = new Map(), machines = new Map(), avail = new Map(), controlTags = new Map();
    const entries = new Map();
    const P1 = new Set(['genretypes', 'machinetypes', 'availabletypes', 'tags']);
    // pass 1: lookups (they come after `entries` alphabetically only partly, so keep raw entries)
    const rawEntries = [];
    await scan(zipFile, (t, r) => {
        if (!r) return P1.has(t) || t === 'entries';
        if (t === 'genretypes') genres.set(r.id, r.text);
        else if (t === 'machinetypes') machines.set(r.id, r.text);
        else if (t === 'availabletypes') avail.set(r.id, r.text);
        else if (t === 'tags' && r.tagtype_id === 'J') controlTags.set(r.id, r.name);
        else if (t === 'entries') rawEntries.push([r.id, r.title, r.is_xrated, r.machinetype_id, r.max_players, r.genretype_id, r.availabletype_id, r.language_id]);
    });
    for (const [id, title, x, mt, players, gt, av, lang] of rawEntries) {
        const g = genres.get(gt) || '';
        if (x || !GAME_GENRE.test(g)) continue;
        if (mt != null && !SPECTRUM_MACHINES.has(mt)) continue;
        if (av === '*' || av === 'N') continue;
        entries.set(id, { id, t: title, mt, m: machines.get(mt) || '', g, a: av || '?', p: players || 1, lang: lang || '', y: null, pub: [], au: [], ctl: [], sc: 0, v: 0, files: [], img: [], ins: [], notes: {} });
    }
    rawEntries.length = 0;
    log(`pass 1: ${entries.size} Spectrum games (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

    const labels = new Map(), pubRows = [], authRows = [], tagRows = [];
    const P2 = new Set(['downloads', 'releases', 'labels', 'publishers', 'authors', 'members', 'scores', 'notes']);
    await scan(zipFile, (t, r) => {
        if (!r) return P2.has(t);
        if (t === 'labels') { labels.set(r.id, r.name); return; }
        const e = entries.get(r.entry_id);
        if (!e) return;
        switch (t) {
            case 'downloads': {
                if (!FILETYPES.has(r.filetype_id) || !r.file_link) return;
                if (/^https?:/i.test(r.file_link) && ![8, 10, 21, 22, 28].includes(r.filetype_id)) return;   // remote links: only game files and instructions
                if (/^https?:/i.test(r.file_link) && [8, 10, 21, 22].includes(r.filetype_id) && !/\.(tap|tzx|z80|sna|szx|zip)(\?|$)/i.test(r.file_link)) return;   // web pages are not files
                const f = { l: r.file_link, s: r.file_size || 0, ft: r.filetype_id, m: r.machinetype_id, d: r.is_demo ? 1 : 0, r: r.release_seq };
                if ([8, 10, 21, 22].includes(r.filetype_id)) { if (!r.is_demo) e.files.push(f); }
                else if (r.filetype_id === 28) e.ins.push(r.file_link);
                else e.img.push([r.filetype_id, r.file_link, r.file_size || 0]);
                break;
            }
            case 'releases': if (r.release_seq === 0 && r.release_year) e.y = r.release_year; break;
            case 'publishers': if (r.release_seq === 0) pubRows.push([e, r.publisher_seq, r.label_id]); break;
            case 'authors': authRows.push([e, r.author_seq, r.label_id]); break;
            case 'members': if (controlTags.has(r.tag_id)) tagRows.push([e, controlTags.get(r.tag_id)]); break;
            case 'scores': if (r.votes > e.v) { e.sc = Number(r.score) || 0; e.v = r.votes; } break;
            case 'notes': if ((r.notetype_id === 'R' || r.notetype_id === 'G' || r.notetype_id === 'S') && r.text) {
                const txt = String(r.text).replace(/\{([^|}]+)\|[^}]*\}/g, '$1').replace(/<[^>]+>/g, '').slice(0, 700);
                e.notes[r.notetype_id] = e.notes[r.notetype_id] ? (e.notes[r.notetype_id] + '\n' + txt).slice(0, 1200) : txt;
            } break;
        }
    });
    pubRows.sort((a, b) => a[1] - b[1]).forEach(([e, , l]) => { const n = labels.get(l); if (n && !e.pub.includes(n)) e.pub.push(n); });
    authRows.sort((a, b) => a[1] - b[1]).forEach(([e, , l]) => { const n = labels.get(l); if (n && !e.au.includes(n) && e.au.length < 8) e.au.push(n); });
    tagRows.forEach(([e, n]) => { if (!e.ctl.includes(n)) e.ctl.push(n); });

    const games = [];
    for (const e of entries.values()) {
        if (!e.files.length && !e.img.length) continue;
        games.push(e);
    }
    const index = { version: 3, built: new Date().toISOString(), source: 'ZXDB (github.com/zxdb/ZXDB)', availability: Object.fromEntries(avail), count: games.length, games };
    fs.writeFileSync(outFile + '.tmp', JSON.stringify(index));
    fs.renameSync(outFile + '.tmp', outFile);
    const playable = games.filter((g) => g.files.length).length;
    log(`index: ${games.length} games (${playable} with tape/snapshot), ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return index;
}

if (process.argv[1] && process.argv[1].endsWith('zxdb-index.mjs') && process.argv[2]) {
    buildIndex(process.argv[2], process.argv[3] || 'zxdb-index.json').catch((e) => { console.error(e); process.exit(1); });
}
