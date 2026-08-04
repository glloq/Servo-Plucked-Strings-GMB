# Web interface — Servo-Plucked-Strings-GMB (servo-per-fret)

> Version **servo-par-frette** : un servo par frette, pas de moteur pas-à-pas.
> Guide utilisateur pas à pas : [`FIRST_CONFIGURATION.md`](FIRST_CONFIGURATION.md).
> Réglages : [`CALIBRATION.md`](CALIBRATION.md).

The interface is served from the ESP32 LittleFS (vanilla JS, no build). It also
runs from `file://` against a mock backend for development. Source and a fuller
map: [`../web-interface/README.md`](../web-interface/README.md).

## 1. Pages

| Tab | Purpose |
| --- | ------- |
| **Dashboard** | Live status: app state, Wi-Fi, active profile, per-string table (state, note, fret, finger, plucker, last fault), faults, STOP, *Reset & re-arm*. |
| **Setup Wizard** | 8-step configuration + guided install helper (below). |
| **GPIO Pins** | Assign SDA / SCL / SERVO_OE with per-pin capability filtering; auto-assign; validate. |
| **MIDI** | String/fret CC selection editor (all `SelectorConfig` fields), GMB preset, mapping editor, test tool, live MIDI monitor. |
| **GMB / SysEx** | Capability snapshot and SysEx request tester. |
| **Profiles** | Device slots (save/load/read/delete/startup), import/export JSON, Wi-Fi passwords. |

## 2. Setup wizard (8 steps)

Instrument → Strings → **Servos & frets** → **Install helper** → MIDI → Power →
Test → Validation. The per-fret servo editor sets each finger's source
(PCA `board+channel` or direct GPIO), contact angle, and rotation direction, with
live test buttons; the install helper walks the frets one by one. Details in
[`FIRST_CONFIGURATION.md`](FIRST_CONFIGURATION.md).

## 3. Dashboard fields

Per string: index, open note, state, current note, current fret, finger
(up/down), plucker (rest/strike), last fault. (There is no carriage position /
HOME / LIMIT — servo-per-fret has no stepper.)

## 4. REST + WebSocket API

WebSockets: `/ws/status` (per-string status push), `/ws/midi` (MIDI monitor).

| Method + path | Purpose |
| --- | --- |
| `GET /api/status` | one-shot status |
| `GET /api/profile` · `PUT /api/profile` | read / save-and-publish the working profile |
| `GET /api/profiles` · `POST /api/profiles` | slot list / save to slot |
| `POST /api/profiles/load` · `/read` · `/delete` | activate / read-without-activate / delete a slot |
| `POST /api/reset` | recover from panic and re-arm (parks fingers; no homing) |
| `GET /api/board/:id` | board GPIO capability map |
| `POST /api/pins/auto` · `/api/pins/validate` | auto-assign / validate pins |
| `POST /api/panic` | emergency stop |
| `POST /api/test/note` | play a note `{channel,note,velocity,durationMs}` |
| `POST /api/test/servo` | press/release one servo `{index, active}` (install helper) |
| `GET /api/commands?id=N` | poll an async command outcome |
| `POST /api/wifi` · `/api/auth` | Wi-Fi passwords / admin token |
| `POST /api/storage/format` | reformat LittleFS |
| `POST /api/sysex/request` | send a SysEx request, get the decoded response |
| `GET /api/capabilities` | computed capability snapshot |

> There is **no** `/api/test/jog` and **no** `/api/test/endstop`: servo-per-fret
> has no carriage or HOME/LIMIT sensors.

Every mutating request is authenticated once an admin token is set (`X-GMB-Token`);
`/api/panic` stays unauthenticated for safety.
