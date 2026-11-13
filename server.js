// server.js — SPECTROM standalone: web server + API + agent supervisor.
// One command (`npm start`) runs everything on your own computer: the page, the emulator files, the JSON API and the
// agent that hunts, tests and catalogues ZX Spectrum games. No login: it listens on 127.0.0.1 only (see HOST below).
// Copyright (C) 2026 Plastikelectrik — GNU GPL v3 or later (see LICENSE).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8484);
const AGENT_PORT = Number(process.env.SPECTROM_AGENT_PORT || 8240);
const DATA = path.resolve(ROOT, process.env.SPECTROM_DATA || 'data');
const SVC = 'http://127.0.0.1:' + AGENT_PORT;
const ID = /^\d{1,9}$/;
const GKEY = /^(\d{1,9}|local-[a-z0-9-]{1,50})$/;
const SLOT = /^(auto|[1-5])$/;

function loadEnv(file) {   // tiny .env reader (KEY=value lines), no dependency
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

// ---------- the agent runs as a child process and is restarted if it stops ----------
let agent = null, agentRestarts = 0, quitting = false;
function startAgent() {
    if (process.env.SPECTROM_AGENT === 'off') return;   // e.g. tests with a mock agent
    agent = fork(path.join(ROOT, 'src', 'agent', 'agent.mjs'), [], {
        env: Object.assign({}, process.env, { SPECTROM_PORT: String(AGENT_PORT), SPECTROM_DATA: DATA, SPECTROM_ASSETS: path.join(ROOT, 'public', 'jsspeccy') }),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    agent.on('exit', (code) => {
        agent = null;
        if (quitting) return;
        const wait = Math.min(60, 2 ** Math.min(agentRestarts++, 6));
        console.error(`[spectrom] the agent stopped (code ${code}), restarting in ${wait} s`);
        setTimeout(startAgent, wait * 1000);
    });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { quitting = true; if (agent) agent.kill(); process.exit(0); });

async function svc(p, opts = {}) {
    const r = await fetch(SVC + p, {
        method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' },
        body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(opts.timeout || 15000),
    });
    return { status: r.status, data: await r.json().catch(() => ({ ok: false, error: 'bad response from the agent' })) };
}
const safe = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /fetch failed|ECONNREFUSED/.test(String(e.message) + String(e.cause)))) {
            return res.status(503).json({ ok: false, error: 'The SPECTROM agent is starting or not running: try again in a few seconds' });
        }
        console.error('[spectrom]', req.method, req.originalUrl, e.message);
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'server error' });
    }
};
const qs = (req, keys) => { const u = new URLSearchParams(); keys.forEach((k) => { if (req.query[k] != null) u.set(k, String(req.query[k]).slice(0, 120)); }); return u.toString(); };
const pass = (r, res) => res.status(r.status).json(r.data);
const picUrl = (id, name) => '/api/pic/' + encodeURIComponent(id) + '/' + encodeURIComponent(name);
const readBody = (req, limit) => new Promise((ok, ko) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { ko(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts))); req.on('error', ko);
});

const app = express();
app.disable('x-powered-by');
app.use('/api', express.json({ limit: '100kb' }));

