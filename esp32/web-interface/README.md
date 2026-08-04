# Servo-Plucked-Strings-GMB — Web configuration interface

Local, self-contained web app served from the ESP32's LittleFS. Vanilla JS (no
build step, no external assets), so it also runs straight from `file://` for
development thanks to a built-in **mock backend** in `js/api.js`.

At runtime the ESP32 first boots a Wi-Fi access point (default SSID
`Servo-Plucked-Strings-GMB`); connect and open the device address in a browser.

## Pages

| Tab | Module | Purpose |
| --- | ------ | ------- |
| Dashboard | `dashboard.js` | Live per-string state (state, note, fret, finger, plucker), faults, Wi-Fi, STOP, reset/re-arm. |
| Setup Wizard | `wizard.js` | 8-step configuration + the guided **install helper**. |
| GPIO Pins | `pins.js` | Assign the board pins (SDA / SCL / SERVO_OE) with capability filtering. |
| MIDI | `midiselect.js` + `midimonitor.js` | String/fret CC selection editor, GMB preset, test tool, live MIDI monitor. |
| GMB / SysEx | `sysex.js` | Capability snapshot / SysEx tester. |
| Profiles | `profiles.js` | Device slot storage, import/export JSON, Wi-Fi passwords. |

## Setup wizard — 8 steps

1. **Instrument** — name, type (loads a tuning + servo-per-fret wiring), string
   count, capo; board & network.
2. **Strings** — per string: open note, max fret, enabled; auto-wire fingers.
3. **Servos & frets** — per string, one row per fret: add/remove a finger servo,
   pick its source (PCA board+channel or direct GPIO), set the **contact angle**
   and **rotation direction**, and test it live. Plus the plucker editor and a PCA
   channel map.
4. **Install helper** — guided, fret-by-fret calibration: press the finger, adjust
   the contact angle with a slider (live), test the note, save, next fret.
5. **MIDI** — channel/omni/velocity curve; link to the full CC selection editor.
6. **Power** — the current governor (`maxConcurrentMoves`, `staggerMs`) and note
   timing.
7. **Test** — play a note per string; STOP.
8. **Validation** — client-side checks before saving.

## REST endpoints used

Read: `GET /api/status`, `/api/profile`, `/api/profiles`, `/api/board/:id`,
`/api/capabilities`, `/api/commands?id=N`. WebSockets: `/ws/status`, `/ws/midi`.

Write: `PUT /api/profile` (save & publish), `POST /api/profiles`,
`/api/profiles/load`, `/api/profiles/read`, `/api/profiles/delete`,
`/api/pins/auto`, `/api/pins/validate`, `/api/panic`, `/api/reset`,
`/api/test/note`, `/api/test/servo` (press/release one servo — used by the install
helper), `/api/sysex/request`, `/api/wifi`, `/api/auth`, `/api/storage/format`.

> Servo-per-fret has **no** stepper jog or endstop routes — there is no
> `/api/test/jog` or `/api/test/endstop`. Per-fret finger calibration uses
> `POST /api/test/servo`.

## Servo model in the UI

Each servo entry: `function` (finger/pluck/strum/strumLift/damper/sharedDamper/aux),
`stringIndex`, `fret` (finger only, 1..24), `source` (`pca` with `pcaBoard` 0..7 /
`channel` 0..15, or `gpio`), pulse window, rest/contact positions (shown as
degrees, stored as µs), `inverted`, travel/settle, `disableAtRest`, and — for
strikers — the stroke-shaping fields (`alternateDirection`, `activeAltUs`,
`strokeMs`, `minStrikeUs`, `engageDelayMs`).

## Development

Open `index.html` directly (mock backend) to work on the UI without hardware. On
device, `firmware/sync_web_data.sh` copies this folder into the LittleFS image
(`firmware/data/www`), uploaded with `pio run -t uploadfs`.
