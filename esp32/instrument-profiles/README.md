# Instrument profiles (servo-per-fret)

Example configuration profiles for **Servo-Plucked-Strings-GMB**. Each file is a
full, valid instrument profile matching the firmware `gmb::Profile`
(`firmware/src/core/configuration/Profile.h`) and its JSON (de)serializer
(`firmware/src/platform/esp32/ProfileStorage.cpp`). Import one from the web
interface, then calibrate each finger's contact angle and the plucker.

They are generated from the firmware's own `Profile::makeDefault()` and pass the
round-trip check (`firmware/test/profilecheck/run.sh`), so they are guaranteed to
load on device.

## Files

| File | Instrument | Strings | Tuning (MIDI) | Frets |
| ---- | ---------- | :-----: | ------------- | :---: |
| `ukulele-gcea.json` | Soprano ukulele | 4 | G4 C4 E4 A4 — 67 60 64 69 | 12 |
| `guitar-standard.json` | Guitar, standard | 6 | E2 A2 D3 G3 B3 E4 — 40 45 50 55 59 64 | 12 |
| `bass-4string.json` | Bass guitar | 4 | E1 A1 D2 G2 — 28 33 38 43 | 12 |
| `mandolin-gdae.json` | Mandolin (4 courses) | 4 | G3 D4 A4 E5 — 55 62 69 76 | 12 |
| `banjo-5string.json` | Banjo, open-G | 5 | D3 G3 B3 D4 g — 50 55 59 62 67 | 12 |

MIDI note reference: 60 = C4 (middle C).

## Conventions shared by every profile

* **Servo-per-fret wiring** — for each string, **one finger servo per fret**
  (`function:"finger"`, with `stringIndex` and `fret` 1..12) plus **one plucker**
  (`function:"pluck"`). Fret 0 (open string) has no servo. Frets need not be
  contiguous — these examples happen to fill 1..12, but you may equip an arbitrary
  subset.
* **One PCA9685 per string** — every servo of string *i* is on `pcaBoard = i`;
  fingers on channels `0 … maxFret−1`, the plucker on channel `maxFret`. Up to
  **8 boards** (0x40–0x47). The mapping is free: any servo can be moved to any
  `(pcaBoard, channel)` or to a direct GPIO (`source:"gpio"`).
* **Pins** — only the PCA9685 bus and safety line: `SDA=40`, `SCL=41`,
  `SERVO_OE=47`. No stepper STEP/DIR/HOME/ENABLE.
* **Current governor** — a top-level `power` block
  (`maxConcurrentMoves`, `staggerMs`) staggers simultaneous servo starts;
  `disableAtRest` (per servo) cuts idle PWM.
* **String / fret selection** — `stringFretSelection` follows the General-MIDI-Boop
  preset (CC20 string, CC21 fret); ranges track the instrument.
* **`strings[]`** — one entry per string, each just `{enabled, openNote, maxFret}`
  (no homing, no mm geometry).

## Editing / validating

Plain JSON. After editing, confirm it still parses and round-trips:

```sh
python3 -m json.tool instrument-profiles/guitar-standard.json > /dev/null
firmware/test/profilecheck/run.sh      # loads all profiles through the real parser
```

The firmware `ProfileValidator` performs the full semantic check (finger
`(string,fret)` uniqueness, PCA channel/board ranges, direct-GPIO conflicts,
striker presence, selection bounds) when a profile is imported.