// ---------- API: catalogue, agent, emulator files ----------
app.get('/api/version', (req, res) => res.json({ ok: true, version: VERSION }));
// SPECTROM ONLINE (multiplayer network): the page of the online server, shown in the ONLINE tab only after the player presses CONNECT.
// SPECTROM_ONLINE=off hides the tab; any other value is the address of another SPECTROM LANDING (v1.5.0 or later).
const ONLINE = String(process.env.SPECTROM_ONLINE || 'https://plastikelectrik.xyz/spectrom.php').trim();
app.get('/api/online', (req, res) => res.json({ ok: true, url: /^off$/i.test(ONLINE) || !/^https?:\/\//.test(ONLINE) ? null : ONLINE }));
app.get('/api/status', safe(async (req, res) => pass(await svc('/status'), res)));
app.get('/api/live', safe(async (req, res) => pass(await svc('/live?' + qs(req, ['since'])), res)));
app.get('/api/sources', safe(async (req, res) => pass(await svc('/sources'), res)));
app.post('/api/sources', safe(async (req, res) => { const b = req.body || {}; pass(await svc('/sources', { method: 'POST', body: { id: String(b.id || '').slice(0, 40), enabled: !!b.enabled } }), res); }));
app.post('/api/sources/check', safe(async (req, res) => pass(await svc('/sources/check', { method: 'POST', body: {} }), res)));
app.post('/api/retry', safe(async (req, res) => pass(await svc('/retry', { method: 'POST', body: { count: Math.max(1, Math.min(200, Number((req.body || {}).count) || 20)), by: 'you' } }), res)));
app.get('/api/log', safe(async (req, res) => pass(await svc('/log?' + qs(req, ['since'])), res)));
app.get('/api/search', safe(async (req, res) => pass(await svc('/search?' + qs(req, ['q'])), res)));
app.get('/api/catalog', safe(async (req, res) => {
    const r = await svc('/catalog?' + qs(req, ['q', 'filter', 'genre', 'machine', 'sort', 'offset', 'limit']));
    if (r.data && Array.isArray(r.data.games)) r.data.games.forEach((g) => {
        const pick = ['cover', 'load', 'shot', 'run1', 'inlay'].find((n) => (g.images || []).includes(n));
        g.thumb = pick ? picUrl(g.id, pick) : null;
        g.thumb2 = (g.images || []).includes('shot') && pick !== 'shot' ? picUrl(g.id, 'shot') : null;
    });
    pass(r, res);
}));
app.get('/api/game/:id', safe(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    const r = await svc('/game/' + req.params.id);
    if (r.data && r.data.game) r.data.game.images = (r.data.game.images || []).map((i) => ({ name: i.name, url: picUrl(r.data.game.id, i.name) }));
    pass(r, res);
}));
app.get('/api/rom/:id', safe(async (req, res) => {   // only games whose distribution is allowed have a file
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    const r = await fetch(SVC + '/file/' + req.params.id, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) return res.status(r.status).json(await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status })));
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Spectrom-Name': r.headers.get('x-spectrom-name') || 'game.tap', 'X-Spectrom-Machine': r.headers.get('x-spectrom-machine') || '48' });
    res.send(Buffer.from(await r.arrayBuffer()));
}));
app.get('/api/text/:id', safe(async (req, res) => {   // original instructions (text) of a playable game
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    pass(await svc('/text/' + req.params.id), res);
}));
app.post('/api/fav/:id', safe(async (req, res) => {   // favourites
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    pass(await svc('/fav/' + req.params.id, { method: 'POST', body: { on: (req.body || {}).on !== false } }), res);
}));
app.get('/api/pic/:id/:name', safe(async (req, res) => {
    const { id, name } = req.params;
    if (!ID.test(id) || !/^[a-z0-9]{1,12}$/.test(name)) return res.status(400).end();
    const r = await fetch(SVC + '/img/' + id + '/' + name, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(404).end();
    res.set({ 'Content-Type': r.headers.get('content-type') || 'image/png', 'Cache-Control': 'private, max-age=21600' });
    res.send(Buffer.from(await r.arrayBuffer()));
}));
app.post('/api/hunt', safe(async (req, res) => {
    const b = req.body || {};
    const body = { count: Math.max(1, Math.min(200, Number(b.count) || 10)), request: String(b.request || '').slice(0, 200), by: 'you' };
    if (Array.isArray(b.ids)) body.ids = b.ids.filter((x) => ID.test(String(x))).slice(0, 100).map(Number);
    pass(await svc('/hunt', { method: 'POST', body }), res);
}));
app.post('/api/stop', safe(async (req, res) => pass(await svc('/stop', { method: 'POST', body: {} }), res)));
app.post('/api/settings', safe(async (req, res) => {
    const b = req.body || {}, body = {};
    ['autoHunt', 'everyHours', 'batch', 'copyrightShare', 'retryShare'].forEach((k) => { if (k in b) body[k] = b[k]; });
    pass(await svc('/settings', { method: 'POST', body }), res);
}));
app.post('/api/reindex', safe(async (req, res) => pass(await svc('/index/rebuild', { method: 'POST', body: {} }), res)));
app.post('/api/game/:id/retest', safe(async (req, res) => {   // test the stored copy again (48K and 128K)
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    pass(await svc('/game/' + req.params.id + '/retest', { method: 'POST', body: { by: 'you' }, timeout: 180000 }), res);
}));
app.post('/api/game/:id/delete', safe(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad id' });
    pass(await svc('/game/' + req.params.id + '/delete', { method: 'POST', body: {} }), res);
}));

