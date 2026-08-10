# Mechanics — reference architecture

Reference mechanical architecture for the **ESP32 servo-per-fret** version of
Servo-Plucked-Strings-GMB (SPECIFICATION.md §5), and how each mechanical choice
maps to the profile fields (`firmware/src/core/configuration/StringConfig.h`,
`ServoConfig` in `Profile.h`, `instrument-profiles/`).

There is **no stepper, no carriage, no transmission and no homing** — a string
does not *move* a finger to a position; instead **each fret has its own finger
servo** that presses straight onto the string. (The stepper/carriage machine is
the separate reference project `Stepper-Plucked-Strings-GMB`.)

## 1. One independent channel per string (§5.1)

Every string is a self-contained channel: a bank of **finger servos — one per
equipped fret** — and its **own plucker**. To play a note the firmware releases
the currently pressed finger, presses the target fret's finger, lets it settle,
then plucks:

```text
        one string
   [finger fret1] [finger fret2] [finger fret3] …      ← one servo each
   ═════●═════════════●═════════════●══════════════     ← the string
   0     1             2             3   (fret positions)
   └─ pluck servo (per string) sets the string vibrating
```

Equipped frets **need not be contiguous** (e.g. frets {1, 2, 3, 5, 7, 12}); fret
0 is the open string and never carries a servo. Which frets exist is derived from
the servo list, not from a range.

Hard invariant (§4, §6): **one finger pressed per string at a time**. The firmware
releases the old finger before pressing the new one, so a string never fights
itself and only one press-load is ever active per string.

## 2. Finger press (§5.2)

A finger servo presses the string at its fret and lifts off it. In the profile
this is a servo with `function: "finger"` carrying its `fret`, using `restUs`
(lifted) and `activeUs` (pressed), plus `travelMs`/`settleMs` timing and
`disableAtRest` (cut PWM once lifted, so an idle finger draws ~0 A).

Open string: no finger is pressed; the note is plucked directly.

**Geared (paired) fingers.** To cut the servo count on the wide low frets, one
servo can drive **two antagonistic fingers** through a gear/rocker: it presses
fret `fret` at `activeUs` (side A) and fret `fretB` at `activeBUs` (side B), and
lifts BOTH at `restUs` (neutral). Since a string only ever frets one note at a
time, pairing two of its frets adds no play conflict. Narrow high frets keep a
plain one-servo finger (`fretB = -1`); the two mechanisms mix per servo. See
[`../docs/GEARED_FINGERS.md`](../docs/GEARED_FINGERS.md).

## 3. Setting the string vibrating (§5.3)

Each string is set vibrating by **its own** actuator — there is no shared
strummer; strumming is per string:

* **Individual pluck** — one pluck actuator per string (`function: "pluck"`).
  Enables chords, repeated notes, per-string tremolo and velocity, and precise
  per-string triggering.
* **Per-string strum** — a per-string strum servo (`function: "strum"`) with an
  optional **`strumLift`** that lowers it onto the string for a stroke and raises
  it after (`engageDelayMs` = extra pause once down). Supports up/down alternating
  strokes (`alternateDirection`, `activeAltUs`), adjustable stroke time
  (`strokeMs`) and a minimum strike depth (`minStrikeUs`).

An optional per-string **`damper`** servo can mute the string, and one or more
global **`aux`** servos cover any other auxiliary actuator. Velocity scales the
strike depth between `restUs` and `activeUs`.

## 4. Servo signal source: PCA9685 or direct GPIO

Every servo picks its own source, so an instrument can be built **with or without
a PCA9685**, or with a mix of both:

* **PCA9685** — up to **eight boards** (`pcaBoard` 0–7, I²C 0x40–0x47 = 128
  channels). The recommended convention is one board per string. Use PCA once you
  exceed the ESP32's handful of free servo pins — which a full fretboard quickly
  does.
* **Direct GPIO** — the servo hangs off a free ESP32-S3 pin (LEDC 50 Hz PWM),
  up to **eight** direct servos; handy with no PCA or for a couple of servos.

The web interface exposes this choice per servo and only offers pins/channels
that are free and capable, so it cannot create a conflict (see
[`../docs/CALIBRATION.md`](../docs/CALIBRATION.md) §4).

## 5. Fret layout (physical build aid)

The firmware needs no geometry — it only needs to know **which frets carry a
servo**. For laying out where to mount each finger, the theoretical fret position
along the string follows equal temperament:

```text
position(fret) = scaleLengthMm × (1 − 2^(−fret / 12))
```

This is a build-time reference for the mechanics only; the firmware never
computes millimetres or moves to a position.

## 6. Parameter → profile-field mapping

**String** (`strings[]`, `StringConfig`):

| Quantity | Field | Notes |
| -------- | ----- | ----- |
| String enabled | `enabled` | |
| Open-string note | `openNote` (MIDI) | fret 0 |
| Highest reachable fret | `maxFret` | ceiling for finger frets |

**Servo** (`servos[]`, `ServoConfig` — one entry per finger and per plucker):

| Quantity | Field | Applies to |
| -------- | ----- | ---------- |
| Role | `function` (`finger`/`pluck`/`strum`/`strumLift`/`damper`/`aux`) | all |
| Owning string | `stringIndex` (−1 = global) | all |
| Fret pressed | `fret` (side A), `fretB` (geared side B) | finger |
| Signal source | `source` (`pca`/`gpio`) | all |
| PCA location | `pcaBoard` (0–7), `channel` (0–15) | source = pca |
| Direct pin | `gpio` | source = gpio |
| Pulse window | `pulseMinUs`, `pulseMaxUs` | all |
| Lifted / pressed pulse | `restUs`, `activeUs`, `activeBUs` (geared side B) | all |
| Direction sense | `inverted` | all |
| Motion / settle timing | `travelMs`, `settleMs` | all |
| Cut PWM when idle | `disableAtRest` | all |
| Stroke shaping | `alternateDirection`, `activeAltUs`, `strokeMs`, `minStrikeUs` | pluck/strum |
| Strum-lift pause | `engageDelayMs` | strumLift |

A failing servo axis is faulted at runtime without disturbing the others
(§13.2): the note allocator simply stops routing to it.
