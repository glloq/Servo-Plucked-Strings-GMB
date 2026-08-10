# Hardware — reference electronics

Reference electronics for the **ESP32 servo-per-fret** version of
Servo-Plucked-Strings-GMB: an ESP32-S3 MIDI instrument where **every fret
position has its own servo** and a per-string plucker sets the string vibrating
(1–6 strings). There is **no stepper motor, no carriage and no homing** — those
belong to the separate reference project
[`Stepper-Plucked-Strings-GMB`](https://github.com/glloq/Stepper-Plucked-Strings-GMB).
This document covers the electronics of SPECIFICATION.md §7; the wiring guide,
bill of materials and CAD deliverables live alongside it.

## Directory

```
hardware/
├── README.md          ← this file (electronics overview, §7)
├── BOM.md             ← bill of materials / nomenclature (§26)
├── wiring/
│   └── WIRING.md      ← connection guide, pinout, power rails (§7 / §22)
├── schematics/
│   └── README.md      ← schematic placeholder
└── pcb/
    └── README.md      ← PCB placeholder
```

## Block diagram (§7)

```text
                         Wi-Fi
                           │
               MIDI + web configuration
                           │
                           ▼
                       ESP32-S3
                           │
              ┌────────────┴────────────┐
              │                         │
             I²C                   free GPIO (LEDC)
              │                         │
       1–8 × PCA9685             direct-GPIO servos
       (0x40 … 0x47)             (up to 8, optional)
              │
      finger + pluck servos
```

Every servo picks its own source, so an instrument can be built **with a
PCA9685, without one (direct GPIO), or with a mix of both**.

## Major blocks

### Main controller — ESP32-S3 (§7.1)

The reference controller is an **ESP32-S3-DevKitC-1**. It handles Wi-Fi MIDI
transport, hosts the web configurator, allocates notes, sequences the per-string
release → press → settle → pluck motions, drives the servos (over the PCA9685 or
directly), stores profiles, and enforces safety. Its flexible GPIO matrix is what
makes the configurable board profiles and pin assignment possible
(`board-profiles/esp32-s3-devkitc-1.json`).

### Servo drive — PCA9685 and/or direct GPIO (§7.3)

Fingers and pluckers are hobby servos. Each servo is driven from **one of two
sources**, chosen per servo in the web interface:

* **PCA9685** — a 16-channel PWM/servo expander on I²C. Up to **eight boards**
  at addresses **0x40 … 0x47** (128 channels). The recommended wiring is **one
  PCA9685 per string**: a string's fret fingers plus its plucker fit on ≤ 16
  channels, and spreading strings across boards spreads the current draw.
* **Direct GPIO** — the servo hangs off a free ESP32-S3 output pin driven by the
  LEDC peripheral (50 Hz PWM). Up to **eight** direct servos (the S3 has 8 LEDC
  channels). Handy with no PCA, or for a handful of servos.

The two mix freely on the same instrument.

### Safety line — PCA9685 `/OE` (§21)

The PCA9685 `/OE` (output-enable, active-low) pins are tied together to a single
**safety GPIO** (`SERVO_OE`, GPIO47 by default) so every PCA servo can be
neutralised instantly on panic or emergency stop. Direct-GPIO servos are detached
(PWM released) on stop. The firmware holds `/OE` high (outputs off) at boot and
until the configuration is validated and the instrument is armed (§21.1–21.3).

## Power (summary, §22)

Two rails; servos on a **separate** supply from the ESP32 regulator:

| Rail | Feeds |
| ---- | ----- |
| 5–6 V | servomotors (PCA9685 `V+` and/or direct servos), sized to the servo count |
| 3.3 V | ESP32-S3 logic (on-board regulator) |

Fusing on the servo rail, reverse-polarity protection, and a bulk reservoir
capacitor across each PCA9685 `V+` are required — see `wiring/WIRING.md` §Power.
A servo-per-fret instrument has **many** servos (see Capacity), so size the 5–6 V
supply for the worst-case simultaneous inrush; the firmware's current management
(idle-PWM cut-off, one finger per string at a time, staggered starts) keeps that
peak bounded.

## Capacity (§6)

| Resource | Min | Max |
| -------- | :-: | :-: |
| Strings | 1 | 6 |
| Finger servos per string | 0 | one per fret (frets need not be contiguous) |
| Pluck / strum servos per string | 1 | 1 |
| Optional per-string strumLift / damper | 0 | 1 each |
| PCA9685 boards | 0 | 8 (0x40 … 0x47) |
| Direct-GPIO servos | 0 | 8 (LEDC channels) |

A single **geared** finger servo can drive **two** frets of the same string, to
halve the servo count on the wide low frets (see
[`../docs/GEARED_FINGERS.md`](../docs/GEARED_FINGERS.md)).

Invariant: **one finger pressed per string at a time** — the firmware releases
the current finger before pressing the next, so a string never fights itself.
