# Schematics — placeholder

The electronic schematic is a **dedicated-hardware** deliverable. It is not yet
drawn; this directory is a placeholder.

Until then, the reference wiring is fully described in text:

* Electronics overview — `../README.md` (SPECIFICATION.md §7)
* Connection guide, pinout and power rails — `../wiring/WIRING.md` (§7 / §22)
* Bill of materials — `../BOM.md`
* Default GPIO map — `../../board-profiles/esp32-s3-devkitc-1.json` (§11.5)

## Planned contents

When produced, the schematic set will capture the **servo-per-fret** electronics:

* **ESP32-S3-DevKitC-1** connections with the GPIO assignment of §11.5 (I²C
  SDA/SCL, PCA9685 `/OE`, and any direct-GPIO servo pins).
* **PCA9685** servo expanders (1–8, addresses 0x40…0x47): shared I²C with
  pull-ups, `V+` servo rail with a bulk capacitor per board, the 16 channel
  headers, and the chained `/OE` safety line to GPIO47.
* **Direct-GPIO servo** headers: a few free output pins driven by LEDC (optional,
  for PCA-less or small builds).
* **Power tree** (§22): a single 5–6 V servo rail (separate from logic) and 3.3 V
  logic, with a servo-rail fuse, reverse-polarity protection and PCA9685 reservoir
  caps.
* **Safety / E-stop** path: hardware forcing of the PCA9685 `/OE` high (§21.2),
  ESP32 kept powered.
* Net labels and connector pinouts matching `../BOM.md` and `../wiring/WIRING.md`.
