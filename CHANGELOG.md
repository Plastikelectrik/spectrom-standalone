# Changelog

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
