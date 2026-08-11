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

## Navigation (three pages; device settings in a gear modal)

The UI is deliberately minimal: **three main pages** in the sidebar, and the whole
instrument creation grouped into ONE ordered flow on the Setup page. Only device
Wi-Fi and the diagnostic tools live in the gear modal (top-right).

- **Instrument** (`fretboard.js`) — the default landing page: a prominent
  **emergency stop** (STOP + reset/re-arm) and the **playable fretboard**.
- **Setup** (`wizard.js`, the single setup flow) — the complete creation of an
  instrument, in order: **Instrument → Frets → Plucking → MIDI → Timing → Test →
  Validation**. Define it (identity, mechanics, ESP32 board, wiring), calibrate what
  you defined by hand (contact / stroke angles + rotation direction), set its MIDI
  behaviour and timing, then test and save — nothing split across a page and a modal.
- **Wiring & GPIO** (`hardware.js`) — the hardware reference, with two sub-tabs: the
  **wiring diagram** (`wiring.js`) and the **GPIO pin grid + board pinout**
  (`pins.js`). The board is chosen on the Setup page; this page assigns pins on it.

The **gear modal** (`settings.js`) holds only what belongs to the device, in two tabs:

- **Network** — network mode, SSIDs, hostname, Wi-Fi credentials, hotspot switch.
- **Advanced** — GMB identity & capabilities + SysEx tester (`sysex.js`) and the
  live MIDI monitor + integrated tester (`midiselect.js` tools).

Profiles are intentionally **not** exposed (a hidden, non-user setting).

## Structure

```
web-interface/
├── index.html            SPA shell + script load order
├── css/style.css         responsive styling, light/dark via prefers-color-scheme
├── js/
│   ├── api.js            REST + WebSocket client, board profile, mock backend, test sequencer
│   ├── app.js            shell, 3-page routing, DOM helpers, draft-profile state, mode toggle
│   ├── fretboard.js      Instrument page — emergency stop + playable fretboard (press-and-hold)
│   ├── hardware.js       Wiring & GPIO page — sub-tab switch over wiring.js / pins.js
│   ├── pins.js           GPIO grid + ESP32 board selector + graphical board pinout (§11)
│   ├── wiring.js         graphical ESP32 + PCA9685 wiring map (adaptive harness diagram)
│   ├── wizard.js         single setup-flow step engine: Instrument → Frets → Plucking → MIDI → Timing → Test → Validation (§10)
│   ├── midimonitor.js    reusable real-time MIDI monitor (§15)
│   ├── midiselect.js     MIDI settings (§14/§18, the Setup MIDI step) + live monitor/test tools (§16, Advanced tab)
│   ├── sysex.js          GMB identity & capabilities + SysEx tester (§17/§18)
│   ├── profiles.js       profile slots (§20) — loaded but not exposed in the UI (hidden setting)
│   └── settings.js       gear modal — Network / Advanced (device + diagnostics) tabs
└── README.md
```

## Simplified vs Advanced mode

A toggle in the sidebar switches between **Simplified** (beginner: recommended
values, hidden fine-tuning, only recommended GPIOs, servo wiring auto-assigned)
and **Advanced** (manual GPIO assignment including caution pins, per-servo wiring
— PCA9685 channel or direct GPIO — plus pulse/travel/settle parameters, strum-lift
/ damper / auxiliary actuators, SysEx block toggles, raw byte views), per
SPECIFICATION.md §9.2.

## Instrument Builder — mechanical-choice-driven creation (Setup → Instrument step)

The **type is cosmetic**; an instrument is defined by its **mechanics**. The
**Instrument** step of the Setup flow is one adaptive **Builder** screen that
makes those choices explicit and generates the
servo wiring for you, so any plucked/strummed string instrument (1–6 strings) can
be set up quickly:

- **Starting point** — a preset (ukulele/guitar/bass/mandolin/banjo) loads a tuning
  + GM tags, or **Custom** for your own. Type only tags the name / GM program.
- **Strings & tuning** — string count, per-string open note + max fret.
- **Fretting mechanism** — *one servo per fret* (full chromatic) · **geared low
  neck** (pair the wide low frets on one antagonistic servo each, plain high frets;
  halves the low-neck servo count) · **open-string-only** (no frets) · **custom**
  (keep hand-tuned wiring). Each card shows the **live finger-servo count**.
- **Sounding mechanism** — individual **pick** (a plectrum per string) vs per-string
  **strum**, plus optional **strum-lift** and **damper**.
