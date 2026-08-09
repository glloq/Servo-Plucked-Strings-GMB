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
password, network name, optional static IP, mDNS name. If the connection fails
several times, the system automatically reverts to access-point mode. A long
press on the **BOOT** button forces the hotspot back on at any time.

The wizard has **8 steps**: Instrument → Strings & tuning → **Frets** →
**Plucking** → MIDI → Power → Test → Validation. The frets (frettes) and the
plucking (grattage) of each string are configured on their **own steps**, so each
can be equipped, calibrated and tested on its own.

---

## 2. Step 1 — Instrument

Fill in: instrument name, description (optional), **instrument type** (ukulele,
guitar, bass, mandolin, banjo…) and **number of strings** (1 to 6). Picking a
type loads a proposed tuning **and** a full servo-per-fret wiring. This step
also holds **Board & network**: the board model (**ESP32-S3-DevKitC-1**, the
only supported board) and the network mode (access point / Wi-Fi client). These
values set the note range announced to General-Midi-Boop (see
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §3).

---

## 3. Step 2 — Strings & tuning

For each string, set its **open-string MIDI note** (fret 0) and its **highest
reachable fret** (`maxFret`). That is the entire per-string configuration — a
string is just an open pitch plus its top fret. There is no vibrating length,
transmission or steps/mm. The finger servos (frets) and the plucker (plucking)
are configured in the next two steps.

---

## 4. Step 3 — Frets (frettes)

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

## 5. Step 4 — Plucking (grattage)

This step configures the **plucking mechanism only** — the part that sounds the
string. For every string you can:

* **add a plucker** (pluck/strum servo) and set its **rest ↔ strike angle** and
  rotation direction;
* add an optional **strum lift** — it lowers the plucker onto the string for a
  stroke, then raises it (with an engage delay);
* add an optional **damper** — it presses the string to mute it;
* add global **auxiliary** actuators (not tied to a string).

By default the plucker sits on its string's PCA9685 board (channel `maxFret`).
Each actuator has **Test rest / strike** buttons and a **▶ Pluck open** button,
and a **test bench** plucks every open string, sweeps every plucker, and tests
the strum lifts / dampers. Every string needs a plucker to sound (the validation
step flags a string that has none).

---

## 6. Step 5 — MIDI

Global MIDI channel, Omni, sustain pedal, velocity curve, and **string/fret
selection**: `CC20` selects the string and `CC21` the fret before a `Note On`
(General-Midi-Boop tablature). The full CC/selection editor and the GMB
identity/capabilities live on the **MIDI tab** (see
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §2–3).

---

## 7. Step 6 — Power

The **current governor** limits PCA9685 in-rush current. Three combined
mechanisms: idle fingers cut their PWM (`disableAtRest`), only **one finger
presses per string at a time**, and the governor **staggers** how many servos
start moving together (`maxConcurrentMoves`, `staggerMs`) — important when a
chord re-frets several strings at once.

---

## 8. Step 7 — Test

Full-instrument test bench. Arm the mechanics, then play **each string** (its
open note and a fretted note) or run a **group test**: play every open string,
sweep every finger, sweep every plucker, run a scale on the active string, or
**test everything** end-to-end. A live status line shows progress and a **Stop**
button cancels the sequence. Keep the **STOP** (panic) button within reach
(software panic — see [`SAFETY.md`](SAFETY.md) §3).

---

## 9. Step 8 — Validation

The interface shows **"No problems found — ready to save"** or the precise list
of problems (pin conflicts, a PCA channel used twice, a string with no
plucker…). No actuator is enabled as long as critical errors remain. Once valid,
the configuration is saved (profile) and the capabilities are published to
General-Midi-Boop.

---

## 10. GPIO pins (the Pins tab)

Pin assignment is **not a wizard step** — it lives on the **GPIO Pins tab**.
**"Assign automatically"** places only the board-level signals a PCA9685 needs:
I²C `SDA = 40`, `SCL = 41`, and the PCA `/OE` safety line `SERVO_OE = 47`. There
are **no per-string STEP / DIR / HOME / ENABLE pins**. A direct-GPIO servo
carries its own pin in its servo entry (on the Frets or Plucking step), not here.
See [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md).

---

## 11. Connecting General-Midi-Boop (optional)

On the "MIDI > GMB identity and capabilities" page, apply the **General-Midi-Boop**
preset (CC20 = string, CC21 = fret, hybrid mode). GMB then automatically
discovers the instrument (identity, capabilities, strings) via SysEx. See
[`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) §2–3 and [`WEB_INTERFACE.md`](WEB_INTERFACE.md) §3.3.

---

## 12. Save and get going

Save your configuration as a profile (at least 8 slots), export it as JSON to
keep it, and set the startup profile. The Wi-Fi password is not included in
ordinary exports.

Enjoy your first note!
