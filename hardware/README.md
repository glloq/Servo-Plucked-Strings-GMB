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
├── README.md            ← this file (electronics overview + CAPACITY — the
│                          single source of truth for the limits)
├── BOM.md               ← bill of materials with mandatory/recommended status (§26)
├── POWER_AND_SAFETY.md  ← reference circuit: power tree, fuses, E-stop chain,
│                          fail-safe /OE (§21/§22)
├── I2C_PCA9685.md       ← I²C addressing, two-bus topology, pull-up rules
├── COMMISSIONING.md     ← staged electrical acceptance procedure
├── wiring/
│   └── WIRING.md        ← connection guide, pinout (§7 / §22)
├── schematics/
│   ├── README.md                      ← schematic set index
│   ├── 01-power-distribution.md
│   ├── 02-estop-and-servo-enable.md
│   └── 03-esp32-pca9685-one-string.md
└── pcb/
    └── README.md        ← PCB placeholder
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
              ┌────────────┼─────────────────┐
              │            │                 │
           I²C bus 0    I²C bus 1        free GPIO (LEDC)
              │         (optional)           │
      up to 8 × PCA9685  up to 8 more   direct-GPIO servos
      (0x40 … 0x47)      (own 0x40…0x47)  (up to 8, optional)
              │            │
          finger + pluck servos
```

Every servo picks its own source, so an instrument can be built **with a
PCA9685, without one (direct GPIO), or with a mix of both**.

## Capacity (§6) — single source of truth

Every other document (BOM, wiring, schematics, web UI) refers to THIS table;
do not restate the numbers elsewhere.

| Resource | Min | Max |
| -------- | :-: | :-: |
| Strings | 1 | 6 |
| Finger servos per string | 0 | one per fret (frets need not be contiguous) |
| Pluck / strum servos per string | 1 | 1 |
| Optional per-string strumLift / damper | 0 | 1 each |
| I²C buses | 1 | 2 (`Wire` + `Wire1`) |
| PCA9685 boards **per bus** | 0 | 8 (0x40 … 0x47) |
| PCA9685 boards total | 0 | **16** (= 256 channels over 2 buses) |
| Direct-GPIO servos | 0 | 8 (LEDC channels) |

A single **geared** finger servo can drive **two** frets of the same string, to
halve the servo count on the wide low frets (see
[`../docs/GEARED_FINGERS.md`](../docs/GEARED_FINGERS.md)).

Invariant: **one finger pressed per string at a time** — the firmware releases
the current finger before pressing the next, so a string never fights itself.

## Major blocks

### Main controller — ESP32-S3 (§7.1)

The reference controller is an **ESP32-S3-DevKitC-1**. It handles Wi-Fi MIDI
transport, hosts the web configurator, allocates notes, sequences the per-string
release → press → settle → pluck motions, drives the servos (over the PCA9685 or
directly), stores profiles, and enforces safety. Its flexible GPIO matrix is what
makes the configurable board profiles and pin assignment possible.

> ⚠️ The DevKitC-1 exists in **two revisions** with the on-board RGB LED on
> different pins: **v1.0 → GPIO48**, **v1.1 → GPIO38**. Each has its own board
> profile (`board-profiles/esp32-s3-devkitc-1.json`,
> `board-profiles/esp32-s3-devkitc-1-v1.1.json`) — pick the one matching your
> silkscreen, or the LED pin will be offered as a free GPIO.

### Servo drive — PCA9685 and/or direct GPIO (§7.3)

Fingers and pluckers are hobby servos. Each servo is driven from **one of two
sources**, chosen per servo in the web interface:

* **PCA9685** — a 16-channel PWM/servo expander on I²C (addresses, jumpers and
  pull-up rules: [`I2C_PCA9685.md`](I2C_PCA9685.md)). The recommended wiring is
  **one PCA9685 per string**: a string's fret fingers plus its plucker fit on
  ≤ 16 channels, and spreading strings across boards spreads the current draw.
* **Direct GPIO** — the servo hangs off a free ESP32-S3 output pin driven by the
  LEDC peripheral (50 Hz PWM). Handy with no PCA, or for a handful of servos.

The two mix freely on the same instrument (capacity table above).

### Safety subsystem — E-stop chain + `/OE` (§21)

Safety is a **subsystem**, not a pin: a latching NC E-stop button that drops
the servo-rail contactor **and** feeds the firmware's `ESTOP` status input, and
a **fail-safe `/OE` line** (external pull-up, optional gated enable stage) so
the PCA outputs are off whenever the ESP32 is absent, resetting, or the chain
is open. Direct-GPIO servos are detached (PWM released) on stop — and only the
power cut stops them at the hardware level. The full reference circuit is
[`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md); the firmware behaviour is
[`../docs/SAFETY.md`](../docs/SAFETY.md). The firmware holds `/OE` high
(outputs off) at boot and until the configuration is validated and the
instrument is armed (§21.1–21.3).

## Power (summary, §22)

Two rails; servos on a **separate** supply from the ESP32 regulator:

| Rail | Feeds |
| ---- | ----- |
| 5–6 V | servomotors (PCA9685 `V+` and/or direct servos), sized to the servo count |
| 3.3 V | ESP32-S3 logic, PCA9685 `VCC`, `/OE` pull-up (on-board regulator) |

The reference distribution — main fuse, master switch, E-stop contactor, star
block, per-branch fuses and bulk capacitors, and the sizing method — is
[`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md) §1. A servo-per-fret instrument
has **many** servos (see Capacity), so size the 5–6 V supply for the worst-case
simultaneous inrush; the firmware's current management (idle-PWM cut-off, one
finger per string at a time, staggered starts) keeps that peak bounded but is
no substitute for a properly sized supply.
