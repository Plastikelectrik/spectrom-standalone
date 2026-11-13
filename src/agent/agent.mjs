// agent.mjs — SPECTROM standalone: the agent (127.0.0.1, JSON API used by server.js).
// Finds ZX Spectrum 48K/128K games in ZXDB, downloads ONLY the ones whose rights holders allow distribution
// (ZXDB availability "Available"), boots each one in a headless emulator to prove it works, builds a full game sheet
// (images, controls, description) and adds it to the catalog.
// Titles whose distribution is denied (or unknown) are catalogued as a sheet only: SPECTROM never looks for, downloads,
// streams or stores their game files.
// Copyright (C) 2026 Plastikelectrik — GNU GPL v3 or later (see LICENSE).
import fs from 'fs';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import { buildIndex } from './zxdb-index.mjs';
import { testGame, screenToPng, detectFormat } from '../tester/spectest.mjs';

const VERSION = '1.1.2';
const TESTER_V = 2;        // v1.5.1: the tester notices a game that drops back to the BASIC prompt
const PORT = Number(process.env.SPECTROM_PORT || 8240);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.resolve(process.env.SPECTROM_DATA || path.join(HERE, '..', '..', 'data'));
const ASSETS = path.resolve(process.env.SPECTROM_ASSETS || path.join(HERE, '..', '..', 'public', 'jsspeccy'));
const OLLAMA = process.env.SPECTROM_OLLAMA || 'http://127.0.0.1:11434';
const ZXDB_ZIP_URL = process.env.SPECTROM_ZXDB_URL || 'https://github.com/zxdb/ZXDB/raw/master/ZXDB_mysql.sql.zip';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) SPECTROM-standalone/' + VERSION + ' (+https://github.com/Plastikelectrik/spectrom-standalone)';
const IA_WOS = 'https://archive.org/download/World_of_Spectrum_June_2017_Mirror/World%20of%20Spectrum%20June%202017%20Mirror.zip/World%20of%20Spectrum%20June%202017%20Mirror/';
const IA_NVG = 'https://archive.org/download/mirror-ftp-nvg/Mirror_ftp_nvg.zip/';
const COPYRIGHT_CODES = new Set(['D', 'S', '?', 'X', 'R']);
const AVAIL_TEXT = { A: 'Available', D: 'Distribution denied', S: 'Distribution denied - still for sale', '?': 'Missing in action', X: 'Not archived (available elsewhere)', R: 'Never released - recovered' };
const LLM_MODELS = ['llama3.2:3b', 'qwen2.5:1.5b', 'gemma2:2b', 'llama3.2:1b'];

function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---------- storage ----------
fs.mkdirSync(path.join(DATA, 'games'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'zxdb'), { recursive: true });
const F = { catalog: path.join(DATA, 'catalog.json'), settings: path.join(DATA, 'settings.json'), index: path.join(DATA, 'zxdb', 'zxdb-index.json'), zip: path.join(DATA, 'zxdb', 'ZXDB_mysql.sql.zip'), log: path.join(DATA, 'agent.log') };
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJSON(f, o) { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); }
let catalog = readJSON(F.catalog, { games: {} });
let settings = Object.assign({ autoHunt: false, everyHours: 6, batch: 10, copyrightShare: 0.2, retryShare: 0.3, sources: {}, lastHunt: null }, readJSON(F.settings, {}));
delete settings.privateMode;
const saveCatalog = () => writeJSON(F.catalog, catalog);
const saveSettings = () => writeJSON(F.settings, settings);
let index = null;           // loaded lazily (≈10 MB)
let indexById = null;

// ---------- live monitor (what the agent team is doing right now) ----------
const live = { seq: 0, role: 'idle', step: 'Waiting for the next hunt', title: '', machine: null, verdict: null, reason: '', frames: [], labels: [], at: null };
function team(role, step) { live.role = role; live.step = step; }
function recorder(title, machine) {
    const frames = [], labels = [];
    return {
        onFrame(scr, label) {
            frames.push(Buffer.from(scr).toString('base64')); labels.push(label);
            if (frames.length > 48) { for (let i = frames.length - 2; i > 0; i -= 2) { frames.splice(i, 1); labels.splice(i, 1); } }
        },
        publish(res) {
            live.seq++; live.title = title; live.machine = res ? res.machine : machine; live.verdict = res ? (res.ok ? 'ok' : 'fail') : null;
            live.reason = res ? res.reason : ''; live.frames = frames.slice(); live.labels = labels.slice(); live.at = now();
        },
    };
}

// ---------- log ----------
const LOG = []; let logSeq = 0;
function log(msg, level = 'info') {
    const line = { n: ++logSeq, t: now(), level, msg: String(msg) };
    LOG.push(line); if (LOG.length > 600) LOG.shift();
    console.log(`[${line.t}] ${level.toUpperCase()} ${line.msg}`);
    try { fs.appendFileSync(F.log, `${line.t} ${level} ${line.msg}\n`); } catch (e) { /* ignore */ }
}

// ---------- system ----------
function memAvailableMB() {
    try {
        const m = fs.readFileSync('/proc/meminfo', 'utf8');
        const g = (k) => Number((new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(m) || [0, 0])[1]) / 1024;
        return Math.round(g('MemAvailable') + g('SwapFree') * 0.5);
    } catch (e) { return 0; }
}
function diskFreeGB() { try { const s = fs.statfsSync(DATA); return +(s.bavail * s.bsize / 1e9).toFixed(1); } catch (e) { return 99; } }

// ---------- network ----------
async function download(url, maxBytes, timeoutMs = 60000) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const len = Number(r.headers.get('content-length') || 0);
    if (maxBytes && len > maxBytes) throw new Error('too big (' + len + ' bytes)');
    const buf = Buffer.from(await r.arrayBuffer());
    if (maxBytes && buf.length > maxBytes) throw new Error('too big');
    return buf;
}
const TEST_MIRROR = process.env.SPECTROM_TEST_MIRROR || '';   // local tests only: every source is served from <mirror>/src/<id>/...
const IA = TEST_MIRROR || 'https://archive.org';

