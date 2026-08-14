# Bill of materials

Reference bill of materials for the **ESP32 servo-per-fret** build
(SPECIFICATION.md §26). Quantities scale with the string count *N* (1–6) and the
number of **equipped frets** per string. There are no steppers, drivers or
position sensors. Capacity limits (strings, boards per bus, channels) are
defined once in [`README.md`](README.md) §Capacity.

Part numbers are indicative references, not a mandated sourcing list.
Status column: **M** = mandatory (part of the reference circuit,
[`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md)) · **R** = strongly recommended ·
**O** = optional.

## Electronics — core

| Ref | Qty | Item | Status | Notes |
| --- | :-: | ---- | :-: | ----- |
| U1 | 1 | ESP32-S3-DevKitC-1 | M | main controller (§7.1). **Check the board revision**: v1.0 has its RGB LED on GPIO48, v1.1 on GPIO38 — pick the matching board profile in the web UI. Verify Flash/PSRAM variant vs GPIO33–37 |
| U2 | 0–16 | PCA9685 16-ch PWM/servo breakout | R | I²C servo expander (§7.3); ~one per string; 0x40…0x47 **per bus**, two buses ([`I2C_PCA9685.md`](I2C_PCA9685.md)) |

A PCA9685 is optional: a small instrument can drive up to **8 servos straight
from ESP32-S3 GPIO** (LEDC). Most builds use one PCA9685 per string.

## Actuators — servos

| Ref | Qty | Item | Notes |
| --- | :-: | ---- | ----- |
| SV_F | Σ equipped frets | Servo — finger press, one per fret | `function: "finger"`; a **geared** servo can cover two frets |
| SV_P | *N* | Servo — plucker, one per string | `function: "pluck"` (or `"strum"`) |
| SV_L | 0–*N* | Servo — strum lift (optional) | `function: "strumLift"` |
| SV_D | 0–*N* | Servo — damper / mute (optional) | `function: "damper"` |
| SV_X | 0+ | Servo — auxiliary (optional) | `function: "aux"` |

Example: a 4-string, 12-fret instrument ≈ 48 finger + 4 pluck = **52 servos**
(≈ one PCA9685 per string). Gearing the low frets reduces the finger count.

For each servo **model** used, record idle / moving / stall current from the
datasheet — the fuse, PSU and capacitor sizing method
([`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md) §1.1) starts from those numbers.

## Power & safety

The reference circuit these parts implement is
[`POWER_AND_SAFETY.md`](POWER_AND_SAFETY.md) (sheets
[`01`](schematics/01-power-distribution.md) /
[`02`](schematics/02-estop-and-servo-enable.md)).

| Ref | Qty | Item | Status | Notes |
| --- | :-: | ---- | :-: | ----- |
| PS1 | 1 | 5–6 V PSU / BEC, sized per §1.1 | M | **separate** servo rail — never the ESP regulator |
| — | 1 | 3.3 V regulator | M | on the ESP32-S3 board (USB or 5 V in) |
| F0 | 1 | Main fuse — servo rail | M | at the PSU output, whole-instrument rating |
| F1…Fn | 1 per branch | Branch fuse (per PCA9685 / direct-servo rail) | R | localises a fault to one string group |
| — | 1 | Star distribution block | R | one direct feed per branch; single logic/servo GND tie point |
| S1 | 1 | Master switch | M (fixed installs) | upstream of the contactor |
| SW_ES | 1 | **E-stop button** — latching mushroom, ≥ 2 NC contacts | M (assembled machine) | NC #1 → contactor coil, NC #2 → `ESTOP` input, NC #3 (option) → `/OE` gate |
| K1 | 1 | Contactor / relay, **DC-rated** at rail current | M with SW_ES | the button switches the coil, never the servo current; check the DC rating |
| D_fw | 1 | Freewheel diode on K1's coil | M if DC coil unprotected | |
| D1 | 1 | Reverse-polarity protection (P-MOS / Schottky) | M/R per supply | on the incoming supply |
| R_pu | 1 per `/OE` bus | Pull-up 10 kΩ, `/OE` bus → 3.3 V | **M** | the PCA9685's internal pull-DOWN enables a floating `/OE` — this pull-up is what keeps outputs off with the ESP32 absent/resetting |
| Q1,Q2,R1–R4 | 1 set per `/OE` bus | Gated non-inverting `/OE` enable stage (2×NPN) | R | lets the E-stop chain forbid enabling; circuit in §3 of POWER_AND_SAFETY.md |
| TVS | 1 | TVS diode across the servo rail | R | clamps inductive spikes |
| C_pca | 1 per PCA9685 | Bulk reservoir cap across `V+`/GND | M | starting values + sizing formula in §1.2 — **empirical micro-servo table, size for YOUR servos** |
| C_hf | 1 per PCA9685 | 100 nF ceramic across `V+`/GND | M | HF filtering next to each bulk cap |
| C_rail | 1 | Bulk cap across the 5–6 V rail at the distribution block | R | |
| R_i2c | 1 pair per bus | I²C pull-ups — **one equivalent 2.2–4.7 kΩ per bus line** | M | count the breakouts' on-board pull-ups first: they parallel ([`I2C_PCA9685.md`](I2C_PCA9685.md) §3) |
| — | 1 | Current/voltage sensor on the servo rail (INA226…) | O | very useful at the commissioning bench |

## Interconnect

| Ref | Qty | Item | Status | Notes |
| --- | :-: | ---- | :-: | ----- |
| J_sv | per servo | Servo 3-pin headers | M | on/from the PCA9685, or to a GPIO |
| J_i2c | per PCA9685 | I²C + power header | M | SDA/SCL/`V+`/GND/`/OE` |
| J_pwr | 2 + branches | Lockable power connectors | R | PSU input + one per branch |
| — | as needed | Wire (sized §1.1), ferrules, servo horns, fasteners | M | |

## Notes

* **Servo count** = finger (one per equipped fret, or one geared servo per two
  frets) + pluck (one per string) + optional strumLift / damper / aux.
* **PCA9685 vs GPIO**: mixable per servo (§7.3); capacity in
  [`README.md`](README.md) §Capacity.
* Confirm the ESP32-S3 module variant: octal-PSRAM parts consume GPIO35–37
  (kept reserved in the board profile) — and the board **revision** decides
  whether GPIO38 (v1.1) or GPIO48 (v1.0) is the reserved RGB-LED pin.
