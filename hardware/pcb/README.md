# PCB — placeholder

The integrated PCB is a **dedicated-hardware** deliverable. It is not yet
designed; this directory is a placeholder. The prototype build uses an
ESP32-S3-DevKitC-1 with one or more **PCA9685 breakouts** (and/or a few
direct-GPIO servos) rather than a custom board (§7.3).

See `../schematics/README.md` for the schematic that the PCB will implement, and
`../wiring/WIRING.md` for the current reference interconnect.

## Planned contents

When produced, the PCB package will include the **servo-per-fret** electronics:

* Board layout hosting the ESP32-S3 module and headers for **1–8 PCA9685**
  boards (or on-board PCA9685) plus a few direct-GPIO servo pins.
* **Power rails** (§22): a single 5–6 V servo rail (separate from logic) and
  3.3 V logic, with a structured common-ground strategy.
* On-board **protection**: servo-rail fuse, reverse-polarity protection, and a
  PCA9685 reservoir capacitor per board.
* **Lockable connectors** for servos and power (§22).
* **Hardware E-stop** wiring: PCA9685 `/OE` neutralisation, ESP32 kept alive
  (§21.2).
* Manufacturing outputs: Gerbers, drill files, assembly drawing, and a
  pick-and-place / BOM cross-reference to `../BOM.md`.
* Electrical validation notes.