- **Wiring & capacity** — one PCA9685 per string by default, with a **capacity
  meter** (channels per board vs 16, boards vs 8, direct-GPIO vs 8).
- **Board** — the **ESP32 board selector** (S3 / WROOM-32 / DevKit v1) + native-USB
  reserve. Wi-Fi / hostname are in the gear modal (device, not instrument).
- **Generate wiring** — builds the servo list from the choices (a *pending* pill
  tells you when the committed wiring no longer matches). Auxiliary servos and any
  string still marked *custom* are preserved.

The mechanical choice is **not stored** in the profile (the firmware derives frets
from the servo list); the Builder re-derives it from the current servos on entry.

## Frets and Plucking — calibrated in the same flow (Setup page)

On the **Setup** page, the two physical halves of each string are calibrated
and tested on their **own steps** (Frets → Plucking → Test), right after the
Instrument step, so the frets (frettes) and the plucking (grattage) can each
be tuned independently. Each fret position has its own finger servo plus a
pluck/strum servo per string, **with or without a PCA9685**. Both steps adapt to the
Builder's choices (open-only → a banner; strum → its stroke controls) and carry an
**Arm** control and a **test bench** (below).

- **Frets (Frettes step) — the finger servos only.** Per string (string-tab strip), add
  **one finger servo per fret** (1..`maxFret`; frets need not be contiguous — gaps
  are allowed); a finger can be **geared** (one servo drives two frets: side A =
  `fret`, side B = `fretB`/`activeBUs`, neutral = both lifted). A clickable
  **coverage strip** shows which frets are equipped, geared (⚙) and calibrated;
  clicking a fret opens its **inline guided calibration** — set the contact / rest
  angle with a slider (previewed live on the servo), **test rest / press**, **play
  the note** (`POST /api/test/note`) and **mark it calibrated**. A geared finger
  calibrates three positions — **neutral / press A / press B** — each driven to its
  exact `us` pulse and held (`POST /api/test/servo` with `us`).

- **Plucking (Grattage step) — the plectrum and its helpers only.** Per string, calibrate
  the **pluck/strum** servo (rest + strike angle); a **strum** striker also exposes
  its **stroke shaping** (alternate up/down, up-stroke angle, stroke time, min strike
  depth). Optionally add a **strum lift** (lowers the plucker onto the string for a
  stroke, then raises it) and a **damper** (mutes the string). Global **auxiliary**
  actuators (`stringIndex = -1`) live here too. Test **rest / strike** and **pluck
  the open string**.

Each servo picks its signal **source** (shown in Advanced mode):
- **PCA9685** — choose `pcaBoard` (**0–7**, addresses 0x40–0x47), the **I²C bus**
  (`i2cBus` **0** = SDA/SCL, **1** = SDA2/SCL2) and `channel` (0–15). A compact
  channel-availability map flags a duplicate `board+channel` in red.
- **Direct GPIO** — choose a free ESP32 pin, filtered with the same green/yellow/red
  capability rules as the pin grid (reserved/USB pins hidden, caution pins
  Advanced-only, pins already used by a board signal or another servo excluded). At
  most **8 direct-GPIO servos** (one LEDC channel each).

**Two I²C buses.** The ESP32-S3 has two hardware I²C controllers, so the PCA9685
boards can be split across a second bus (`Wire1`, pins **SDA2/SCL2**) to halve the
bus traffic and refresh the servos faster on large instruments (many strings / many
boards). The Builder's **Wiring & capacity** step has a *Use a second I²C bus*
toggle with a **per-board Bus 0 / Bus 1** picker and an **Auto-split evenly** button;
the second bus's SDA2/SCL2 GPIOs are assigned in the **GPIO** sub-tab (default
GPIO38/39). You can also **separate the `/OE` safety line per bus** (a *Separate the
/OE per bus* toggle adds `SERVO_OE2`, default GPIO21) or keep a single shared `/OE`.
Each I²C bus addresses **up to 8 boards** (0x40–0x47), so two buses reach **16 boards
/ 256 channels**. Assignment is per physical board and is preserved when the wiring
is regenerated. The firmware drives **both controllers** (`Wire` = bus 0, `Wire1` =
bus 1), routing each board to its own bus and holding every configured `/OE` line in
the safe state — so bus 1 (and a split `/OE2`) work on real hardware.

The system works with **no PCA at all** (every servo on a direct GPIO) or any mix.
Per-string servos get their `stringIndex` set automatically. Each servo carries its
calibration (rest/active µs, pulse min/max, inverted, travelMs, settleMs,
disableAtRest).

