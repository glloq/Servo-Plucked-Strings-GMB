# Wiring guide

Connection guide for the **ESP32 servo-per-fret** reference electronics
(SPECIFICATION.md §7 and §22). Default GPIO come from the ESP32-S3-DevKitC-1
board profile (§11.5, `board-profiles/esp32-s3-devkitc-1.json`); every line can
be reassigned from the web interface.

Companion documents: the power-distribution and E-stop **reference circuit**
is [`../POWER_AND_SAFETY.md`](../POWER_AND_SAFETY.md) (with schematic sheets in
[`../schematics/`](../schematics/README.md)); I²C addressing and pull-up rules
are [`../I2C_PCA9685.md`](../I2C_PCA9685.md); the staged power-up procedure is
[`../COMMISSIONING.md`](../COMMISSIONING.md).

There are **no stepper drivers, no HOME/LIMIT sensors and no 24 V motor rail** —
fingers and pluckers are servos, driven over a PCA9685 or directly from a GPIO.

> 💡 The web interface renders this harness **live for your own configuration**:
> open the **Wiring** tab for a graphical, adaptive map of the ESP32, every
> PCA9685 (at its I²C address) and its 16 channels, the shared I²C / `/OE` /
> power buses and any direct-GPIO servos — with wiring-conflict checks and an
> SVG export. This page is the static reference behind that diagram.

> ⚠️ Wire and power-check the machine unpowered, with the PCA9685 `/OE` **high**
> (servos off). The firmware boots into a safe state: `/OE` high, servos
> neutralised (§21.1).

## 1. Default GPIO map (ESP32-S3-DevKitC-1)

Only three board-level signals are needed, and only when a PCA9685 is used —
plus the optional hardware E-stop input. Every servo is otherwise a PCA channel
or a direct GPIO chosen per servo in the wizard.

| Single signal | GPIO | Needed when |
| ------------- | :--: | ----------- |
| I²C SDA | 40 | a PCA9685 is used |
| I²C SCL | 41 | a PCA9685 is used |
| PCA9685 `/OE` (servo safety) | 47 | a PCA9685 is used |
| `ESTOP` (E-stop status input) | 2 | a hardware E-stop is installed (recommended — declare it in *Wiring & GPIO → Emergency stop input*) |

Good free output pins for **direct-GPIO servos** (board profile `SERVO` list):
GPIO **4, 5, 6, 7, 15, 16, 17, 18** (up to 8 direct servos).

> 🔎 **Board revision matters.** The DevKitC-1 exists in two revisions: the
> original (v1.0) drives its on-board RGB LED from **GPIO48** (GPIO38 free),
> the **v1.1** from **GPIO38** (GPIO48 free). Pick the matching board profile
> in the web UI (`esp32-s3-devkitc-1` = v1.0, `esp32-s3-devkitc-1-v1.1`) — the
> second-I²C-bus defaults move with it.

Reserved / do-not-use on this board: GPIO0/3/45/46 (strapping), 19/20 (future
USB), 26–32 (Flash/PSRAM), 35/36/37 (variant memory), 33/34 (caution), 43/44
(UART0 programming/diagnostics), and the revision's RGB-LED pin (48 on v1.0,
38 on v1.1). GPIO22–25 do not exist on the ESP32-S3.

## 2. PCA9685 servo expander (I²C)

Up to **eight boards per I²C bus** at addresses **0x40 … 0x47** (set by the
A0–A2 solder jumpers — table in [`../I2C_PCA9685.md`](../I2C_PCA9685.md)).
Recommended: **one board per string**.

> 🔀 **Two I²C buses (optional).** The ESP32-S3 exposes two hardware I²C
> controllers, so the boards can be split across a **second bus** (`Wire1`, pins
> **SDA2/SCL2** — board-profile default GPIO38/39 on a DevKitC-1 v1.0, GPIO39/42
> on a v1.1) to halve the traffic per bus and refresh the servos faster on large
> instruments. Each bus addresses its own 0x40–0x47 range, so two buses reach
> **16 boards / 256 channels** (capacity table: `../README.md`). Assign a board
> to a bus in the web interface (Setup Wizard → *Wiring & capacity*, or per servo
> in Advanced) and give SDA2/SCL2 their own pull-ups (`../I2C_PCA9685.md` §3).
> The `/OE` safety line can stay **shared** across both buses or be **split per
> bus** (a second `SERVO_OE2` GPIO, board default GPIO21) if you want independent
> output-enable control. The firmware drives both controllers (`Wire` = bus 0,
> `Wire1` = bus 1), routing each board to its bus and holding every configured
> `/OE` line safe, so the second bus works on real hardware.

| PCA9685 pin | Connect to | Notes |
| ----------- | ---------- | ----- |
| `SDA` | GPIO40 | I²C data (shared bus) |
| `SCL` | GPIO41 | I²C clock (shared bus) |
| `VCC` | 3.3 V | chip logic |
| `V+` | 5–6 V servo rail | **separate** servo supply, not the ESP regulator |
| `GND` | common ground | shared with logic and servo supply |
| `/OE` | GPIO47 | **safety**: drive high to disable all outputs |
| `A0 A1 A2` | address jumpers | 0x40 + binary value = board index |