// ---------- game sources (tried in order until one gives a valid file) ----------
const SOURCES_VERSION = 2;   // bump when sources are added: games without a copy are searched again
function waybackUrl(l) {
    if (l.startsWith('/zxdb/')) return 'https://web.archive.org/web/2025id_/https://spectrumcomputing.co.uk' + enc(l);
    if (l.startsWith('/pub/')) return 'https://web.archive.org/web/2015id_/http://www.worldofspectrum.org' + enc(l);
    return null;
}
const SOURCE_DEFS = [
    { id: 'ia-wos', label: 'Internet Archive · World of Spectrum mirror', pre: ['/pub/'], url: (l) => IA_WOS + enc(l.slice(5)), sample: '/pub/sinclair/games/m/ManicMiner.tzx.zip' },
    { id: 'ia-nvg', label: 'Internet Archive · nvg mirror', pre: ['/nvg/'], url: (l) => IA_NVG + enc(l.slice(5)) },
    { id: 'spectrumcomputing', label: 'Spectrum Computing', pre: ['/zxdb/'], url: (l) => 'https://spectrumcomputing.co.uk' + enc(l), sample: '/zxdb/sinclair/entries/0003012/ManicMiner(ULAplus).tap.zip' },
    { id: 'zxinfo', label: 'ZXInfo media server', pre: ['/zxdb/', '/pub/'], url: (l) => 'https://zxinfo.dk/media' + enc(l), sample: '/zxdb/sinclair/entries/0003012/ManicMiner(ULAplus).tap.zip' },
    { id: 'wos', label: 'World of Spectrum Classic', pre: ['/pub/'], url: (l) => 'https://worldofspectrum.net' + enc(l), sample: '/pub/sinclair/games/m/ManicMiner.tzx.zip' },
    { id: 'ia-mirrors', label: 'Internet Archive · other ZXDB mirrors (auto-discovered)', pre: ['/zxdb/', '/pub/'], url: (l) => mirrorIndexUrl(l) },
    { id: 'wayback', label: 'Wayback Machine (archived copies)', pre: ['/zxdb/', '/pub/'], url: waybackUrl, sample: '/zxdb/sinclair/entries/0003012/ManicMiner(ULAplus).tap.zip' },
    { id: 'remote', label: 'Author and publisher sites (links in ZXDB)', pre: ['http'], url: (l) => l },
    { id: 'ia-search', label: 'Internet Archive software search (by title)', search: true },
];
const srcHealth = {};   // id -> { state: 'ok' | 'blocked' | 'error' | 'unknown', detail, at }
function srcStats(id) { settings.sourceStats = settings.sourceStats || {}; return (settings.sourceStats[id] = settings.sourceStats[id] || { tries: 0, ok: 0 }); }
const srcEnabled = (id) => settings.sources[id] !== false;
const srcUsable = (d) => srcEnabled(d.id) && !(srcHealth[d.id] && srcHealth[d.id].state === 'blocked');
function sourceUrl(d, link) {
    if (TEST_MIRROR) return d.pre.some((x) => link.startsWith(x)) ? TEST_MIRROR + '/src/' + d.id + (link.startsWith('http') ? '/' + encodeURIComponent(link) : link) : null;
    return d.url(link);
}
function linkSources(link) {
    if (link.startsWith('/denied/')) return [];   // files of titles whose distribution is denied: never fetched
    return SOURCE_DEFS.filter((d) => !d.search && d.pre.some((x) => link.startsWith(x)) && srcUsable(d));
}
const hasSource = (link) => linkSources(link).length > 0;
const lastHit = {};   // per-host politeness
async function politeGet(url, maxBytes, timeoutMs) {
    const host = (/^https?:\/\/([^/]+)/.exec(url) || [0, 'x'])[1];
    const wait = 1200 - (Date.now() - (lastHit[host] || 0)); if (wait > 0) await sleep(wait);
    lastHit[host] = Date.now();
    return download(url, maxBytes, timeoutMs);
}
const looksLikeFile = (buf) => buf.length > 16 && !/^\s*<(!doctype|html|\?xml)/i.test(buf.subarray(0, 64).toString('latin1'));
// fetch a ZXDB link from the first source that has it; returns { buf, source, url }
async function fetchFromSources(link, maxBytes, opts = {}) {
    const errors = [];
    for (const d of linkSources(link)) {
        const url = sourceUrl(d, link); if (!url) continue;
        const st = srcStats(d.id); st.tries++;
        try {
            const buf = await politeGet(url, maxBytes, opts.timeout || 60000);
            if (!looksLikeFile(buf)) throw new Error('got a web page, not a file');
            st.ok++;
            if (!opts.quiet) log(`    ✓ ${path.basename(link)} via ${d.label}`);
            return { buf, source: d.id, url };
        } catch (e) {
            errors.push(d.id + ': ' + e.message);
            if (/HTTP (403|429)/.test(e.message)) { st.blocks = (st.blocks || 0) + 1; if (st.blocks >= 3) { srcHealth[d.id] = { state: 'blocked', detail: e.message, at: now() }; log(`  source ${d.label} is refusing requests (${e.message}): paused until the next check`, 'warn'); } }
        }
    }
    const err = new Error(errors.length ? 'not found in ' + errors.length + ' source(s) — ' + errors.join(' | ').slice(0, 300) : 'no enabled source for this link');
    err.tried = errors.length; throw err;
}

// Internet Archive: discover other ZXDB / World of Spectrum mirrors and index their file names
const MIRROR_FILE = path.join(DATA, 'zxdb', 'ia-mirrors.json');
let mirrorIndex = null;
function mirrorIndexUrl(link) {
    if (!mirrorIndex) { try { mirrorIndex = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')); } catch (e) { mirrorIndex = { files: {} }; } }
    const hit = mirrorIndex.files[path.basename(link).toLowerCase()];
    return hit ? 'https://archive.org/download/' + hit : null;
}
async function discoverMirrors() {
    if (!srcEnabled('ia-mirrors')) return;
    if (fs.existsSync(MIRROR_FILE) && Date.now() - fs.statSync(MIRROR_FILE).mtimeMs < 7 * 86400e3) return;
    log('Discovering ZXDB / World of Spectrum mirrors on the Internet Archive…');
    const q = '(title:(zxdb) OR title:("world of spectrum") OR title:("spectrum computing") OR subject:(zxdb)) AND NOT identifier:World_of_Spectrum_June_2017_Mirror';
    const files = {}; const items = [];
    try {
        const d = JSON.parse((await politeGet(IA + '/advancedsearch.php?q=' + encodeURIComponent(q) + '&fl[]=identifier&fl[]=title&rows=25&output=json', 3e6, 30000)).toString('utf8'));
        for (const doc of ((d.response && d.response.docs) || []).slice(0, 12)) {
            try {
                const meta = JSON.parse((await politeGet(IA + '/metadata/' + doc.identifier, 60e6, 90000)).toString('utf8'));
                let n = 0;
                for (const f of meta.files || []) {
                    if (!/\.(tap|tzx|z80|sna|szx)(\.zip)?$/i.test(f.name) || !/sinclair|zxdb|spectrum/i.test(f.name + ' ' + doc.identifier)) continue;
                    const k = path.basename(f.name).toLowerCase();
                    if (!files[k]) { files[k] = doc.identifier + '/' + enc(f.name); n++; }
                }
                if (n) { items.push(doc.identifier + ' (' + n + ' files)'); log(`  mirror found: ${doc.identifier} — ${n} game files`); }
            } catch (e) { /* skip this item */ }
        }
    } catch (e) { log('  mirror discovery failed: ' + e.message, 'warn'); return; }
    mirrorIndex = { built: now(), items, files };
    writeJSON(MIRROR_FILE, mirrorIndex);
    log(`Mirror discovery: ${Object.keys(files).length} extra game files in ${items.length} Internet Archive items`);
}

// health check of every source with a known file (runs at start, every 6 h and on demand)
async function checkSources() {
    for (const d of SOURCE_DEFS) {
        if (!srcEnabled(d.id)) { srcHealth[d.id] = { state: 'off', at: now() }; continue; }
        try {
            if (d.search) { const j = JSON.parse((await politeGet(IA + '/advancedsearch.php?q=' + encodeURIComponent('collection:softwarelibrary_zx_spectrum') + '&fl[]=identifier&rows=1&output=json', 1e6, 30000)).toString('utf8')); srcHealth[d.id] = j.response ? { state: 'ok', detail: 'search answers', at: now() } : { state: 'error', detail: 'unexpected answer', at: now() }; continue; }
            if (d.id === 'ia-mirrors') { mirrorIndex = null; mirrorIndexUrl('/x'); const n = Object.keys(mirrorIndex.files).length; srcHealth[d.id] = { state: n ? 'ok' : 'unknown', detail: n ? n + ' files indexed' : 'no mirror indexed yet', at: now() }; continue; }
            if (!d.sample) { srcHealth[d.id] = { state: 'unknown', detail: 'checked on use', at: now() }; continue; }
            const url = sourceUrl(d, d.sample);
            const buf = await politeGet(url, 3e6, 30000);
            srcHealth[d.id] = looksLikeFile(buf) ? { state: 'ok', detail: 'sample file downloaded', at: now() } : { state: 'error', detail: 'answers with a web page', at: now() };
        } catch (e) { srcHealth[d.id] = { state: /HTTP (403|429)/.test(e.message) ? 'blocked' : 'error', detail: e.message, at: now() }; }
        const st = srcStats(d.id); st.blocks = 0;
    }
    saveSettings();
    log('Sources: ' + SOURCE_DEFS.map((d) => d.id + '=' + (srcHealth[d.id] || {}).state).join(' · '));
}

// ---------- zip (in memory) ----------
export function unzipFiles(buf) {
    const out = [];
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return out;
    const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
        const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
        const name = buf.toString('latin1', p + 46, p + 46 + nlen);
        p += 46 + nlen + xlen + clen;
        if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const raw = buf.subarray(start, start + csize);
        try { out.push({ name: path.basename(name), data: method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null }); } catch (e) { /* skip */ }
    }
    return out.filter((f) => f.data);
}
function gameFileFrom(buf, linkName) {
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    const files = isZip ? unzipFiles(buf) : [{ name: path.basename(linkName), data: buf }];
    const order = ['tap', 'tzx', 'z80', 'sna', 'szx'];
    const usable = files.map((f) => ({ ...f, fmt: detectFormat(f.name, f.data) })).filter((f) => f.fmt);
    usable.sort((a, b) => order.indexOf(a.fmt) - order.indexOf(b.fmt));
    return usable[0] || null;
}

// ---------- ZXDB index ----------
const INDEX_VERSION = 3;   // v3: every picture and document type of ZXDB (gallery)
async function ensureIndex(force) {
    const fresh = fs.existsSync(F.index) && (Date.now() - fs.statSync(F.index).mtimeMs) < 7 * 86400e3;
    if (!force && fresh) { if (!index) loadIndex(); if (index && index.version === INDEX_VERSION) return; log('ZXDB index is from an older SPECTROM version: rebuilding it'); }
    if (fs.existsSync(F.zip) && Date.now() - fs.statSync(F.zip).mtimeMs < 7 * 86400e3 && !force) {
        setPhase('Indexing ZXDB'); await buildIndex(F.zip, F.index, (m) => log(m)); loadIndex(); return;
    }
    setPhase('Downloading ZXDB from GitHub');
    log('Downloading ZXDB dump from GitHub…');
    const buf = await download(ZXDB_ZIP_URL, 200e6, 300000);
    fs.writeFileSync(F.zip + '.tmp', buf); fs.renameSync(F.zip + '.tmp', F.zip);
    log(`ZXDB dump: ${(buf.length / 1e6).toFixed(1)} MB`);
    setPhase('Indexing ZXDB');
    await buildIndex(F.zip, F.index, (m) => log(m));
    loadIndex();
}
function loadIndex() {
    index = readJSON(F.index, null);
    indexById = new Map(); if (index) for (const g of index.games) indexById.set(g.id, g);
    if (index) log(`ZXDB index loaded: ${index.count} games (built ${index.built})`);
}

// ---------- local AI (Ollama), only when there is RAM for it ----------
async function pickModel() {
    try {
        const ps = await (await fetch(OLLAMA + '/api/ps', { signal: AbortSignal.timeout(4000) })).json();
        const loaded = (ps.models || []).map((m) => m.name);
        const hit = LLM_MODELS.find((m) => loaded.includes(m));
        if (hit) return { model: hit, own: false };
        const tags = await (await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(4000) })).json();
        const have = (tags.models || []).map((m) => m.name);
        const want = process.env.SPECTROM_MODEL || 'qwen2.5:1.5b';
        if (have.includes(want) && memAvailableMB() > 1800) return { model: want, own: true };
    } catch (e) { /* no ollama */ }
    return null;
}
async function llmJSON(prompt, ai) {
    if (!ai) return null;
    try {
        const r = await fetch(OLLAMA + '/api/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
            body: JSON.stringify({ model: ai.model, prompt, format: 'json', stream: false, keep_alive: ai.own ? '2m' : undefined, options: { temperature: 0.3, num_ctx: 3072, num_predict: 400 } }),
        });
        const d = await r.json();
        return JSON.parse(d.response);
    } catch (e) { log('AI call failed: ' + e.message, 'warn'); return null; }
}
async function unloadOwnModel(ai) {
    if (!ai || !ai.own) return;
    try { await fetch(OLLAMA + '/api/generate', { method: 'POST', body: JSON.stringify({ model: ai.model, keep_alive: 0 }) }); } catch (e) { /* ignore */ }
}

