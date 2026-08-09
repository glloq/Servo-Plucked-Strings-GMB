# Servo-Plucked-Strings-GMB — Web configuration interface

Local, browser-based configuration UI for the ESP32-S3 MIDI instrument
controller. It lets a beginner set up and run the instrument entirely from a
phone, tablet or desktop, with no app to install and no source code to edit.

It implements the interface described in the project specs:

- `SPECIFICATION.md` — dashboard (§19), setup wizard (§10), configurable
  GPIO management (§11), servo & note config (§14–15), MIDI parameters
  (§18), profile storage (§20), safety/panic (§21).
- `STRING_FRET_SELECTION.md` — explicit string/fret selection over MIDI CC,
  the General-Midi-Boop preset, the MIDI monitor and the integrated test tool.
- `SYSEX_CAPABILITIES.md` — GMB identity &
  capabilities page and the integrated SysEx tester.

## What it is

Vanilla **HTML / CSS / JavaScript** — no framework, no CDN, no build step. The
files are small and fully self-contained so they can be flashed to the ESP32's
**LittleFS** and served directly by the firmware's web server.

Scripts are plain classic `<script>` files sharing a global `GMB` namespace
(not ES modules), specifically so the page also works when opened straight from
disk (`file://`), where module imports would be blocked by the browser.

## How it is served

The firmware serves the static files from LittleFS at the device root:

```
/            -> index.html
/css/style.css
/js/*.js
/api/...     -> REST endpoints (below)
/ws/midi     -> WebSocket, live MIDI monitor stream
/ws/status   -> WebSocket, live dashboard/state stream
```

Reach it at the device IP (station mode) or the captive-portal address in
access-point mode (default SSID `Servo-Plucked-Strings-GMB`).

## Mock mode (standalone / demo)

Every REST call tries `fetch()` first and, if it fails (no backend — e.g. you
opened `index.html` directly), transparently falls back to an in-memory mock
with realistic sample data: a **4-string GCEA ukulele**. The WebSocket streams
fall back to timed mock pumps that emit a plausible GMB tablature sequence and
live status jitter. A pulsing **DEMO / MOCK DATA** badge appears in the top bar
whenever mock data is in use.

This means you can open `web-interface/index.html` in any browser and exercise
the entire UI — wizard, pin grid, MIDI monitor, test tool, SysEx tester,
profiles — with nothing else running.

To try it:

```
# just open the file, or serve it locally:
python3 -m http.server -d web-interface 8080
# then browse http://localhost:8080/
```

## Structure

```
web-interface/
├── index.html            SPA shell + script load order
├── css/style.css         responsive styling, light/dark via prefers-color-scheme
├── js/
│   ├── api.js            REST + WebSocket client, board profile, mock backend, test sequencer
│   ├── app.js            shell, routing, DOM helpers, draft-profile state, mode toggle
│   ├── dashboard.js      dashboard (§19)
│   ├── pins.js           GPIO assignment grid (§11)
│   ├── wizard.js         8-step setup wizard — Frets and Plucking configured separately (§10)
│   ├── midimonitor.js    reusable real-time MIDI monitor (§15)
│   ├── midiselect.js     MIDI page: string/fret selection (§14) + params (§18) + test tool (§16)
│   ├── sysex.js          GMB identity & capabilities + SysEx tester (§17/§18)
│   └── profiles.js       profile list/create/copy/rename/delete/export/import/restore (§20)
└── README.md
```

## Simplified vs Advanced mode

A toggle in the sidebar switches between **Simplified** (beginner: recommended
values, hidden fine-tuning, only recommended GPIOs, servo wiring auto-assigned)
and **Advanced** (manual GPIO assignment including caution pins, per-servo wiring
— PCA9685 channel or direct GPIO — plus pulse/travel/settle parameters, strum-lift
/ damper / auxiliary actuators, SysEx block toggles, raw byte views), per
SPECIFICATION.md §9.2.

## Frets and Plucking — configured separately (wizard steps 3–4)

The two physical halves of each string are set up on their **own steps**, so the
frets (frettes) and the plucking (grattage) can each be equipped, calibrated and
tested independently. The wizard configures a full **servo-per-fret** instrument
(1–6 strings): each fret position has its own finger servo plus a pluck/strum
servo per string, **with or without a PCA9685**. Every actuator step carries an
**Arm** control and a **test bench** (below).

- **Frets (step 3) — the finger servos only.** Per string (string-tab strip), add
  **one finger servo per fret** (1..`maxFret`; frets need not be contiguous — gaps
  are allowed); a finger can be **geared** (one servo drives two frets: side A =
  `fret`, side B = `fretB`/`activeBUs`, neutral = both lifted). A clickable
  **coverage strip** shows which frets are equipped, geared (⚙) and calibrated;
  clicking a fret opens its **inline guided calibration** — set the contact / rest
  angle with a slider (previewed live on the servo), **test rest / press**, **play
  the note** (`POST /api/test/note`) and **mark it calibrated**. A geared finger
  calibrates three positions — **neutral / press A / press B** — each driven to its
  exact `us` pulse and held (`POST /api/test/servo` with `us`).

- **Plucking (step 4) — the plectrum and its helpers only.** Per string, calibrate
  the **pluck/strum** servo (rest + strike angle), and optionally add a **strum
  lift** (lowers the plucker onto the string for a stroke, then raises it) and a
  **damper** (mutes the string). Global **auxiliary** actuators (`stringIndex = -1`)
  live here too. Test **rest / strike** and **pluck the open string**.