Pull-ups on SDA/SCL: target **one equivalent 2.2–4.7 kΩ per bus line** — most
PCA9685 breakouts ship their own pull-ups and **parallel resistors add**, so
count them before soldering extra pairs (rule + worked examples:
[`../I2C_PCA9685.md`](../I2C_PCA9685.md) §3). A **bulk reservoir capacitor**
sits across `V+`/`GND` next to each board (sizing:
[`../POWER_AND_SAFETY.md`](../POWER_AND_SAFETY.md) §1.2). Chain `/OE` on every
board to the single GPIO47 safety line.

### `/OE` safety behaviour

`/OE` is active-low output-enable — and the PCA9685 has an **internal weak
pull-down**, so a floating `/OE` means outputs *enabled*. The reference circuit
therefore adds a **mandatory external pull-up (≈10 kΩ) from the `/OE` bus to
3.3 V**, so the outputs stay off with the ESP32 absent, resetting or unplugged.
Firmware holds the line **high (outputs off)** at boot and during panic/E-stop;
it drives it low only when the configuration is validated and servos are armed
(§21.1–21.3).

A hardware E-stop must **not** force `/OE` high by tying it to 3.3 V while the
GPIO drives it (electrical contention): route the E-stop's inhibition through
the gated enable stage — and, above all, through the **servo-rail contactor** —
as in [`../POWER_AND_SAFETY.md`](../POWER_AND_SAFETY.md) §2–3 /
[`../schematics/02-estop-and-servo-enable.md`](../schematics/02-estop-and-servo-enable.md).

### Servo channel map (one PCA per string convention)

| Channels | Function | Servo config `function` |
| :------: | -------- | ----------------------- |
| 0 … F−1 | finger press, one per equipped fret | `finger` |
| next | plucker for the string | `pluck` (or `strum`) |
| spare | optional strum-lift / damper / aux | `strumLift`, `damper`, `aux` |

The mapping is free per servo — this is only the default the wizard proposes.

## 3. Direct-GPIO servos (no PCA9685)

A servo can instead be wired straight to a free ESP32-S3 output pin:

| Servo wire | Connect to |
| ---------- | ---------- |
| Signal (usually orange/white) | a free output GPIO (e.g. 4, 5, 6, 7, 15–18) |
| `V+` (red) | 5–6 V servo rail |
| `GND` (brown/black) | common ground |

The ESP32-S3 drives it with LEDC 50 Hz PWM (≤ 8 direct servos). Never power a
servo from the ESP32's 3.3 V/5 V regulator — use the servo rail.

## 4. Power rails (§22)

The full reference circuit — main fuse, master switch, E-stop contactor, star
distribution with **per-branch fuses and capacitors**, sizing method — is
[`../POWER_AND_SAFETY.md`](../POWER_AND_SAFETY.md) §1 (sheet
[`01-power-distribution`](../schematics/01-power-distribution.md)). Summary:

| Rail | Feeds | Source |
| ---- | ----- | ------ |
| **5–6 V** | servomotors (PCA9685 `V+` and direct servos) | **separate** servo PSU/BEC, through F0 → switch → E-stop contactor → star distribution → one fused branch per PCA9685 / direct rail |
| **3.3 V** | ESP32-S3 logic, PCA9685 `VCC`, `/OE` pull-up | ESP board regulator (USB or 5 V in) |

Mandatory measures:

* **Separate servo supply** — no servo is ever powered from the ESP32 regulator.
* **Size it for the servo count** using the datasheet currents and the method of
  §1.1 — the firmware governor bounds simultaneity but is **not** a substitute
  for a correctly sized PSU.
* **Main fuse** on the servo rail; **per-branch fuses** strongly recommended.
* **Reverse-polarity protection** on the incoming supply.
* **Bulk reservoir capacitor** near each PCA9685 `V+` (and across the rail) —
  the classic 1000–10000 µF table is an **empirical micro-servo starting point**;
  size with `C ≈ I·Δt/ΔV` and confirm at the bench (§1.2).
* **Structured common ground** — tie logic ground and the servo-supply ground at
  one point (the distribution block).
* **Lockable connectors** on the servo and power harnesses.

The firmware bounds the peak current in software too: idle fingers cut their PWM
(`disableAtRest`), only one finger presses per string at a time, and the
activation governor staggers how many servos start moving together
(`maxConcurrentMoves`, `staggerMs`).

## 5. Grounding & signal integrity

* Single, structured common ground for the 5–6 V servo return, 3.3 V and signal
  grounds.
* Keep I²C (SDA/SCL) short or add stronger pull-ups; a bulk cap stabilises the
  servo rail against inrush when several servos move together.
* Route servo-signal runs away from the I²C bus where practical.

## 6. Bring-up

The staged electrical acceptance procedure — continuity, logic-only, rail-on
with outputs disabled, first motion, per-branch bring-up, whole-instrument
stress and E-stop verification, with a gate at each stage — is
[`../COMMISSIONING.md`](../COMMISSIONING.md). Follow it for every fresh or
re-wired build before stringing the instrument.