// ---------- controls ----------
const KEYWORDS = /(up|down|left|right|fire|jump|pause|quit|abort|select|start|thrust|rotate|shoot|kick|punch|menu|music|sound|walk|drop|pick|use|action|inventory|bomb|crouch|duck|speed|brake|accelerate)/i;
export function regexControls(text) {
    const keys = []; const seen = new Set();
    const KEY = '(SYMBOL SHIFT|SYM SHIFT|CAPS SHIFT|SPACE|ENTER|BREAK|[A-Z0-9])';
    const re1 = new RegExp('(?:^|\\s|\\()' + KEY + '\\s*(?:-|=|:|\\.{2,}|–)\\s*([A-Za-z][A-Za-z /]{1,24})', 'g');
    const re2 = new RegExp('([A-Za-z][A-Za-z /]{1,20})\\s*(?:-|=|:|\\.{2,}|–)\\s*' + KEY + '(?=[\\s,.;)]|$)', 'g');
    for (const line of String(text).split(/\r?\n/).slice(0, 400)) {
        let m;
        while ((m = re1.exec(line))) { const a = m[2].trim(); if (KEYWORDS.test(a) && !seen.has(m[1] + a)) { seen.add(m[1] + a); keys.push({ key: m[1].toUpperCase(), action: a.replace(/\s+/g, ' ') }); } }
        while ((m = re2.exec(line))) { const a = m[1].trim(); if (KEYWORDS.test(a) && a.length < 22 && !seen.has(m[2] + a)) { seen.add(m[2] + a); keys.push({ key: m[2].toUpperCase(), action: a.replace(/\s+/g, ' ') }); } }
    }
    return keys.slice(0, 14);
}
function joystickModes(ctl) {
    const out = [];
    for (const c of ctl || []) {
        if (/kempston/i.test(c)) out.push('kempston');
        else if (/cursor/i.test(c)) out.push('cursor');
        else if (/interface 2 \(left\)/i.test(c)) out.push('sinclair2');
        else if (/interface 2/i.test(c)) out.push('sinclair1');
        else if (/redefin/i.test(c)) out.push('redefine');
    }
    return [...new Set(out)];
}

// ---------- game sheet ----------
function fallbackDescription(g) {
    const who = g.pub.length ? ' published by ' + g.pub[0] : '';
    const by = g.au.length ? ', created by ' + g.au.slice(0, 3).join(', ') : '';
    const kind = (g.g.split(':')[1] || g.g).trim().toLowerCase();
    return `${g.t} is a ${kind} game for the ${g.m || 'ZX Spectrum'}${g.y ? ' from ' + g.y : ''}${who}${by}.` + (g.p > 1 ? ` Up to ${g.p} players.` : '');
}
async function buildSheet(g, ai, instructionsText) {
    const notes = [g.notes.S, g.notes.R].filter(Boolean).join('\n').slice(0, 900);
    let keys = instructionsText ? regexControls(instructionsText) : [];
    let description = '', startKey = '', tips = '';
    if (ai) {
        const excerpt = (instructionsText || '').replace(/\s+\n/g, '\n').slice(0, 2600);
        const res = await llmJSON(`You write entries for a retro ZX Spectrum game catalog. Use only the facts given; never invent.
Game: ${g.t} (${g.y || 'year unknown'}), ${g.g}, machine ${g.m || 'ZX Spectrum'}, publisher ${g.pub.join(', ') || 'unknown'}, authors ${g.au.join(', ') || 'unknown'}.
ZXDB notes: ${notes || 'none'}
Original instructions (may be partial or OCR text): """${excerpt || 'not available'}"""
Return JSON: {"description": "2-3 sentence English description of the game and its goal", "keys": [{"key": "Spectrum key, e.g. Q, SPACE, ENTER, SYMBOL SHIFT", "action": "short action"}], "start_key": "key that starts the game or empty", "tips": "one short gameplay tip or empty"}.
Only list keys that appear in the instructions.`, ai);
        if (res) {
            if (typeof res.description === 'string' && res.description.length > 30) description = res.description.slice(0, 600);
            if (Array.isArray(res.keys) && instructionsText) {
                const ok = res.keys.filter((k) => k && k.key && k.action && String(k.key).length <= 14).map((k) => ({ key: String(k.key).toUpperCase().slice(0, 14), action: String(k.action).slice(0, 40) }));
                // keep AI keys only if they really appear in the instructions text
                const txt = instructionsText.toUpperCase();
                const real = ok.filter((k) => k.key.length > 1 || new RegExp('(^|[^A-Z0-9])' + k.key.replace(/[^A-Z0-9]/g, '') + '([^A-Z0-9]|$)').test(txt));
                if (real.length >= keys.length) keys = real.slice(0, 14);
            }
            if (typeof res.start_key === 'string') startKey = res.start_key.slice(0, 14);
            if (typeof res.tips === 'string') tips = res.tips.slice(0, 200);
        }
    }
    return { description: description || fallbackDescription(g), keys, startKey, tips, notes: notes || '', aiModel: ai ? ai.model : null };
}

