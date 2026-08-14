# Sheet 01 — Power distribution

Reference power tree of the servo-per-fret build (companion to
[`../POWER_AND_SAFETY.md`](../POWER_AND_SAFETY.md) §1). Text schematic until the
KiCad set exists; net names below are the ones used across the BOM, the wiring
guide and sheet 02/03.

```text
                              SERVO PSU (5–6 V, sized per §1.1)
                                   │ +V_PSU
                                   │
                              [D1 reverse-polarity protection]      (P-MOS or Schottky)
                                   │
                              [F0 main fuse]
                                   │
                              [S1 master switch]                    (fixed installs)
                                   │
                 ┌── K1 A1 (coil) ─┤ E-stop chain NC #1 — sheet 02
                 │                 │
                              [K1 contactor / DC-rated relay]
                                   │ +V_SERVO            [TVS across +V_SERVO/GND]
                                   │
                    ╔══════════════╧═══════════════╗
                    ║   STAR DISTRIBUTION BLOCK    ║   ← single logic/servo GND tie
                    ╚═╤═════╤═════╤═════╤══════╤═══╝
                      │     │     │     │      │
                    [F1]  [F2]  [F3]  [F4]   [F5]          one fuse per branch
                      │     │     │     │      │
                    (C1)  (C2)  (C3)  (C4)   (C5)          bulk cap + 100 nF per branch
                      │     │     │     │      │
                   PCA#0  PCA#1 PCA#2 PCA#3  direct-GPIO
                   V+/GND V+/GND V+/GND V+/GND  servo rail
                   str.1  str.2  str.3  str.4  (servos wired straight to ESP32 pins)

LOGIC (independent): USB / 5 V ─► ESP32-S3 ─ 3V3 ─► PCA VCC (all boards), /OE pull-up
GND: one common ground, tied at the distribution block only.
```

## Nets

| Net | Description |
| --- | ----------- |
| `+V_PSU` | PSU output, before protection |
| `+V_SERVO` | switched, fused servo rail after K1 |
| `+V_BR<n>` | branch n, after its fuse F\<n\> — one per PCA9685 + one for direct servos |
| `3V3` | ESP32-S3 regulator output — logic only, never a servo |
| `GND` | common ground, single tie point at the distribution block |

## Sizing (see §1.1–1.2 of POWER_AND_SAFETY.md)

* `F0`: whole-instrument worst case; `F1…Fn`: per-branch worst case
  (governor cap × stall current of the branch's largest servo).
* `C<n>`: start from the micro-servo table, size with `C ≈ I·Δt/ΔV`, confirm
  at the bench.
* Wires: < 5 % drop at branch worst case over the real run length.
