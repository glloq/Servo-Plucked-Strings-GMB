# First configuration guide — Servo-Plucked-Strings-GMB

> Source: `SPECIFICATION.md` §8, §10, §26 (first configuration guide).
> Related documents: [`WEB_INTERFACE.md`](WEB_INTERFACE.md) · [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) · [`CALIBRATION.md`](CALIBRATION.md) · [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) · [`SAFETY.md`](SAFETY.md).

This guide walks a beginner from first power-on to the first note, using only
the **simplified mode** of the Web interface. No code modification is needed.

---

## 0. Before you begin

* Power the board and the servos on their recommended rails (a 5–6 V servo
  supply plus 3.3 V logic — there is no 24 V rail; see [`SAFETY.md`](SAFETY.md)
  §6). **Never power the servos from the ESP32 regulator.**
* At startup, the system is in a safe state: the PCA9685 outputs are disabled
  through `/OE`, servos are neutralized, MIDI queues are empty (see
  [`SAFETY.md`](SAFETY.md) §1). Nothing moves until the configuration has been
  validated and the instrument is armed.

---

## 1. Connecting to the interface

At first power-on, the ESP32 starts in **access-point mode**:

```text
Default SSID: Servo-Plucked-Strings-GMB
```

1. Connect your phone/computer to this Wi-Fi network.
2. Open the local address shown (or the captive portal).
3. The configuration wizard opens.

You can later switch to **client mode** (the ESP32 joins your network): SSID,
password, and the mDNS host name (used as `<hostname>.local`). The address is
obtained by DHCP — a fixed static IP is not currently configurable. If the
connection fails several times, the system automatically reverts to access-point
mode. A long press on the **BOOT** button forces the hotspot back on at any time.

The whole setup is **one ordered flow on the Setup page** — **7 steps**:
**Instrument** → **Frets** → **Plucking** → MIDI → Timing → Test → Validation. Step 1
(the Instrument builder) makes the *mechanical* choices and generates the wiring; the
frets (frettes) and the plucking (grattage) of each string are then calibrated and
tested on their **own steps**, all without leaving the page.

---

## 2. Step 1 — Instrument

Pick a starting point and name your instrument — the mechanics are set per-servo on
the Frets / Plucking steps, so this first screen stays short:

* **Starting point** — pick a **preset** (ukulele, guitar, bass, mandolin, banjo)
  to load a tuning + GM tags, or **Custom** for your own. The type only tags the
  name / GM program.
* **Strings & tuning** — **number of strings** (1–6), each string's
  **open-string MIDI note** (fret 0) and **highest reachable fret** (`maxFret`).
  A string is just an open pitch plus its top fret.
* **Board** — the **ESP32 board selector** (ESP32-S3-DevKitC-1 · ESP32-WROOM-32 ·
  ESP32 DevKit v1) plus the native-USB reserve. Wi-Fi / hostname are **not** here —
  they live in the gear modal (⚙ Network), because they belong to the device.