// ---------- images ----------
function imgKind(link) { const e = link.split('.').pop().toLowerCase(); return e === 'scr' ? 'scr' : ['gif', 'png', 'jpg', 'jpeg'].includes(e) ? e.replace('jpeg', 'jpg') : null; }
// ---------- gallery: every picture ZXDB lists for a game (screens, inlays, media scans, scanned instructions, maps,
// artwork, adverts, posters…), fetched from every source that mirrors it. PDFs become links to their public page.
// Only for titles whose distribution is allowed: the caller never calls this for any other title.
const GALLERY_V = 2;
const GALLERY = [   // [ZXDB filetype, picture name prefix, how many at most]
    [1, 'load', 1], [2, 'run', 4], [3, 'open', 1], [5, 'inlay', 2], [6, 'inlayb', 2], [4, 'inlays', 1], [7, 'media', 4], [29, 'scan', 8], [60, 'booklet', 6],
    [31, 'map', 8], [38, 'art', 4], [51, 'advert', 4], [42, 'poster', 2], [43, 'poster', 2], [54, 'promo', 4], [30, 'overlay', 2], [33, 'codes', 2]];
const IMG_MAX = 4e6, GAME_IMG_MAX = 30e6;
function publicUrl(link) {
    if (link.startsWith('/zxdb/')) return 'https://spectrumcomputing.co.uk' + enc(link);
    if (link.startsWith('/pub/')) return 'https://worldofspectrum.net' + enc(link);
    return null;
}
async function fetchImages(g, dir, have) {
    have = have || new Set();
    const images = [], docs = [], used = {};
    let total = 0;
    for (const [ft, pre, max] of GALLERY) {
        let n = 0;
        const reissue = (l) => (/Rereleases|\(/.test(l) ? 1 : 0);   // the original release first
        for (const x of (g.img || []).filter((y) => y[0] === ft).sort((a, b) => reissue(a[1]) - reissue(b[1]))) {
            if (n >= max) break;
            n++;
            const link = x[1], size = x[2] || 0;
            used[pre] = (used[pre] || 0) + 1;
            const name = pre === 'load' || pre === 'open' || (pre === 'inlay' && used[pre] === 1) ? pre : pre + used[pre];
            const kind = imgKind(link);
            if (!kind) { if (/\.pdf$/i.test(link) && publicUrl(link)) docs.push({ type: ft, name, url: publicUrl(link), size }); continue; }
            if (have.has(name) || !hasSource(link) || size > IMG_MAX || total + size > GAME_IMG_MAX) continue;
            try {
                let buf = (await fetchFromSources(link, IMG_MAX, { quiet: true })).buf;
                let ext = kind;
                if (kind === 'scr') { if (buf.length < 6912) continue; buf = screenToPng(buf.subarray(0, 6912), 1); ext = 'png'; }
                total += buf.length;
                fs.writeFileSync(path.join(dir, name + '.' + ext), buf);
                images.push({ name, ext, type: ft });
            } catch (e) { log(`  image ${name}: ${e.message.slice(0, 120)}`, 'warn'); }
        }
    }
    let k = 0;
    for (const l of (g.ins || [])) if (/\.pdf$/i.test(l) && publicUrl(l)) docs.push({ type: 28, name: 'insdoc' + (++k), url: publicUrl(l) });
    return { images, docs };
}

// ---------- Internet Archive search by title ----------
async function iaSearch(title, broad) {
    if (!srcEnabled('ia-search')) return null;
    const t = title.replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = broad ? 'title:(' + t + ') AND mediatype:(software) AND (subject:(spectrum) OR subject:(sinclair) OR description:("zx spectrum"))'
        : 'collection:softwarelibrary_zx_spectrum AND title:(' + t + ')';
    const st = srcStats('ia-search'); st.tries++;
    const d = JSON.parse((await politeGet(IA + '/advancedsearch.php?q=' + encodeURIComponent(q) + '&fl[]=identifier&fl[]=title&rows=10&output=json', 2e6, 30000)).toString('utf8'));
    const norm = (s) => String(s).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
    const docs = (d.response && d.response.docs) || [];
    const want = norm(title);
    const best = docs.find((x) => norm(x.title) === want) || docs.find((x) => norm(x.title).startsWith(want) && norm(x.title).length - want.length < 12);
    if (!best) return null;
    const meta = JSON.parse((await politeGet(IA + '/metadata/' + best.identifier, 8e6, 30000)).toString('utf8'));
    const names = (meta.files || []).map((x) => x.name);
    const f = names.find((n) => /\.(tap|tzx|z80|sna|szx)$/i.test(n)) || names.find((n) => /\.(tap|tzx|z80|sna|szx)\.zip$/i.test(n)) || names.find((n) => /\.zip$/i.test(n));
    if (!f) return null;
    st.ok++;
    return { identifier: best.identifier, file: f, url: IA + '/download/' + best.identifier + '/' + enc(f), source: 'ia-search' };
}

function cleanupDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

// ---------- one game ----------
function chooseFiles(g) {
    const prefer = g.mt === 5 ? 128 : 48;
    const score = (f) => {
        const n = f.l.toLowerCase(); let s = 0;
        if (/\.tap(\.zip)?$/.test(n)) s += 30; else if (/\.tzx(\.zip)?$/.test(n)) s += 25; else if (/\.z80(\.zip)?$/.test(n)) s += 20; else s += 10;
        if (f.r === 0) s += 15; if (!/\(/.test(path.basename(n))) s += 10;
        if (/^\/pub\//.test(f.l)) s += 8;
        if ((f.m === 5 && prefer === 128) || ((f.m === 3 || f.m === 2 || f.m === 4) && prefer === 48)) s += 5;
        if (/\/denied\//.test(f.l)) s -= 100;
        if (f.ft === 21 || f.ft === 22) s -= 6;   // covertape / bugfix tapes: alternatives
        return s;
    };
    return g.files.filter((f) => hasSource(f.l)).sort((a, b) => score(b) - score(a)).slice(0, 5);
}
async function testCandidate(name, data, mt, title) {
    // 48K/128K titles (mt 4) are tried on 128K first: the 128K version loads everything at once (48K ones are often multiload)
    const order = mt === 4 || mt === 5 || mt === 6 || mt === 7 || mt === 10 ? [128, 48] : [48, 128];
    let last = null;
    for (const machine of order) {
        team('tester', `Booting ${title || name} on a headless ${machine}K Spectrum`);
        const rec = recorder(title || name, machine);
        last = await testGame({ assets: ASSETS, name, data, machine, seconds: 50, onFrame: rec.onFrame });
        rec.publish(last);
        if (last.ok) return last;
    }
    return last;
}
async function processGame(g, ai, by) {
    const isCopy = COPYRIGHT_CODES.has(g.a);   // distribution denied / unknown: sheet only, the game file is never fetched
    const dir = path.join(DATA, 'games', String(g.id));
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
        id: g.id, title: g.t, year: g.y, genre: g.g, machine: g.m, machineType: g.mt, players: g.p, language: g.lang,
        publishers: g.pub, authors: g.au, controlsZXDB: g.ctl, joystick: joystickModes(g.ctl), score: g.sc, votes: g.v,
        availability: g.a, availabilityText: AVAIL_TEXT[g.a] || g.a, copyright: isCopy, status: 'working', addedAt: now(), addedBy: by || 'agent',
        zxdbUrl: 'https://spectrumcomputing.co.uk/entry/' + g.id, attempts: ((catalog.games[g.id] || {}).attempts || 0) + 1, lastTry: now(), srcv: SOURCES_VERSION,
    };
    log(`${isCopy ? '©' : '▶'} ${g.t} (${g.y || '?'}, ${g.m || '?'}) — ${rec.availabilityText}`);
    team('scout', isCopy ? `Listing ${g.t} (${g.y || '?'}): rights holders deny distribution` : `Fetching ${g.t} (${g.y || '?'}) and its instructions`);
    // instructions text (only used to extract keys/summary, not stored)
    let instructions = '';
    // titles whose rights holders deny distribution: nothing at all is downloaded (no game, no instructions, no images)
    const insLink = isCopy ? null : g.ins.find((l) => /\.txt$/i.test(l) && hasSource(l));
    if (insLink) { try { instructions = (await fetchFromSources(insLink, 300e3, { quiet: true })).buf.toString('latin1'); } catch (e) { log('  instructions: ' + e.message.slice(0, 120), 'warn'); } }

    let test = null, file = null;
    if (!isCopy) {
        const files = chooseFiles(g);
        if (!files.length) log('  ZXDB has no file reachable through the enabled sources', 'warn');
        let usedSource = null;
        for (const f of files) {
            try {
                team('scout', `Looking for ${path.basename(f.l)} in ${linkSources(f.l).length} source(s)`);
                const got = await fetchFromSources(f.l, 4e6);
                const buf = got.buf;
                const gf = gameFileFrom(buf, f.l);
                if (!gf) { log('  no tape/snapshot inside ' + path.basename(f.l), 'warn'); continue; }
                const t = await testCandidate(gf.name, gf.data, g.mt, g.t);
                log(`  test ${gf.name} on ${t.machine}K: ${t.ok ? 'OK' : 'FAIL'} — ${t.reason}`);
                if (t.ok) { test = t; file = gf; usedSource = { id: got.source, url: got.url }; break; }
                test = t;
            } catch (e) { log(`  ${path.basename(f.l)}: ${e.message.slice(0, 200)}`, 'warn'); }
        }
        if (!file && srcEnabled('ia-search')) {   // last resort: search the Internet Archive by title
            team('scout', `Searching the Internet Archive for "${g.t}"`);
            for (const broad of [false, true]) {
                try {
                    const hit = await iaSearch(g.t, broad); if (!hit) continue;
                    const gf = gameFileFrom(await politeGet(hit.url, 4e6, 60000), hit.file); if (!gf) continue;
                    const t = await testCandidate(gf.name, gf.data, g.mt, g.t);
                    log(`  Internet Archive "${hit.identifier}": ${t.ok ? 'OK' : 'FAIL'} — ${t.reason}`);
                    if (t.ok) { test = t; file = gf; usedSource = { id: 'ia-search', url: hit.url }; break; }
                } catch (e) { log('  Internet Archive search: ' + e.message.slice(0, 120), 'warn'); }
            }
        }
        if (usedSource) rec.source = Object.assign(usedSource, { label: (SOURCE_DEFS.find((d) => d.id === usedSource.id) || {}).label });
        if (file) {
            const ext = file.fmt;
            fs.writeFileSync(path.join(dir, 'game.' + ext), file.data);
            Object.assign(rec, { file: { ext, name: file.name, size: file.data.length }, testedMachine: test.machine, testerv: TESTER_V, test: { reason: test.reason, loadSeconds: test.loadSeconds, reactsTo: test.stats.reactsTo || null } });
        }
    }
    if (test && test.ok) {
        fs.writeFileSync(path.join(dir, 'cover.png'), test.png);
        if (test.png2) fs.writeFileSync(path.join(dir, 'shot.png'), test.png2);
    }
    team('archivist', `Writing the game sheet for ${g.t}: images, keys, description`);
    rec.images = [];
    if (test && test.ok) { rec.images.push({ name: 'cover', ext: 'png' }); if (test.png2) rec.images.push({ name: 'shot', ext: 'png' }); }
    if (!isCopy) {
        const gal = await fetchImages(g, dir, new Set(rec.images.map((i) => i.name)));
        rec.images.push(...gal.images); rec.docs = gal.docs; rec.gallery = GALLERY_V;
        if (instructions && instructions.trim().length > 20) { fs.writeFileSync(path.join(dir, 'instructions.txt'), instructions.slice(0, 60000)); rec.hasText = true; }
    }
    else log('  sheet only: ZXDB data, no downloads');
    Object.assign(rec, await buildSheet(g, ai, instructions));
    if (!rec.startKey && rec.test && rec.test.reactsTo) rec.startKey = rec.test.reactsTo;
    if (isCopy) rec.status = 'listed';
    else rec.status = file ? 'ready' : 'failed';
    if (rec.status === 'failed') { rec.failReason = test ? test.reason : 'no downloadable file (download failed)'; cleanupDir(dir); rec.images = []; }
    catalog.games[g.id] = rec;
    saveCatalog();
    return rec;
}

// ---------- planner + hunt job ----------
const job = { running: null, phase: 'idle', done: 0, total: 0, stop: false, current: '' };
function setPhase(p) { job.phase = p; }
// ---------- re-test a stored game with the current tester (no download): v1.5.1 repair + RE-TEST button ----------
async function retestGame(r, why) {
    if (!r || !r.file) return null;
    const f = path.join(DATA, 'games', String(r.id), 'game.' + r.file.ext);
    if (!fs.existsSync(f)) return null;
    const t = await testCandidate(r.file.name || ('game.' + r.file.ext), fs.readFileSync(f), r.machineType, r.title);
    const was = r.testedMachine;
    r.testerv = TESTER_V; r.retestedAt = now();
    if (t && t.ok) {
        r.testedMachine = t.machine;
        r.test = { reason: t.reason, loadSeconds: t.loadSeconds, reactsTo: t.stats.reactsTo || null };
        if (!r.startKey && t.stats.reactsTo) r.startKey = t.stats.reactsTo;
        const dir = path.join(DATA, 'games', String(r.id));
        if (t.png) fs.writeFileSync(path.join(dir, 'cover.png'), t.png);
        if (t.png2) { fs.writeFileSync(path.join(dir, 'shot.png'), t.png2); if (!(r.images || []).some((i) => i.name === 'shot')) { r.images = r.images || []; const at = r.images.findIndex((i) => i.name === 'cover'); r.images.splice(at + 1, 0, { name: 'shot', ext: 'png' }); } }
        log(`${r.title}: re-tested (${why}) — OK on ${t.machine}K${was && was !== t.machine ? ` (was ${was}K: it now starts on ${t.machine}K)` : ''} — ${t.reason}`);
    } else {
        r.test = Object.assign({}, r.test || {}, { warning: t ? t.reason : 'cannot test' });
        log(`${r.title}: re-tested (${why}) — FAILS on every machine: ${t ? t.reason : '?'} (kept in the catalog, try SEARCH AGAIN or another copy)`, 'warn');
    }
    saveCatalog();
    return t;
}
const needsRetest = (r) => r.file && (r.status === 'ready') && (r.testerv || 1) < TESTER_V;
function retestTick() {   // one stored game every 15 s while the agent is idle, until all are checked with the new tester
    if (job.running || galleryBusy) return;
    const r = Object.values(catalog.games).find(needsRetest);
    if (!r) return;
    job.running = 'retest'; setPhase('Re-testing ' + r.title);
    retestGame(r, 'tester v' + TESTER_V).catch((e) => { r.testerv = TESTER_V; log(`${r.title}: re-test failed: ${e.message}`, 'warn'); saveCatalog(); })
        .finally(() => { job.running = null; setPhase('idle'); team('idle', 'Waiting for the next hunt'); });
}
function catalogStats() {
    const s = { ready: 0, listed: 0, failed: 0, genres: {} };
    for (const r of Object.values(catalog.games)) {
        if (r.status === 'ready') s.ready++; else if (String(r.status).startsWith('listed')) s.listed++; else if (r.status === 'failed') s.failed++;
        if (r.status === 'ready' || String(r.status).startsWith('listed')) s.genres[r.genre] = (s.genres[r.genre] || 0) + 1;
    }
    return s;
}
async function plan(ai, request) {
    const stats = catalogStats();
    const allGenres = [...new Set(index.games.map((g) => g.g))].sort();
    let p = null;
    if (ai) {
        p = await llmJSON(`You are the curator agent of a ZX Spectrum games catalog. Choose what to look for next so the catalog grows varied and full of great games.
Catalog now: ${stats.ready} playable games. Games per genre: ${JSON.stringify(stats.genres)}.
${request ? 'The user asked for: "' + request + '". Follow it.' : ''}
Available genres: ${JSON.stringify(allGenres)}.
Return JSON: {"genres": ["1 to 4 exact genre names from the list"], "year_from": 1982, "year_to": 1993, "keywords": ["optional title words"], "reason": "one sentence"}`, ai);
    }
    if (!p || !Array.isArray(p.genres)) {
        // heuristic: least represented game genres among the big ones
        const counts = {}; index.games.forEach((g) => { counts[g.g] = (counts[g.g] || 0) + 1; });
        const big = Object.keys(counts).filter((k) => counts[k] > 150);
        big.sort((a, b) => (stats.genres[a] || 0) / counts[a] - (stats.genres[b] || 0) / counts[b]);
        p = { genres: big.slice(0, 3), year_from: 1982, year_to: 2030, keywords: request ? request.split(/\s+/).filter((w) => w.length > 2) : [], reason: 'least covered genres (no AI available)' };
    }
    p.genres = (p.genres || []).filter((x) => allGenres.includes(x)).slice(0, 4);
    p.keywords = (Array.isArray(p.keywords) ? p.keywords : []).map(String).filter((w) => w.length > 2).slice(0, 5);
    return p;
}
// games still without a copy are searched again with growing pauses (12 h, 1 d, 2 d, 4 d…) and at once when new sources arrive
function isMissing(r) {
    if (!r) return false;
    if (r.status === 'listed-nocopy' || r.status === 'listed-untested') return true;
    if (r.status !== 'failed') return false;
    return /download|no downloadable|not reachable|not found|no enabled source|no tape/i.test(r.failReason || '') || (r.srcv || 1) < SOURCES_VERSION;
}
function retryDue(r) {
    if ((r.srcv || 1) < SOURCES_VERSION) return true;
    if ((r.attempts || 1) >= 8) return false;
    const last = Date.parse(r.lastTry || r.addedAt || 0) || 0;
    return Date.now() - last > 12 * 3600e3 * Math.pow(2, Math.min(5, (r.attempts || 1) - 1));
}
function missingCount() { return Object.values(catalog.games).filter(isMissing).length; }
function pickRetries(count, force) {
    return Object.values(catalog.games).filter((r) => isMissing(r) && (force || retryDue(r))).sort((a, b) => (b.votes || 0) - (a.votes || 0))
        .map((r) => indexById.get(Number(r.id))).filter(Boolean).slice(0, count);
}
function pickCandidates(p, count, copyrightShare) {
    const inCat = (g) => !!catalog.games[g.id];
    const kw = (p.keywords || []).map((k) => k.toLowerCase());
    const match = (g) => (!p.genres.length || p.genres.includes(g.g)) && (!g.y || ((g.y >= (p.year_from || 0)) && g.y <= (p.year_to || 9999)));
    const kwMatch = (g) => kw.length && kw.some((k) => g.t.toLowerCase().includes(k));
    const rank = (a, b) => (b.v - a.v) || (b.sc - a.sc) || (a.id - b.id);
    const pool = index.games.filter((g) => !inCat(g) && (match(g) || kwMatch(g)));
    const free = pool.filter((g) => g.a === 'A' && g.files.length).sort(rank);
    const copy = pool.filter((g) => COPYRIGHT_CODES.has(g.a) && g.v > 0).sort(rank);
    const nCopy = Math.min(copy.length, Math.round(count * copyrightShare));
    const pickedKw = kw.length ? pool.filter(kwMatch).sort(rank).slice(0, count) : [];
    const out = [...pickedKw];
    for (const g of free) { if (out.length >= count - nCopy) break; if (!out.includes(g)) out.push(g); }
    for (const g of copy) { if (out.length >= count) break; if (!out.includes(g)) out.push(g); }
    return out.slice(0, count);
}
async function runHunt(opts = {}) {
    if (job.running) throw new Error('a hunt is already running');
    if (diskFreeGB() < 3) throw new Error('less than 3 GB free on disk, hunt refused');
    job.running = 'hunt-' + Date.now(); job.stop = false; job.done = 0; job.total = 0; job.current = '';
    let ai = null;
    try {
        await ensureIndex(false);
        if (!index) throw new Error('ZXDB index not available');
        setPhase('Planning');
        team('curator', 'Reading the catalog and choosing what to look for');
        ai = await pickModel();
        log(ai ? `AI curator: ${ai.model}${ai.own ? ' (loaded for this run)' : ' (already in memory)'}` : `AI curator: off (only ${memAvailableMB()} MB free) — heuristic planner`);
        let list;
        if (opts.ids && opts.ids.length) list = opts.ids.map((id) => indexById.get(Number(id))).filter(Boolean);
        else {
            const p = opts.retry ? { genres: [], keywords: [], reason: 'retry run' } : await plan(ai, opts.request);
            if (!opts.retry) log(`Plan: ${p.genres.join(' · ') || 'any genre'}${p.keywords.length ? ' · words: ' + p.keywords.join(', ') : ''} — ${p.reason || ''}`);
            const total = Math.max(1, Math.min(200, opts.count || settings.batch));
            const retries = pickRetries(opts.retry ? total : Math.round(total * settings.retryShare), !!opts.retry);
            if (retries.length) log(`Searching again ${retries.length} game(s) that had no copy${opts.retry ? '' : ' (new sources / retry time reached)'}`);
            else if (opts.retry) log('No game is missing a copy right now');
            list = [...retries, ...pickCandidates(p, total - retries.length, settings.copyrightShare)];
        }
        job.total = list.length;
        log(`Hunting ${list.length} games…`);
        let ok = 0;
        for (const g of list) {
            if (job.stop) { log('Stopped by the user'); break; }
            if (diskFreeGB() < 3) { log('Disk almost full, stopping', 'warn'); break; }
            job.current = g.t; setPhase('Testing ' + g.t);
            try { const r = await processGame(g, ai, opts.by); if (r.status === 'ready' || r.status === 'listed') ok++; } catch (e) { log(`${g.t}: ${e.message}`, 'error'); }
            job.done++;
        }
        settings.lastHunt = now(); saveSettings();
        log(`Hunt finished: ${ok}/${job.done} added. Catalog: ${catalogStats().ready} playable.`);
    } catch (e) { log('Hunt failed: ' + e.message, 'error'); }
    finally { await unloadOwnModel(ai); job.running = null; job.current = ''; setPhase('idle'); team('idle', 'Waiting for the next hunt'); }
}

// scheduler
setInterval(() => {
    if (!settings.autoHunt || job.running) return;
    const last = settings.lastHunt ? Date.parse(settings.lastHunt) : 0;
    if (Date.now() - last > settings.everyHours * 3600e3) runHunt({ by: 'scheduler' });
}, 60e3).unref();

// ---------- HTTP API ----------
const FAVF = path.join(DATA, 'favorites.json');
const favs = readJSON(FAVF, {});
const light = (r) => ({ id: r.id, title: r.title, year: r.year, genre: r.genre, machine: r.machine, testedMachine: r.testedMachine || null, publishers: (r.publishers || []).slice(0, 2), status: r.status, copyright: r.copyright, score: r.score, votes: r.votes, hasCover: (r.images || []).some((i) => i.name === 'cover' || i.name === 'load'), images: (r.images || []).map((i) => i.name), players: r.players, fav: !!favs[r.id] });
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { ok({}); } }); });
const CT = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg' };

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
    try {
        if (req.method === 'GET' && u.pathname === '/status') {
            const st = catalogStats();
            return send(res, 200, { ok: true, version: VERSION, running: job.running, phase: job.phase, done: job.done, total: job.total, current: job.current,
                index: index ? { built: index.built, count: index.count } : (fs.existsSync(F.index) ? { built: 'on disk', count: null } : null),
                catalog: { ready: st.ready, listed: st.listed, failed: st.failed, missing: missingCount() }, settings, team: { role: live.role, step: live.step, seq: live.seq }, memMB: memAvailableMB(), diskGB: diskFreeGB() });
        }
        if (req.method === 'GET' && u.pathname === '/sources') {
            return send(res, 200, { ok: true, version: SOURCES_VERSION, missing: missingCount(), mirrors: mirrorIndex ? (mirrorIndex.items || []) : [],
                sources: SOURCE_DEFS.map((d) => ({ id: d.id, label: d.label, enabled: srcEnabled(d.id), health: srcHealth[d.id] || { state: 'unknown' }, stats: srcStats(d.id) })) });
        }
        if (req.method === 'GET' && u.pathname === '/live') {
            const since = Number(u.searchParams.get('since') || -1);
            const out = { ok: true, seq: live.seq, role: live.role, step: live.step, running: job.running, current: job.current, done: job.done, total: job.total };
            if (since !== live.seq) Object.assign(out, { title: live.title, machine: live.machine, verdict: live.verdict, reason: live.reason, frames: live.frames, labels: live.labels, at: live.at });
            return send(res, 200, out);
        }
        if (req.method === 'GET' && u.pathname === '/log') { const since = Number(u.searchParams.get('since') || 0); return send(res, 200, { ok: true, lines: LOG.filter((l) => l.n > since) }); }
        if (req.method === 'GET' && u.pathname === '/catalog') {
            const q = (u.searchParams.get('q') || '').toLowerCase(), filter = u.searchParams.get('filter') || 'all', genre = u.searchParams.get('genre') || '', mach = u.searchParams.get('machine') || '';
            let list = Object.values(catalog.games).filter((r) => r.status !== 'working');
            if (filter === 'ready') list = list.filter((r) => r.status === 'ready');
            else if (filter === 'fav') list = list.filter((r) => favs[r.id]);
            else if (filter === 'copyright') list = list.filter((r) => r.copyright);
            else if (filter === 'failed') list = list.filter((r) => r.status === 'failed');
            else list = list.filter((r) => r.status !== 'failed');
            if (q) list = list.filter((r) => (r.title + ' ' + (r.publishers || []).join(' ') + ' ' + (r.authors || []).join(' ')).toLowerCase().includes(q));
            if (genre) list = list.filter((r) => r.genre && r.genre.startsWith(genre));
            if (mach === '128') list = list.filter((r) => r.testedMachine === 128 || r.machineType === 5);
            if (mach === '48') list = list.filter((r) => r.testedMachine === 48 || [1, 2, 3].includes(r.machineType));
            const sort = u.searchParams.get('sort') || 'recent';
            list.sort(sort === 'title' ? (a, b) => a.title.localeCompare(b.title) : sort === 'year' ? (a, b) => (a.year || 9999) - (b.year || 9999) : sort === 'top' ? (a, b) => (b.votes || 0) - (a.votes || 0) : (a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
            const genres = [...new Set(Object.values(catalog.games).filter((r) => r.status !== 'failed').map((r) => (r.genre || '').split(':')[0]).filter(Boolean))].sort();
            const off = Number(u.searchParams.get('offset') || 0), lim = Math.min(200, Number(u.searchParams.get('limit') || 60));
            return send(res, 200, { ok: true, total: list.length, genres, games: list.slice(off, off + lim).map(light) });
        }
        if (req.method === 'GET' && u.pathname === '/search') {   // search the whole ZXDB index
            if (!index) { if (fs.existsSync(F.index)) loadIndex(); else return send(res, 200, { ok: true, games: [], note: 'ZXDB index not built yet: start a hunt' }); }
            const q = (u.searchParams.get('q') || '').toLowerCase().trim();
            if (q.length < 2) return send(res, 200, { ok: true, games: [] });
            const hits = index.games.filter((g) => g.t.toLowerCase().includes(q)).sort((a, b) => b.v - a.v).slice(0, 30)
                .map((g) => ({ id: g.id, title: g.t, year: g.y, genre: g.g, machine: g.m, publishers: g.pub.slice(0, 2), copyright: COPYRIGHT_CODES.has(g.a), availability: AVAIL_TEXT[g.a] || g.a, playable: g.files.length > 0, inCatalog: catalog.games[g.id] ? catalog.games[g.id].status : null }));
            return send(res, 200, { ok: true, games: hits });
        }
        if (p[0] === 'game' && p[1] && req.method === 'GET' && p.length === 2) {
            const r = catalog.games[p[1]]; if (!r) return send(res, 404, { ok: false, error: 'not found' });
            return send(res, 200, { ok: true, game: Object.assign({}, r, { fav: !!favs[r.id] }) });
        }
        if (p[0] === 'file' && p[1] && req.method === 'GET') {
            const r = catalog.games[p[1]];
            if (!r || r.status !== 'ready' || !r.file) return send(res, 404, { ok: false, error: 'not in the catalog' });
            const f = path.join(DATA, 'games', String(r.id), 'game.' + r.file.ext);
            const buf = fs.readFileSync(f);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Spectrom-Name': 'game.' + r.file.ext, 'X-Spectrom-Machine': String(r.testedMachine || 48) });
            return res.end(buf);
        }
        if (p[0] === 'text' && p[1] && req.method === 'GET') {   // original instructions (text) of a playable game
            const r = catalog.games[p[1]];
            if (!r || r.status !== 'ready' || r.copyright || !r.hasText) return send(res, 404, { ok: false, error: 'no instructions' });
            let t = ''; try { t = fs.readFileSync(path.join(DATA, 'games', String(r.id), 'instructions.txt'), 'utf8'); } catch (e) { return send(res, 404, { ok: false, error: 'no instructions' }); }
            return send(res, 200, { ok: true, title: r.title, text: t });
        }
        if (p[0] === 'img' && p[1] && p[2] && req.method === 'GET') {
            const r = catalog.games[p[1]]; const im = r && (r.images || []).find((i) => i.name === p[2]);
            if (!im) return send(res, 404, { ok: false, error: 'no image' });
            const buf = fs.readFileSync(path.join(DATA, 'games', String(r.id), im.name + '.' + im.ext));
            res.writeHead(200, { 'Content-Type': CT[im.ext] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
            return res.end(buf);
        }
        if (p[0] === 'game' && p[1] && p[2] === 'retest' && req.method === 'POST') {   // RE-TEST: the stored copy, with the current tester
                const b = await body(req);
                const r = catalog.games[p[1]]; if (!r || !r.file) return send(res, 404, { ok: false, error: 'no stored copy to test' });
                if (job.running) return send(res, 409, { ok: false, error: 'the agent is busy, try when it ends' });
                job.running = 'retest'; setPhase('Re-testing ' + r.title);
                const t = await retestGame(r, 'asked by ' + (b.by || 'a user')).finally(() => { job.running = null; setPhase('idle'); team('idle', 'Waiting for the next hunt'); });
                return send(res, 200, { ok: true, passed: !!(t && t.ok), machine: r.testedMachine || null, reason: t ? t.reason : 'cannot test' });
            }
        if (p[0] === 'fav' && p[1] && req.method === 'POST') {   // ♥ favourites
            const b = await body(req); const id = String(Number(p[1]));
            if (!catalog.games[id]) return send(res, 404, { ok: false, error: 'not in the library' });
            if (b.on === false) delete favs[id]; else favs[id] = now();
            writeJSON(FAVF, favs);
            return send(res, 200, { ok: true, fav: !!favs[id], count: Object.keys(favs).length });
        }
        if (req.method === 'POST') {
            const b = await body(req);
            if (u.pathname === '/hunt') {
                if (job.running) return send(res, 409, { ok: false, error: 'a hunt is already running' });
                if (diskFreeGB() < 3) return send(res, 409, { ok: false, error: 'less than 3 GB free on disk' });
                runHunt({ count: Number(b.count) || settings.batch, request: b.request ? String(b.request).slice(0, 200) : '', ids: Array.isArray(b.ids) ? b.ids.slice(0, 100) : null, by: b.by });
                return send(res, 202, { ok: true, started: true });
            }
            if (u.pathname === '/retry') {
                if (job.running) return send(res, 409, { ok: false, error: 'a hunt is already running' });
                runHunt({ retry: true, count: Math.max(1, Math.min(200, Number(b.count) || 20)), by: b.by });
                return send(res, 202, { ok: true, started: true });
            }
            if (u.pathname === '/sources') {
                const d = SOURCE_DEFS.find((x) => x.id === b.id); if (!d) return send(res, 404, { ok: false, error: 'unknown source' });
                settings.sources[d.id] = !!b.enabled; if (b.enabled && srcHealth[d.id] && srcHealth[d.id].state !== 'ok') srcHealth[d.id] = { state: 'unknown', at: now() };
                saveSettings(); log(`Source ${d.label}: ${b.enabled ? 'enabled' : 'disabled'}`);
                return send(res, 200, { ok: true });
            }
            if (u.pathname === '/sources/check') {
                if (job.running) return send(res, 409, { ok: false, error: 'busy, try when the hunt ends' });
                job.running = 'sources'; setPhase('Checking sources'); team('scout', 'Checking every game source');
                checkSources().then(() => discoverMirrors()).catch((e) => log('Source check failed: ' + e.message, 'error')).finally(() => { job.running = null; setPhase('idle'); team('idle', 'Waiting for the next hunt'); });
                return send(res, 202, { ok: true });
            }
            if (u.pathname === '/stop') { job.stop = true; return send(res, 200, { ok: true }); }
            if (u.pathname === '/settings') {
                if ('autoHunt' in b) settings.autoHunt = !!b.autoHunt;
                if (b.everyHours) settings.everyHours = Math.max(1, Math.min(168, Number(b.everyHours)));
                if (b.batch) settings.batch = Math.max(1, Math.min(200, Number(b.batch)));
                if ('copyrightShare' in b) settings.copyrightShare = Math.max(0, Math.min(1, Number(b.copyrightShare)));
                if ('retryShare' in b) settings.retryShare = Math.max(0, Math.min(1, Number(b.retryShare)));
                saveSettings(); return send(res, 200, { ok: true, settings });
            }
            if (u.pathname === '/index/rebuild') {
                if (job.running) return send(res, 409, { ok: false, error: 'busy' });
                job.running = 'index'; ensureIndex(true).catch((e) => log('Index failed: ' + e.message, 'error')).finally(() => { job.running = null; setPhase('idle'); });
                return send(res, 202, { ok: true });
            }
            if (p[0] === 'game' && p[1] && p[2] === 'delete') {
                if (favs[p[1]]) { delete favs[p[1]]; writeJSON(FAVF, favs); }
                const r = catalog.games[p[1]]; if (!r) return send(res, 404, { ok: false, error: 'not found' });
                fs.rmSync(path.join(DATA, 'games', String(r.id)), { recursive: true, force: true });
                delete catalog.games[p[1]]; saveCatalog(); log(`Removed ${r.title} from the catalog`);
                return send(res, 200, { ok: true });
            }
        }
        send(res, 404, { ok: false, error: 'unknown endpoint' });
    } catch (e) {
        log(`${req.method} ${u.pathname}: ${e.message}`, 'error');
        if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    }
});

// ---------- gallery backfill: games added before the gallery get their extra pictures, one game every 20 s while the agent rests ----------
let galleryBusy = false, galleryIndexAsked = false;
async function galleryTick() {
    if (galleryBusy || job.running) return;
    if (index && index.version !== INDEX_VERSION) {   // the old index has no gallery data: rebuild it once (from the dump on disk when it is recent)
        if (galleryIndexAsked) return;
        galleryIndexAsked = true; galleryBusy = true;
        job.running = 'index';
        try { await ensureIndex(); } catch (e) { log('Gallery: ZXDB index rebuild failed: ' + e.message, 'warn'); } finally { galleryBusy = false; job.running = null; setPhase('idle'); }
        return;
    }
    if (!indexById || diskFreeGB() < 3) return;
    const r = Object.values(catalog.games).find((x) => x.status === 'ready' && !x.copyright && (x.gallery || 0) < GALLERY_V);
    if (!r) return;
    const g = indexById.get(Number(r.id));
    if (!g || g.a !== 'A') { r.gallery = GALLERY_V; saveCatalog(); return; }
    galleryBusy = true;
    try {
        const dir = path.join(DATA, 'games', String(r.id)); fs.mkdirSync(dir, { recursive: true });
        const have = new Set((r.images || []).map((i) => i.name));
        const gal = await fetchImages(g, dir, have);
        let hasText = !!r.hasText;
        if (!hasText) {
            const l = (g.ins || []).find((x) => /\.txt$/i.test(x) && hasSource(x));
            if (l) { try { const t = (await fetchFromSources(l, 300e3, { quiet: true })).buf.toString('latin1'); if (t.trim().length > 20) { fs.writeFileSync(path.join(dir, 'instructions.txt'), t.slice(0, 60000)); hasText = true; } } catch (e) { /* no text */ } }
        }
        const cur = catalog.games[r.id];
        if (cur && cur.status === 'ready') {
            cur.images = (cur.images || []).concat(gal.images.filter((i) => !have.has(i.name)));
            cur.docs = gal.docs; cur.hasText = hasText; cur.gallery = GALLERY_V; saveCatalog();
            if (gal.images.length || gal.docs.length) log(`Gallery: ${cur.title} +${gal.images.length} picture(s)${gal.docs.length ? ', ' + gal.docs.length + ' document(s)' : ''}`);
        }
    } catch (e) { r.gallery = GALLERY_V; saveCatalog(); log(`Gallery ${r.title}: ${e.message}`, 'warn'); }
    finally { galleryBusy = false; }
}
setInterval(() => { galleryTick().catch(() => {}); }, 20000).unref();

// games left half-done by a restart go back to the queue
for (const r of Object.values(catalog.games)) if (r.status === 'working') delete catalog.games[r.id];
saveCatalog();
server.listen(PORT, '127.0.0.1', () => log(`SPECTROM agent ${VERSION} listening on 127.0.0.1:${PORT} (data ${DATA})`));
if (fs.existsSync(F.index)) setTimeout(loadIndex, 500);
setTimeout(() => { if (!job.running) checkSources().then(() => discoverMirrors()).catch((e) => log('Source check failed: ' + e.message, 'warn')); }, 4000);
setInterval(() => { if (!job.running) checkSources().catch(() => {}); }, 6 * 3600e3).unref();
setTimeout(() => { const n = Object.values(catalog.games).filter(needsRetest).length; if (n) log(`Tester v${TESTER_V}: ${n} stored game(s) will be re-tested in the background (one every 15 s)`); }, 6000);
setInterval(retestTick, 15000).unref();
