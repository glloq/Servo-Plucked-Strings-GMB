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

## 2. Step 1 — Instrument Builder

The instrument **type is cosmetic** — an instrument is defined by its
**mechanics**. This one adaptive screen makes those choices explicit and
**generates the servo wiring** for you:

* **Starting point** — pick a **preset** (ukulele, guitar, bass, mandolin, banjo)
  to load a tuning + GM tags, or **Custom** for your own. The type only tags the
  name / GM program.
* **Strings & tuning** — **number of strings** (1–6), each string's
  **open-string MIDI note** (fret 0) and **highest reachable fret** (`maxFret`).
  A string is just an open pitch plus its top fret — no vibrating length,
  transmission or steps/mm.
* **Fretting mechanism** — **one servo per fret** (full chromatic) ·
  **geared low neck** (pair the wide low frets on one antagonistic servo each,
  narrow high frets stay single — halves the low-neck servo count) ·
  **open-string-only** (no frets) · **custom** (keep the current hand-tuned
  wiring). Each option shows its **live finger-servo count**.
* **Sounding mechanism** — individual **pick** (a plectrum per string) vs
  per-string **strum**, plus optional **strum-lift** and **per-string damper**.
* **Wiring & capacity** — one PCA9685 board per string by default, with a
  **capacity meter** (channels per board vs 16, boards vs 8, direct-GPIO vs 8).
* **Generate wiring** — builds the servo list from the choices; a *pending* pill
  appears when the committed wiring no longer matches. Auxiliary servos and any
  string still classified *custom* are preserved.

Advanced mode adds transpose / GM tags and a **Board** card — the **ESP32 board
selector** (ESP32-S3-DevKitC-1 · ESP32-WROOM-32 · ESP32 DevKit v1) plus the
native-USB reserve. Wi-Fi / hostname are **not** here — they live in the gear modal
(⚙ Network), because they belong to the device, not the instrument. The tuning sets
the note range announced to General-Midi-Boop (see
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §3). The mechanical choice is **not stored**
in the profile — the builder re-derives it from the servo list on entry.

---

## 3. Step 2 — Frets (frettes)

This step configures the **finger servos only** — the part that presses the
string against a fret. Each fret position has its **own dedicated finger servo**.
For every string (string-tab strip) you can:

* **equip any fret** — gaps are allowed (for example frets 1, 3, 5, 12);
* set each finger's **rest ↔ contact angle** and its **rotation direction**
  (`inverted`), so the servo can be mounted either way;
* **gear a finger** — one servo drives two adjacent frets of the same string
  through antagonistic fingers (`fretB` + `activeBUs`, neutral = both lifted),
  to halve the servo count on the wide low frets (see
  [`GEARED_FINGERS.md`](GEARED_FINGERS.md));
* choose the **signal source per servo** (Advanced) — a **PCA9685** channel *or*
  a **direct ESP32 GPIO**, mixable on the same instrument.

A clickable **coverage strip** shows which frets are equipped, geared and
calibrated. Clicking a fret opens its **inline guided calibration**: **arm the
instrument first** (servo tests are refused until armed), adjust the contact and
rest angles until the finger cleanly frets the string (each move previewed live),
**test rest / press**, **play the note**, then **mark it calibrated**. A geared
finger calibrates three positions — neutral (both lifted), side A, side B. A
**test bench** sweeps every fret of the string, or of all strings, in one click.
See [`CALIBRATION.md`](CALIBRATION.md). The default wiring is **one PCA9685 per
string**: that string's fret fingers on channels `0 … maxFret−1`.

---

## 4. Step 3 — Plucking (grattage)

This step configures the **plucking mechanism only** — the part that sounds the
string. Every striker uses the **same model**, only the angles change with the
mounting: the plectrum **rests against the string** (contact angle, e.g. 90°)
ready to strum, then sweeps to the **down-stroke** and **up-stroke** angles on
either side (e.g. ±20°) for alternating strokes. For every string you can:

* **add a plucker** (pluck/strum servo) and set its **contact / down-stroke /
  up-stroke angles** and rotation direction (the up-stroke angle may be left at 0
  to mirror the down-stroke about contact);
* add an optional **strum lift** — it lowers the plucker onto the string for a
  stroke, then raises it (with an engage delay);
* add an optional **damper** — it presses the string to mute it;
* add global **auxiliary** actuators (not tied to a string).

By default the plucker sits on its string's PCA9685 board (channel `maxFret`).
Each actuator has **Contact / Down-stroke / Up-stroke** test buttons and a
**▶ Pluck open** button, and a **test bench** plucks every open string, sweeps
every plucker, and tests the strum lifts / dampers. Every string needs a plucker
to sound (the validation step flags a string that has none). The two global
delays — the **action delay** (a fixed-time FIFO buffer) and the **fret → strum
delay** — are set once on the **Timing** step, not here.

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
limits PCA9685 in-rush current: idle fingers cut their PWM (`disableAtRest`), only
**one finger presses per string at a time**, and the governor **staggers** how
many servos start moving together (`maxConcurrentMoves`, `staggerMs`) — important
when a chord re-frets several strings at once.

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