## Playable fretboard (Instrument page)

Once the instrument is defined and calibrated, the **Instrument** page turns it into a
clickable **keyboard**. It draws the neck as a stylised instrument (headstock with
tuning pegs, wood fretboard, body with a soundhole) and lays out the strings and
fret wires **to scale**: the spacing between frets follows equal temperament (the
luthier's *rule of 18*, `d(n) = 1 − 2^(−n/12)`), so the neck compresses toward the
body exactly like a real fretboard.

- **Servos as pads** — every equipped fret shows its finger servo as a small
  rectangle on the string, just on the nut side of the fret wire (where a finger
  presses). A geared finger (one servo → two frets) shows a dashed pad on both frets.
  Frets with no servo are drawn but inert.
- **Press-and-hold to play** — pressing a fret with a servo drives its **finger servo**
  to the calibrated contact pulse and **sounds the string**; the played string lights
  up (colour change). **Releasing** lifts the finger back to rest. The zone left of the
  nut plays the **open string** (fret 0, no finger). Only one finger is held per string
  at a time (mirrors the firmware). Multi-touch plays several strings at once.
- **Play mode** — a selector exposes only the sounding options the wiring can perform:
  **Pluck** always; **Up-stroke** and **Alternate** when the string has a *strum* servo
  (with its up-stroke pulse); **Muted** when a *damper* is present (strike then damp for
  a short, staccato note). A *strum lift*, when present, is lowered for the stroke and
  raised again.

It drives the hardware through the same one-servo-at-a-time `POST /api/test/servo`
endpoint the wizard uses, so it works on the real device **once armed** (an Arm control
and armed/not-armed badge sit at the top) and fully **stand-alone** against the mock
backend. It reads the working **draft** profile, so an in-progress calibration can be
tried immediately. Leaving the tab (or a re-render) always lifts any held finger and
cancels pending strokes. An **All fingers up** button and the **STOP (panic)** button
provide a manual safety net.

## Wiring map (Câblage & GPIO page → Schéma de câblage)

The **Câblage & GPIO** page draws the current instrument's electrical harness as a
schematic, **as close to the real build as the profile allows** and fully
**adaptive** — every element is derived from the working `profile` (the same
draft the wizard edits), so the picture updates with each mechanical / pin /
servo choice made during creation. It shows (SPECIFICATION.md §7 / §11 / §22,
`hardware/wiring/WIRING.md`):

- the **ESP32-S3** module with its board-level signals (I²C **SDA**, **SCL**, the
  optional second-bus **SDA2**/**SCL2**, and the PCA9685 **/OE** safety line — plus
  **/OE2** when the /OE is split per bus) read from `profile.pins`;
- a **separate 5–6 V servo PSU** feeding the servo rail (never the ESP
  regulator);
- **one PCA9685 breakout per distinct `(i2cBus, pcaBoard)` chip** actually used, at
  its real I²C address (**0x40 + index**, set by the A0–A2 jumpers) with its **bus**
  shown when two are used, its **16 channels** in two clear columns, and every
  occupied channel labelled **pin → string·role** — the fret (`S1·f3`) for a finger,
  or `Pluck` / `Strum` / `Lift` (strum-lift) / `Damp` (damper) / `Aux`, so a board
  shared across strings stays unambiguous and the strum-lift/damper are explicit;
  the board header also lists the string(s) it serves;
- the shared **power buses**, **one or two I²C buses** (SDA/SCL for bus 0, SDA2/SCL2
  for bus 1) and the **/OE line(s)** (shared, or `/OE` + `/OE2` split per bus) every
  board taps in a band clearly separated from the boards; the ESP and board taps
  **interleave** (a half-pitch offset) so no two vertical leads coincide (junction
  dots mark a connection; crossings without a dot do not connect); wide harnesses
  scroll horizontally so the boards stay full-size instead of shrinking;
- any **direct-GPIO servos** wired straight to an ESP32 output pin.

It also flags real wiring faults live: a **duplicated `board+channel`**, two
servos (or a servo and a board signal) on the **same GPIO**, an **unassigned
SDA/SCL** (per bus) or **/OE** / **/OE2** while in use, and the firmware **capacity
limits** (**8 boards per I²C bus**, 8 direct servos). A **harness summary** (buses,
boards and addresses per bus, servo counts, signal pins) sits below the diagram. The
view is **read-only** — it drives no hardware, so there is nothing to arm — and a
**Download SVG** button saves the diagram (colours inlined) to take to the
workbench. Like the fretboard, the diagram scrolls horizontally on narrow screens.

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