Each servo picks its signal **source** (shown in Advanced mode):
- **PCA9685** — choose `pcaBoard` (**0–7**, i.e. up to **8 boards / 128 channels**,
  addresses 0x40–0x47) and `channel` (0–15). A compact channel-availability map
  flags a duplicate `board+channel` in red.
- **Direct GPIO** — choose a free ESP32 pin, filtered with the same green/yellow/red
  capability rules as the pin grid (reserved/USB pins hidden, caution pins
  Advanced-only, pins already used by a board signal or another servo excluded). At
  most **8 direct-GPIO servos** (one LEDC channel each).

The system works with **no PCA at all** (every servo on a direct GPIO) or any mix.
Per-string servos get their `stringIndex` set automatically. Each servo carries its
calibration (rest/active µs, pulse min/max, inverted, travelMs, settleMs,
disableAtRest).

## Testing one servo or a whole group

Every actuator step (Frets, Plucking) and the final **Test** step share a **test
bench** driven by a small client-side **sequencer** (`GMB.testRunner`). Because the
firmware drives **one servo at a time** (`POST /api/test/servo`), a group test is
played as an ordered sequence with a dwell between moves, so the in-rush current
stays bounded and each move is visible. Only one sequence runs at a time; a live
status line shows progress and a **Stop** button (plus the STOP / panic button and
navigating away) cancels it immediately.

- **Single servo** — the rest / press / strike / exact-`us` buttons on each servo.
- **Frets group tests** — *Sweep this string* (press then release every equipped
  fret in turn), *Sweep all strings*, *All fingers to rest*.
- **Plucking group tests** — *Pluck each open string*, *Sweep pluck servos*, and
  *Test strum lifts* / *Test dampers* when present.
- **Full instrument (Test step)** — *Play all open strings*, *Sweep all fingers*,
  *Sweep all pluckers*, *Scale on the active string*, *Test everything* (open plus
  a couple of fretted notes on each string, end-to-end).

Group tests preview the **draft** calibration (the unsaved `us` values), so you can
sweep a string right after adjusting an angle, before saving.

## Backend endpoints

REST (all JSON):

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/status` | dashboard live state (§19) |
| GET  | `/api/commands?id=N` | poll the outcome of a `202`-accepted command |
| GET  | `/api/capabilities` | computed GMB capabilities snapshot (§17) |
| GET  | `/api/board/{id}` | board pin capabilities (e.g. `esp32-s3-devkitc-1`) |
| POST | `/api/pins/auto` | auto-assign the board pins (SDA / SCL / SERVO_OE) |
| POST | `/api/pins/validate` | validate the full profile, returns issues + suggestions |
| GET  | `/api/profile` | active working profile |
| PUT  | `/api/profile` | validate + atomically activate a profile; returns new `capabilitiesRevision` |
| GET  | `/api/profiles` | list of saved profile slots |
| POST | `/api/profiles` | save the profile to a numbered slot (`{slot, profile, startup}`) |
| POST | `/api/profiles/load` | activate a stored slot |
| POST | `/api/profiles/read` | read a slot **without** activating it (copy / rename / set-startup) |
| POST | `/api/profiles/delete` | delete a slot |
| POST | `/api/reset` | recover from panic / E-stop and re-arm |
| POST | `/api/panic` | software panic / STOP (§21.3) |
| POST | `/api/test/note` | integrated note/string/fret test; returns a step trace (§16) |
| POST | `/api/test/servo` | drive one servo to `rest`/`active`, or an exact `us` pulse and hold (armed only) |
| POST | `/api/hotspot` | switch to the access point + captive portal now |
| POST | `/api/wifi` | store Wi-Fi credentials in NVS (never exported) |
| POST | `/api/auth` | set the admin token (first-run bootstrap allowed) |
| POST | `/api/storage/format` | deliberate LittleFS reformat |
| POST | `/api/sysex/request` | run a SysEx request, returns sent + received + decoded (§18) |

`POST /api/test/servo` body: `{ index, active, us? }` → `{ ok, accepted, commandId, note }`
(202 queued / 503 queue full / 409 not armed). A non-zero `us` drives the servo to
that exact pulse and holds it (live per-fret calibration, incl. a geared finger's
side B). There are **no** stepper `jog` / `endstop` routes — servo-per-fret has no
carriage or HOME/LIMIT sensors.

WebSocket:

| Path | Streams |
| ---- | ------- |
| `/ws/midi` | MIDI monitor events `{timeMs, channel, type, cc/note, value, interpretation}` |
| `/ws/status` | live dashboard/state snapshots (same shape as `GET /api/status`) |

## Profile JSON

Import/export use the project profile schema (`project`, `profileVersion`,
`capabilitiesRevision`, `instrument`, `board`, `pins`, `network`, `midi`,
`stringFretSelection`, `power`, `strings`, `servos`). Field names match the
firmware core (`firmware/src/core/…`). Each entry in `servos` carries
`function`, `source` (`"pca"`/`"gpio"`), `stringIndex`, `fret` (and `fretB` /
`activeBUs` for a geared finger), `pcaBoard`, `channel` and `gpio` alongside its
µs calibration; each string in `strings` carries only `{enabled, openNote,
maxFret}` — there is no homing sub-object and no `calibratedFretMm` table.
The default `project` and AP SSID are both `Servo-Plucked-Strings-GMB`.
**The Wi-Fi password is never included in exports.**

## Notes

- No actuator is driven in normal mode until critical validation errors are
  cleared; the wizard's Validation step and the pin validator surface these.
- Only a validated, activated profile is published over SysEx; a draft is never
  announced. Saving increments `capabilitiesRevision`.
