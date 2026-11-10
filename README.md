![SPECTROM — ZX Spectrum games, tested and ready to play](docs/images/header-en.png)

<h1><img src="docs/images/spectrom-title.png" alt="SPECTROM" height="32"></h1>

**English** · [Español](README.es.md)

SPECTROM is a ZX Spectrum 48K / 128K emulator that runs in your browser, with a small team of agents that build your game
library for you. They read [ZXDB](https://github.com/zxdb/ZXDB) (the open database of Spectrum software), download games whose
rights holders allow distribution, boot each one on a headless Spectrum to prove that it really loads and runs, capture its
screens, read its original instructions to find the keys, and write a game sheet. Then you play it with one click and save
your progress in 5 slots.

It is a single Node.js app that runs on your own computer. There are no accounts and no cloud: everything is kept in the
`data/` folder.

Version **1.0.1** · licence **GPL-3.0-or-later** · see [CHANGELOG.md](CHANGELOG.md)

## Only games that may be distributed

ZXDB records, for every title, whether its rights holders allow distribution. SPECTROM follows that record strictly:

| ZXDB availability | What SPECTROM does |
|---|---|
| **Available** (rights holders allow distribution) | Downloads the tape from public mirrors, tests it, keeps it and lets you play it. |
| **Distribution denied**, denied by a later owner, unknown, never released, or under restrictions | **Sheet only.** It shows the ZXDB data (year, publisher, authors, genre, rating) marked with ©. Nothing of the title is downloaded: no tape, no instructions, no images. It cannot be played. |

Links that ZXDB itself marks as denied are never followed, and there is no setting to turn this off.

**Load tape** lets you open a `.tap`, `.tzx`, `.z80`, `.sna`, `.szx` or `.zip` file from your own computer. That file never
leaves your browser and is your responsibility: only load files you have the right to use.

## Concept

![How SPECTROM works](docs/images/concept-en.png)

1. **CURATOR** picks games from the ZXDB index (by rating, genre, or a request such as *"platform games"*). If you have a local
   AI ([Ollama](https://ollama.com)) running with spare RAM it plans with it; otherwise it uses simple rules.
2. **SCOUT** fetches the tape of each *available* game from public Spectrum archives (Spectrum Computing, ZXInfo, World of
   Spectrum Classic, Internet Archive mirrors). You can switch each source on or off.
3. **TESTER** loads the tape on a headless Spectrum (the same emulator core, running in Node.js), presses keys, and only accepts
   the game if it really reaches its screens. Up to two screenshots become the cover.
4. **ARCHIVIST** writes the sheet: description, controls and keys (only those that really appear in the original instructions),
   joystick options and images.

## Screenshots

> The screenshots were taken with the test tape bundled with the tests (`tests/mktap.mjs`), so the game screens show
> "SPECTROM TEST" instead of the real games.

**Library:** search, filters (genre, 48K/128K, playable or ©) and cards with the agent's verdict.

![Library](docs/images/library.png)

**AI agent:** live test monitor, the four agents, status and log.

![AI agent](docs/images/agent.png)

**A © title:** sheet only, with no LOAD button.

![© sheet](docs/images/copyright-sheet.png)

**Playing:** CRT and pixel modes, volume, Kempston joystick, controls and the original keys next to the screen.

![Playing](docs/images/playing.png)

**Saved games:** 5 slots plus AUTO for each game.

![Saved games](docs/images/saved-games.png)

## Features

- **Emulator**: [JSSpeccy 3](https://github.com/gasman/jsspeccy3) by Matt Westcott (WebAssembly), Spectrum 48K and 128K,
  AY sound, fast tape loading of `.tap` / `.tzx`, `.z80`, `.sna` and `.szx` snapshots.
- **Controls**: keyboard, Kempston joystick with the arrow keys + Ctrl, gamepad (A fire, B space, X enter, Y 1), redefinable
  keys, and the game's own keys read from its instructions.
- **Screen**: full screen (F11), CRT filter, sharp pixels, volume and pause.
- **Saved games**: the whole machine (memory, processor, 128K banks and sound chip) as a standard `.Z80` v3 snapshot.
  5 slots per game plus **AUTO**, which is written every time you leave the game. F5 opens the slots and F6 continues the most
  recent save. Each slot has a thumbnail and can be downloaded as `.z80`.
- **Agent**: on-demand hunts with an optional request, optional automatic hunts every few hours, retry of failed games,
  source checks, and a full rebuild of the ZXDB index (16,800+ games).
- **Light**: only Node.js (no database, no Python, no system packages). The ZXDB index is read from the official dump with low
  memory use.

## Keys while playing

| Key | Action |
|---|---|
| F1 | Spectrum keyboard |
| F2 | Controls (remap) |
| F5 | Saved games |
| F6 | Continue the last save |
| F8 | Pause |
| F9 | Reset |
| F11 | Full screen |
| Shift / Alt | CAPS SHIFT / SYMBOL SHIFT |
| Backspace | DELETE |
| Arrows + Ctrl | Kempston joystick + fire |

## Install

You need **Node.js 18.17 or newer** (20 or 22 recommended).

```bash
git clone https://github.com/Plastikelectrik/spectrom-standalone.git
cd spectrom-standalone
npm install
npm start
```

Open <http://127.0.0.1:8484> and go to **AI agent → Hunt**. The first hunt downloads the ZXDB dump (about 27 MB) and builds
the index, which takes a minute or two; then the games appear in the library one by one as they pass their test.

### Docker

```bash
docker compose up -d
```

The page is published on `127.0.0.1:8484` only, and the data lives in the `spectrom-data` volume.

## Settings

Copy `.env.example` to `.env` and change what you need.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address of the web page. SPECTROM has **no login**: keep it on your own computer. |
| `PORT` | `8484` | Port of the web page. |
| `SPECTROM_AGENT_PORT` | `8240` | Internal port of the agent (listens on 127.0.0.1 only). |
| `SPECTROM_DATA` | `data` | Catalogue, ZXDB index, downloaded games and saved games. |
| `SPECTROM_OLLAMA` | `http://127.0.0.1:11434` | Optional local AI. |
| `SPECTROM_MODEL` | (automatic) | Ollama model to use, e.g. `qwen2.5:1.5b`. |
| `SPECTROM_AGENT` | `on` | `off` serves the page without starting the agent. |

## Data folder

```
data/
├── zxdb/                  ZXDB dump and the compact index
├── catalog.json           the game sheets
├── games/<id>/            tape and images of each playable game
├── saves/<id>/<slot>.*    your saved games (.z80 + thumbnail + info)
├── settings.json
└── agent.log
```

To back up your saved games, copy `data/saves/`.

## Tests

```bash
npm test
```

The tests build a tape with a small BASIC program, check that the tester accepts it and rejects a broken one, and do a `.Z80`
round trip (save → load → identical machine) on 48K and 128K.

## The emulator core

`public/jsspeccy/` is a build of JSSpeccy 3.2.0 with a small patch (`dev/jsspeccy-3.2.0-spectrom.patch`): Kempston joystick,
volume, whole-machine snapshots for the save slots, and loading files fetched by the page. `public/jsspeccy/SOURCE.txt`
explains how to rebuild the same files from the upstream source.

## Licence

SPECTROM is free software under the **GNU General Public License v3.0 or later** ([LICENSE](LICENSE)).
Third-party parts and their licences are listed in [NOTICE.md](NOTICE.md). The ZX Spectrum ROMs are © Amstrad plc, who
allow their distribution for use with emulators.

SPECTROM is not affiliated with Amstrad, Sky, ZXDB, Spectrum Computing or any of the archives it reads. The game names and
data shown come from ZXDB.
