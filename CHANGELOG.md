# Changelog

## 1.2.0 — 2026-11-13

- **🌐 ONLINE tab** (optional): SPECTROM ONLINE, the multiplayer network of the public SPECTROM page, inside the standalone —
  friends by Gmail, chat, score challenges, relay games and live games (two screens, timed duel, watch me play, same Spectrum ·
  2 players, pass the controller). Nothing connects until you press CONNECT; DISCONNECT forgets it; OPEN IN A NEW TAB when the
  browser blocks Google sign-in in frames. `SPECTROM_ONLINE` sets the address (`off` hides the tab).
- Your local library, saves and favourites stay on your computer; online games come from the server's shared collection.

## 1.1.2 — 2026-11-13

- **Fix**: a game that went back to BASIC, reset the Spectrum or hung when you pressed its start key (e.g. Rainbow Islands on
  48K, a multiload there) passed the agent test because the screen changed. The tester now checks it after loading and after the
  start key; that machine then fails and the other one is tried. 48K/128K titles are tested on 128K first.
- Every game of your library is re-tested once in the background (one every 15 s while the agent is idle); a game that passes on
  the other machine now starts there, one that fails everywhere is kept with a warning in its sheet.
- **RE-TEST** button in the game sheet; the player's **48K / 128K** badge is a switch (**F7**), remembered per game.
- New self-tests: machine-code games that keep running, go back to BASIC, need 128K or hang after SPACE.

## 1.1.1 — 2026-11-13

- The version is shown next to the SPECTROM logo at the top of the page.

## 1.1.0 — 2026-11-13

- **Favourites**: a heart on every game card and an ADD TO FAVOURITES button in every sheet; new **♥ FAVOURITES** tab with
  the library filters. Stored in `data/favorites.json`.
- **Full gallery** in every game sheet: every picture ZXDB lists (17 kinds: loading/in-game/opening screens, inlays front, back
  and side, media scans, scanned instructions, booklets, maps, original artwork, adverts, posters, promotional material,
  keyboard overlays, code sheets) fetched from every source, grouped, with a full-screen viewer (zoom, arrows, new tab),
  links to the PDF documents and the original instructions text.
- ZXDB index v3 (rebuilt once from the dump on disk). Games added before 1.1.0 get their gallery in the background.
- Bigger limits: up to 200 games per hunt, per retry run and per automatic hunt, 100 titles per request.

## 1.0.2 — 2026-11-10

- Complete instructions in the README (English and Spanish): step-by-step installation for Windows, macOS and Linux,
  a user guide for every part of the app (library, game sheet, AI agent, playing, controls and joysticks, saved games,
  load tape), local AI with Ollama, running in the background with pm2, Docker, other devices on your network,
  backups, updating, uninstalling and troubleshooting.

## 1.0.1 — 2026-11-10

- The name SPECTROM is always drawn with the ZX Spectrum ROM font: README title, header and concept images, and
  every mention inside the app (footer, test monitor, © notes, saved games).

## 1.0.0 — 2026-11-10

First public release.

- ZX Spectrum 48K / 128K emulator in the browser (JSSpeccy 3.2.0 with the SPECTROM patch): AY sound, fast tape loading,
  Kempston joystick, gamepad, redefinable controls, CRT and pixel modes, full screen.
- Agent team (curator, scout, tester, archivist) that builds the library from ZXDB, with an optional local AI (Ollama).
- Only titles whose rights holders allow distribution are downloaded and played; every other title is shown as a © sheet
  with ZXDB data only, and nothing of it is downloaded.
- Headless tester: a game enters the library only after it really loads and reaches its screens.
- Saved games: 5 slots plus AUTO per game as standard `.Z80` v3 snapshots, thumbnails, download, F5 / F6.
- Load your own tape or snapshot from your computer (it stays in the browser).
- Single Node.js app, no accounts, local only by default (127.0.0.1); Docker and docker compose files.
- Tests: tester accept/reject and `.Z80` round trip on 48K and 128K.