A preset produces a working instrument and the wiring is generated automatically;
changing the string count or a max fret re-generates it. The tuning sets the note
range announced to General-Midi-Boop (see [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §3).

---

## 3. Step 2 — Frets (frettes)

This step sets up the **finger servos** — the part that presses the string against a
fret. A clickable **coverage strip** shows which frets carry a servo (geared marked
⚙). **Tap a fret** to open its **servo div**, where everything for that servo lives
in one place:

* **One servo drives 2 frets (geared)** — a toggle that pairs this fret with the
  next through a gear (`fretB` + `activeBUs`), to halve the servo count on the wide
  low frets (see [`GEARED_FINGERS.md`](GEARED_FINGERS.md));
* the **PCA board** (address 0x40–0x47) and **PCA pin** (channel 0–15) the servo
  plugs into;
* the **angle(s)** on precise **− / + steppers** (1° each) — a plain finger has a
  **contact** and a **rest** angle; a **geared** servo has one press angle **per
  fret**, and its **rest sits at their midpoint automatically** (both fingers lifted);
* the **rotation direction** (`inverted`), so the servo can be mounted either way.

**Arm the instrument first** (servo tests are refused until armed): every − / + step
drives the servo to that exact angle so it previews live, and the **play** buttons
sound the note. A geared fret's paired row shows *"paired with fret N on one geared
servo"* and is adjusted on the owner row. A **test bench** sweeps every fret of the
string, or of all strings, in one click. See [`CALIBRATION.md`](CALIBRATION.md).

---

## 4. Step 3 — Plucking (grattage)

This step sets up the **sounding servo** — the part that plucks the string. There is
**one per string**; calibrate its positions directly:

* the **contact angle** — the plectrum resting against the string;
* the **down-stroke angle** — the stroke end on one side of contact;
* the **up-stroke angle** — the stroke end on the other side, shown when
  **Alternate stroke direction** is enabled (successive notes then sweep
  down/up). Alternation is a per-plectrum choice, never forced;
* **Reverse rotation direction** mirrors the output for a mirrored mounting;
* **Travel** and **Settle** set the servo's motion timing.

A **Mute** card configures Note-Off damping: the global mute source (auto /
plectrum / damper / descent servo / none), the **mute hold** time, and — when the
plectrum itself damps — its **mute angle** against the string. The **Gesture**
card sets the global **stroke duration** and **minimum strike depth** shared by
every string. Pick the servo's **PCA board + pin**, then optionally add a
**descent servo** (`strumLift`, with rest/play angles, direction, travel, engage
delay and the lower-to-play / raise-to-play engagement) and a **damper servo**
(rest/damp angles, direction, travel).

By default the sounding servo sits on its string's PCA9685 board. Each position has a
live test (→ contact / → down-stroke / → up-stroke / → mute, ▶ Pluck open), and a
**test bench** plucks every open string and sweeps the strum servos. Every string
needs a sounding servo (the validation step flags a string that has none). The two
global delays — the **action delay** (a fixed-time FIFO buffer) and the **fret →
strum delay** — are set once on the **Timing** step, not here.

---

## 5. Step 4 — MIDI

Global MIDI channel, Omni, sustain pedal, velocity curve, and **string/fret
selection**: `CC20` selects the string and `CC21` the fret before a `Note On`
(General-Midi-Boop tablature). The full CC/selection editor is on this step in
**Advanced** mode; the GMB identity/capabilities and the live MIDI monitor are in
the gear modal (Advanced) — see [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §2–3.

---

## 6. Step 5 — Timing

Two cards. **Timing** sets the two global delays: the **action delay** — a
fixed-time FIFO buffer (`noteExecutionDelayMs`) that holds every incoming note by
the same amount so chords land together and the feel stays even — and the
**fret → strum delay** (`fretToPluckMs`) that waits after a finger has seated a
fret before the plectrum strikes (plus the strum **lead**). **Current management**
is an **optional** governor (a toggle turns it off): it limits PCA9685 in-rush
current by staggering how many servos start moving at once. When on you cap the
starts **whole-instrument** (`maxConcurrentMoves`) and **per PCA board**
(`maxConcurrentPerBoard`) — each **0 = no cap**, and each physical board has its own
power input, so the per-board cap bounds one board's in-rush even under the global
one — spaced by `staggerMs`. (Idle fingers already cut their PWM and only one finger
presses per string at a time.)

---

## 7. Step 6 — Test

Full-instrument test bench. Arm the mechanics, then play **each string** (its
open note and a fretted note) or run a **group test**: play every open string,
sweep every finger, sweep every plucker, run a scale on the active string, or
**test everything** end-to-end. A live status line shows progress and a **Stop**
button cancels the sequence. Keep the **STOP** (panic) button within reach
(software panic — see [`SAFETY.md`](SAFETY.md) §3).

---

## 8. Step 7 — Validation

The interface shows **"No problems found — ready to save"** or the precise list
of problems (pin conflicts, a PCA channel used twice, a string with no
plucker…). No actuator is enabled as long as critical errors remain. Once valid,
the configuration is saved (profile) and the capabilities are published to
General-Midi-Boop.

---

## 9. GPIO pins (the Pins tab)

Pin assignment is **not a wizard step** — it lives on the **GPIO Pins tab**.
**"Assign automatically"** places only the board-level signals a PCA9685 needs:
I²C `SDA = 40`, `SCL = 41`, and the PCA `/OE` safety line `SERVO_OE = 47`. There
are **no per-string STEP / DIR / HOME / ENABLE pins**. A direct-GPIO servo
carries its own pin in its servo entry (on the Frets or Plucking step), not here.
See [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md).

---

## 10. Connecting General-Midi-Boop (optional)

On the "MIDI > GMB identity and capabilities" page, apply the **General-Midi-Boop**
preset (CC20 = string, CC21 = fret, hybrid mode). GMB then automatically
discovers the instrument (identity, capabilities, strings) via SysEx. See
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §2–3 and [`WEB_INTERFACE.md`](WEB_INTERFACE.md) §3.3.

---

## 11. Save and get going

Save your configuration as a profile (at least 8 slots), export it as JSON to
keep it, and set the startup profile. The Wi-Fi password is not included in
ordinary exports.

Enjoy your first note!
