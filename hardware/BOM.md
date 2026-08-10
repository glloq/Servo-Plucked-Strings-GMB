# Bill of materials

Reference bill of materials for the **ESP32 servo-per-fret** build
(SPECIFICATION.md §26). Quantities scale with the string count *N* (1–6) and the
number of **equipped frets** per string. There are no steppers, drivers or
position sensors.

Part numbers are indicative references, not a mandated sourcing list.

## Electronics — core

| Ref | Qty | Item | Notes |
| --- | :-: | ---- | ----- |
| U1 | 1 | ESP32-S3-DevKitC-1 | main controller (§7.1); verify Flash/PSRAM variant vs GPIO33–37 |
| U2 | 0–8 | PCA9685 16-ch PWM/servo breakout | I²C servo expander (§7.3); ~one per string, 0x40…0x47 |

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

## Power

| Ref | Qty | Item | Notes |
| --- | :-: | ---- | ----- |
| PS1 | 1 | 5–6 V PSU / BEC | **separate** servo rail — never the ESP regulator; size to the servo count |
| — | 1 | 3.3 V regulator | on the ESP32-S3 board (USB or 5 V in) |

## Protection & passives

| Ref | Qty | Item | Notes |
| --- | :-: | ---- | ----- |
| F1 | 1 | Fuse — servo rail | rate to combined servo current (§22) |
| D1 | 1 | Reverse-polarity protection (diode / P-MOS) | on incoming supply |
| C_pca | 1 per PCA9685 | Bulk reservoir cap ≥ 470 µF near `V+` | servo inrush |
| C_rail | 1 | Bulk cap across the 5–6 V servo rail | inrush when many servos move |
| R_i2c | 2 | I²C pull-ups (2.2–4.7 kΩ to 3.3 V) | if not on the PCA9685 breakout |

## Interconnect

| Ref | Qty | Item | Notes |
| --- | :-: | ---- | ----- |
| J_sv | per servo | Servo 3-pin headers | on/from the PCA9685, or to a GPIO |
| J_i2c | per PCA9685 | I²C + power header | SDA/SCL/`V+`/GND/`/OE` |
| J_pwr | 2 | Lockable power connectors | 5–6 V servo / 5 V-or-USB logic |
| — | 1 | E-stop switch | forces the PCA9685 `/OE` high (§21.2) |
| — | as needed | Wire, ferrules, servo horns, fasteners | mechanics |

## Notes

* **Servo count** = finger (one per equipped fret, or one geared servo per two
  frets) + pluck (one per string) + optional strumLift / damper / aux.
* **PCA9685 vs GPIO**: up to 8 PCA9685 (128 channels) and/or up to 8 direct-GPIO
  servos — mixable per servo (§7.3).
* Confirm the ESP32-S3 module variant: octal-PSRAM parts consume GPIO35–37 (kept
  reserved in the board profile).
