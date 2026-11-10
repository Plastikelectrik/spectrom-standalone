![SPECTROM — juegos de ZX Spectrum, probados y listos para jugar](docs/images/header-es.png)

<h1><img src="docs/images/spectrom-title.png" alt="SPECTROM" height="32"></h1>

[English](README.md) · **Español**

SPECTROM es un emulador de ZX Spectrum 48K / 128K que funciona en tu navegador, con un pequeño equipo de agentes que monta tu
biblioteca de juegos por ti. Leen [ZXDB](https://github.com/zxdb/ZXDB) (la base de datos abierta del software de Spectrum),
descargan los juegos cuyos titulares permiten distribuirlos, arrancan cada uno en un Spectrum sin pantalla para comprobar que
de verdad carga y funciona, capturan sus pantallas, leen sus instrucciones originales para sacar las teclas y escriben una
ficha. Después lo juegas con un clic y guardas tu partida en 5 ranuras.

Es una única aplicación Node.js que se ejecuta en tu propio ordenador. Sin cuentas y sin nube: todo se guarda en la carpeta
`data/`.

Versión **1.0.1** · licencia **GPL-3.0-or-later** · ver [CHANGELOG.md](CHANGELOG.md)

## Solo juegos que se pueden distribuir

ZXDB indica, para cada título, si sus titulares permiten distribuirlo. SPECTROM sigue ese dato al pie de la letra:

| Disponibilidad en ZXDB | Qué hace SPECTROM |
|---|---|
| **Disponible** (los titulares permiten distribuirlo) | Descarga la cinta de espejos públicos, la prueba, la guarda y te deja jugarla. |
| **Distribución denegada**, denegada por un dueño posterior, desconocida, nunca publicado o con restricciones | **Solo ficha.** Muestra los datos de ZXDB (año, editora, autores, género, nota) marcados con ©. No se descarga nada de ese título: ni cinta, ni instrucciones, ni imágenes. No se puede jugar. |

Los enlaces que la propia ZXDB marca como denegados no se siguen nunca, y no hay ningún ajuste para cambiarlo.

**Cargar cinta** te deja abrir un `.tap`, `.tzx`, `.z80`, `.sna`, `.szx` o `.zip` de tu propio ordenador. Ese archivo no
sale de tu navegador y es responsabilidad tuya: carga solo archivos que tengas derecho a usar.

## Concepto

![Cómo funciona SPECTROM](docs/images/concept-es.png)

1. **CURADOR** elige juegos del índice de ZXDB (por nota, por género o con una petición como *"juegos de plataformas"*). Si
   tienes una IA local ([Ollama](https://ollama.com)) con RAM libre, planifica con ella; si no, usa reglas sencillas.
2. **EXPLORADOR** descarga la cinta de cada juego *disponible* de archivos públicos de Spectrum (Spectrum Computing, ZXInfo,
   World of Spectrum Classic, espejos de Internet Archive). Puedes activar o desactivar cada fuente.
3. **PROBADOR** carga la cinta en un Spectrum sin pantalla (el mismo núcleo del emulador, en Node.js), pulsa teclas y solo
   acepta el juego si de verdad llega a sus pantallas. Hasta dos capturas forman la portada.
4. **ARCHIVERO** escribe la ficha: descripción, controles y teclas (solo las que aparecen de verdad en las instrucciones
   originales), opciones de joystick e imágenes.

## Capturas

> Las capturas se hicieron con la cinta de prueba de los tests (`tests/mktap.mjs`), por eso las pantallas de juego muestran
> "SPECTROM TEST" en lugar de los juegos reales. La interfaz está en inglés.

**Biblioteca:** búsqueda, filtros (género, 48K/128K, jugable o ©) y fichas con el veredicto del agente.

![Biblioteca](docs/images/library.png)

**Agente IA:** monitor de pruebas en directo, los cuatro agentes, estado y registro.

![Agente IA](docs/images/agent.png)

**Un título ©:** solo ficha, sin botón LOAD.

![Ficha ©](docs/images/copyright-sheet.png)

**Jugando:** modos CRT y píxel, volumen, joystick Kempston, controles y las teclas originales junto a la pantalla.

![Jugando](docs/images/playing.png)

**Partidas guardadas:** 5 ranuras más AUTO para cada juego.

![Partidas guardadas](docs/images/saved-games.png)

## Funciones

- **Emulador**: [JSSpeccy 3](https://github.com/gasman/jsspeccy3) de Matt Westcott (WebAssembly), Spectrum 48K y 128K,
  sonido AY, carga rápida de cintas `.tap` / `.tzx`, snapshots `.z80`, `.sna` y `.szx`.
- **Controles**: teclado, joystick Kempston con las flechas + Ctrl, mando (A disparo, B espacio, X enter, Y 1), teclas
  redefinibles y las teclas propias del juego sacadas de sus instrucciones.
- **Pantalla**: pantalla completa (F11), filtro CRT, píxeles nítidos, volumen y pausa.
- **Partidas guardadas**: la máquina entera (memoria, procesador, bancos de 128K y chip de sonido) como snapshot `.Z80` v3
  estándar. 5 ranuras por juego más **AUTO**, que se escribe cada vez que sales del juego. F5 abre las ranuras y F6 continúa
  la última partida. Cada ranura tiene miniatura y se puede descargar como `.z80`.
- **Agente**: cacerías bajo demanda con petición opcional, cacerías automáticas opcionales cada pocas horas, reintento de
  juegos fallidos, comprobación de fuentes y reconstrucción completa del índice de ZXDB (más de 16.800 juegos).
- **Ligero**: solo Node.js (sin base de datos, sin Python, sin paquetes del sistema). El índice de ZXDB se lee del volcado
  oficial con poca memoria.

## Teclas durante el juego

| Tecla | Acción |
|---|---|
| F1 | Teclado del Spectrum |
| F2 | Controles (redefinir) |
| F5 | Partidas guardadas |
| F6 | Continuar la última partida |
| F8 | Pausa |
| F9 | Reset |
| F11 | Pantalla completa |
| Mayús / Alt | CAPS SHIFT / SYMBOL SHIFT |
| Retroceso | DELETE |
| Flechas + Ctrl | Joystick Kempston + disparo |

## Instalación

Necesitas **Node.js 18.17 o superior** (recomendado 20 o 22).

```bash
git clone https://github.com/Plastikelectrik/spectrom-standalone.git
cd spectrom-standalone
npm install
npm start
```

Abre <http://127.0.0.1:8484> y ve a **AI agent → Hunt**. La primera cacería descarga el volcado de ZXDB (unos 27 MB) y crea
el índice, lo que tarda uno o dos minutos; después los juegos van apareciendo en la biblioteca según pasan su prueba.

### Docker

```bash
docker compose up -d
```

La página se publica solo en `127.0.0.1:8484` y los datos viven en el volumen `spectrom-data`.

## Ajustes

Copia `.env.example` a `.env` y cambia lo que necesites.

| Variable | Por defecto | Significado |
|---|---|---|
| `HOST` | `127.0.0.1` | Dirección de la página. SPECTROM **no tiene login**: déjalo en tu propio ordenador. |
| `PORT` | `8484` | Puerto de la página. |
| `SPECTROM_AGENT_PORT` | `8240` | Puerto interno del agente (escucha solo en 127.0.0.1). |
| `SPECTROM_DATA` | `data` | Catálogo, índice de ZXDB, juegos descargados y partidas guardadas. |
| `SPECTROM_OLLAMA` | `http://127.0.0.1:11434` | IA local opcional. |
| `SPECTROM_MODEL` | (automático) | Modelo de Ollama a usar, p. ej. `qwen2.5:1.5b`. |
| `SPECTROM_AGENT` | `on` | `off` sirve la página sin arrancar el agente. |

## Carpeta de datos

```
data/
├── zxdb/                  volcado de ZXDB y el índice compacto
├── catalog.json           las fichas de los juegos
├── games/<id>/            cinta e imágenes de cada juego jugable
├── saves/<id>/<ranura>.*  tus partidas (.z80 + miniatura + datos)
├── settings.json
└── agent.log
```

Para hacer copia de tus partidas, copia `data/saves/`.

## Tests

```bash
npm test
```

Los tests crean una cinta con un pequeño programa BASIC, comprueban que el probador la acepta y rechaza una rota, y hacen
un viaje de ida y vuelta `.Z80` (guardar → cargar → máquina idéntica) en 48K y 128K.

## El núcleo del emulador

`public/jsspeccy/` es una compilación de JSSpeccy 3.2.0 con un pequeño parche (`dev/jsspeccy-3.2.0-spectrom.patch`):
joystick Kempston, volumen, snapshots de la máquina entera para las ranuras y carga de archivos traídos por la página.
`public/jsspeccy/SOURCE.txt` explica cómo recompilar los mismos archivos desde el código original.

## Licencia

SPECTROM es software libre bajo la **GNU General Public License v3.0 o posterior** ([LICENSE](LICENSE)).
Las partes de terceros y sus licencias están en [NOTICE.md](NOTICE.md). Las ROM del ZX Spectrum son © Amstrad plc, que
permite distribuirlas para su uso con emuladores.

SPECTROM no está afiliado a Amstrad, Sky, ZXDB, Spectrum Computing ni a ninguno de los archivos que lee. Los nombres y
datos de los juegos proceden de ZXDB.
