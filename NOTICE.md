# Third-party notices

SPECTROM is © 2026 Plastikelectrik and is distributed under the GNU General Public License v3.0 or later (see `LICENSE`).
It includes or uses the following third-party work.

| Component | Where | Author | Licence |
|---|---|---|---|
| JSSpeccy 3.2.0 (emulator core, worker, tape loaders) | `public/jsspeccy/`, `src/jsspeccy/runtime/` | Matt Westcott | GPL-3.0 (`public/jsspeccy/COPYING`) |
| SPECTROM patch to JSSpeccy | `dev/jsspeccy-3.2.0-spectrom.patch` | Plastikelectrik | GPL-3.0 |
| JSZip 3.10.2 (bundled inside `jsspeccy.js`, with pako) | `public/jsspeccy/jsspeccy.js` | Stuart Knightley | MIT or GPL-3.0 (`jsspeccy.js.LICENSE.txt`) |
| ZX Spectrum 48K / 128K ROMs, TR-DOS ROM | `public/jsspeccy/roms/` | © Amstrad plc | Amstrad allows their distribution for use with emulators |
| Font Awesome Free 6.7.2 | `public/vendor/fontawesome/` | Fonticons, Inc. | Icons CC BY 4.0, fonts SIL OFL 1.1, code MIT (`LICENSE.txt`) |
| Express | npm dependency | Express contributors | MIT |
| pako | npm dependency | Andrey Tupitsin, Vitaly Puzrin | MIT and Zlib |

## Game data

Game titles, years, publishers, authors, genres, ratings, availability and file links come from
[ZXDB](https://github.com/zxdb/ZXDB), maintained by Einar Saukas and contributors. SPECTROM downloads the public ZXDB dump at
run time; it is not included in this repository. See the ZXDB repository for its terms.

## Games

This repository contains **no games**. The agent downloads, on the user's own computer, only titles that ZXDB records as
*available* (their rights holders allow distribution). Titles with any other availability are shown as data only and nothing
of theirs is downloaded. Game names and trademarks belong to their owners.