// ---------- saved games: .Z80 snapshots in <data>/saves/<game>/<slot>.{z80,jpg,json} ----------
const SAVES = path.join(DATA, 'saves');
async function savingAllowed(g) {   // only games that have a file here (distribution allowed) or your own local tapes
    if (!/^\d+$/.test(g)) return { ok: true };
    const r = await svc('/game/' + g); const game = r.data && r.data.game;
    if (!game) return { ok: false, code: 404, error: 'game not found' };
    if (game.copyright || game.status !== 'ready') return { ok: false, code: 403, error: 'this title has no playable copy here' };
    return { ok: true };
}
app.get('/api/saves', safe(async (req, res) => {   // every saved game (the "Saved games" list)
    const out = [];
    for (const g of await fs.promises.readdir(SAVES).catch(() => [])) {
        if (!GKEY.test(g)) continue;
        for (const n of (await fs.promises.readdir(path.join(SAVES, g)).catch(() => [])).filter((x) => x.endsWith('.json'))) {
            const slot = n.slice(0, -5); if (!SLOT.test(slot)) continue;
            const m = JSON.parse(await fs.promises.readFile(path.join(SAVES, g, n), 'utf8').catch(() => '{}'));
            const th = await fs.promises.stat(path.join(SAVES, g, slot + '.jpg')).catch(() => null);
            out.push({ game: g, slot, date: m.date, machine: m.machine, title: m.title, size: m.size, thumb: th ? `/api/savethumb/${g}/${slot}?t=${Math.floor(th.mtimeMs)}` : null });
        }
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.json({ ok: true, saves: out });
}));
app.get('/api/saves/:g', safe(async (req, res) => {
    const g = req.params.g; if (!GKEY.test(g)) return res.status(400).json({ ok: false, error: 'bad game' });
    const dir = path.join(SAVES, g), saves = [];
    for (const n of (await fs.promises.readdir(dir).catch(() => [])).filter((x) => x.endsWith('.json'))) {
        const slot = n.slice(0, -5); if (!SLOT.test(slot)) continue;
        const m = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8').catch(() => '{}'));
        const th = await fs.promises.stat(path.join(dir, slot + '.jpg')).catch(() => null);
        saves.push({ slot, date: m.date, machine: m.machine, title: m.title, size: m.size, thumb: th ? `/api/savethumb/${g}/${slot}?t=${Math.floor(th.mtimeMs)}` : null });
    }
    res.json({ ok: true, saves });
}));
app.put('/api/saves/:g/:slot', safe(async (req, res) => {
    const { g, slot } = req.params; if (!GKEY.test(g) || !SLOT.test(slot)) return res.status(400).json({ ok: false, error: 'bad slot' });
    const allowed = await savingAllowed(g); if (!allowed.ok) return res.status(allowed.code).json({ ok: false, error: allowed.error });
    const buf = await readBody(req, 400 * 1024).catch(() => null);
    if (!buf || buf.length < 30) return res.status(400).json({ ok: false, error: 'empty or too big' });
    let meta = {}; try { meta = JSON.parse(Buffer.from(String(req.headers['x-save-meta'] || ''), 'base64').toString('utf8')); } catch (e) { meta = {}; }
    const dir = path.join(SAVES, g); await fs.promises.mkdir(dir, { recursive: true });
    const info = { slot, date: new Date().toISOString(), size: buf.length, title: String(meta.title || '').slice(0, 120), machine: [48, 128, 5].includes(Number(meta.machine)) ? Number(meta.machine) : 48,
        halted: !!meta.halted, tstates: Number.isFinite(Number(meta.tstates)) ? Number(meta.tstates) : null };
    await fs.promises.writeFile(path.join(dir, slot + '.z80.tmp'), buf); await fs.promises.rename(path.join(dir, slot + '.z80.tmp'), path.join(dir, slot + '.z80'));
    await fs.promises.writeFile(path.join(dir, slot + '.json'), JSON.stringify(info));
    res.json({ ok: true, save: info });
}));
app.put('/api/saves/:g/:slot/thumb', safe(async (req, res) => {
    const { g, slot } = req.params; if (!GKEY.test(g) || !SLOT.test(slot)) return res.status(400).json({ ok: false, error: 'bad slot' });
    const dir = path.join(SAVES, g);
    if (!fs.existsSync(path.join(dir, slot + '.z80'))) return res.status(404).json({ ok: false, error: 'save the game first' });
    const buf = await readBody(req, 300 * 1024).catch(() => null);
    if (!buf || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ ok: false, error: 'not a JPEG' });
    await fs.promises.writeFile(path.join(dir, slot + '.jpg'), buf);
    res.json({ ok: true });
}));
app.get('/api/saves/:g/:slot/z80', safe(async (req, res) => {
    const { g, slot } = req.params; if (!GKEY.test(g) || !SLOT.test(slot)) return res.status(400).json({ ok: false, error: 'bad slot' });
    const dir = path.join(SAVES, g);
    const buf = await fs.promises.readFile(path.join(dir, slot + '.z80')).catch(() => null);
    if (!buf) return res.status(404).json({ ok: false, error: 'no saved game in this slot' });
    const meta = await fs.promises.readFile(path.join(dir, slot + '.json'), 'utf8').catch(() => '{}');
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Save-Meta': Buffer.from(meta).toString('base64') });
    res.send(buf);
}));
app.delete('/api/saves/:g/:slot', safe(async (req, res) => {
    const { g, slot } = req.params; if (!GKEY.test(g) || !SLOT.test(slot)) return res.status(400).json({ ok: false, error: 'bad slot' });
    for (const ext of ['.z80', '.jpg', '.json']) await fs.promises.unlink(path.join(SAVES, g, slot + ext)).catch(() => {});
    res.json({ ok: true });
}));
app.get('/api/savethumb/:g/:slot', safe(async (req, res) => {
    const { g, slot } = req.params; if (!GKEY.test(g) || !SLOT.test(slot)) return res.status(400).end();
    const f = path.join(SAVES, g, slot + '.jpg');
    if (!fs.existsSync(f)) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
}));
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'unknown endpoint' }));

// ---------- the page ----------
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', setHeaders: (res, p) => {
    if (p.endsWith('.wasm')) res.set('Content-Type', 'application/wasm');
    res.set('Cache-Control', /\.(js|wasm|css)$/.test(p) ? 'no-cache' : 'public, max-age=3600');
} }));

fs.mkdirSync(SAVES, { recursive: true });
startAgent();
app.listen(PORT, HOST, () => {
    console.log(`SPECTROM standalone ${VERSION} — open http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA})`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('WARNING: SPECTROM has no login. HOST=' + HOST + ' makes it reachable from other machines: only do this on a network you trust.');
});
