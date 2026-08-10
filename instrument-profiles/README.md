# Instrument profiles

Example configuration profiles for **Servo-Plucked-Strings-GMB** (servo-per-fret).
Each file is
a full, valid instrument profile matching the JSON format of SPECIFICATION.md
§20 and the firmware `gmb::Profile` (`firmware/src/core/configuration/Profile.h`).

They are meant as realistic starting points: import one from the web interface,
then calibrate each finger's contact angle and the plucker for your physical build.

## Files

| File | Instrument | Strings | Tuning (MIDI) | Frets |
| ---- | ---------- | :-----: | ------------- | :---: |
| `ukulele-gcea.json` | Soprano ukulele | 4 | G4 C4 E4 A4 — 67 60 64 69 | 12 |
| `ukulele-gcea-geared.json` | Soprano ukulele, **geared low neck** | 4 | G4 C4 E4 A4 — 67 60 64 69 | 12 |
| `guitar-standard.json` | Guitar, standard | 6 | E2 A2 D3 G3 B3 E4 — 40 45 50 55 59 64 | 12 |
| `bass-4string.json` | Bass guitar | 4 | E1 A1 D2 G2 — 28 33 38 43 | 12 |
| `mandolin-gdae.json` | Mandolin (4 courses) | 4 | G3 D4 A4 E5 — 55 62 69 76 | 12 |
| `banjo-5string.json` | Banjo, open-G | 5 | D3 G3 B3 D4 + g G4 — 50 55 59 62 67 | 12 |

MIDI note reference: 60 = C4 (middle C).

## What varies between examples

The set is intentionally diverse so it exercises the schema:

* **String count & tuning** — 4, 5 and 6 strings across several registers, from
  the bass low E1 up to the mandolin high E5.
* **Re-entrant strings** — the ukulele high-G and the banjo re-entrant 5th
  string (a high `g`, `openNote` 67, sitting above the 4th string's D4). Every
  string still reaches `maxFret` 12.
* **Geared fingers** — `ukulele-gcea-geared.json` pairs the wide low frets
  (1‑2, 3‑4, 5‑6) onto **one antagonistic servo each** (`fretB` + `activeBUs`,
  neutral at `restUs`), keeping frets 7‑12 as plain one‑servo‑per‑fret: **40
  servos instead of 52**. See [`../docs/GEARED_FINGERS.md`](../docs/GEARED_FINGERS.md).

## Conventions shared by every profile

* **Pins** — each profile writes out only `SDA = 40`, `SCL = 41` and
  `SERVO_OE = 47` (the I²C bus plus the PCA9685 `/OE` safety line).
  `board.automaticPinAssignment` is `true`, so the firmware fills in anything
  else it needs; a direct-GPIO servo carries its own pin inside its servo entry.
* **Servos** — **one PCA9685 per string**: that string's finger servos occupy
  channels `0 … maxFret−1` and its individual plucker sits on channel `maxFret`
  (e.g. guitar: fingers 0–11, pluck 12).
* **One `strings[]` entry per string** — `{ enabled, openNote, maxFret }` only,
  with no homing or geometry. Which frets actually carry a finger is derived
  from the servo list.
* **Selection tracks the instrument** — `stringFretSelection` uses one-based
  numbering with the identity mapping (`reverseOrder = false`, `mapping = []`);
  `string.maximum` equals the string count and `.fret.maximum` equals the
  largest `maxFret`.

## Editing / validating

These are plain JSON. After editing, confirm the file still parses:

```sh
python3 -m json.tool instrument-profiles/guitar-standard.json > /dev/null
```

The firmware `ProfileValidator` performs the full semantic check (pin conflicts,
servo channel ranges, selection bounds) when a profile is imported.
