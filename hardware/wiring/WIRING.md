# Wiring guide

Connection guide for the **ESP32 servo-per-fret** reference electronics
(SPECIFICATION.md §7 and §22). Default GPIO come from the ESP32-S3-DevKitC-1
board profile (§11.5, `board-profiles/esp32-s3-devkitc-1.json`); every line can
be reassigned from the web interface.

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

Only three board-level signals are needed, and only when a PCA9685 is used. Every
servo is otherwise a PCA channel or a direct GPIO chosen per servo in the wizard.

| Single signal | GPIO | Needed when |
| ------------- | :--: | ----------- |
| I²C SDA | 40 | a PCA9685 is used |
| I²C SCL | 41 | a PCA9685 is used |
| PCA9685 `/OE` (servo safety) | 47 | a PCA9685 is used |

Good free output pins for **direct-GPIO servos** (board profile `SERVO` list):
GPIO **4, 5, 6, 7, 15, 16, 17, 18** (up to 8 direct servos).

Reserved / do-not-use on this board: GPIO0/3/45/46 (strapping), 19/20 (future
USB), 26–32 (Flash/PSRAM), 35/36/37 (variant memory), 33/34 (caution), 43/44
(UART0 programming/diagnostics), 48 (RGB LED). GPIO22–25 do not exist on the
ESP32-S3.

## 2. PCA9685 servo expander (I²C)

Up to **eight** boards at addresses **0x40 … 0x47** (set by the A0–A2 solder
jumpers). Recommended: **one board per string**.

> 🔀 **Two I²C buses (optional).** The ESP32-S3 exposes two hardware I²C
> controllers, so the boards can be split across a **second bus** (`Wire1`, pins
> **SDA2/SCL2**, default GPIO38/39) to halve the traffic per bus and refresh the
> servos faster on large instruments. Each bus addresses its own 0x40–0x47 range,
> so two buses reach **16 boards / 256 channels**. Assign a board to a bus in the
> web interface (Setup Wizard → *Wiring & capacity*, or per servo in Advanced) and
> give SDA2/SCL2 their own pull-ups. *(Firmware note: the reference firmware
> currently drives a single `Wire` bus; the second bus needs matching `Wire1`
> support in `firmware/src/platform/esp32/ServoBank.cpp`.)*

| PCA9685 pin | Connect to | Notes |
| ----------- | ---------- | ----- |
| `SDA` | GPIO40 | I²C data (shared bus) |
| `SCL` | GPIO41 | I²C clock (shared bus) |
| `VCC` | 3.3 V | chip logic |
| `V+` | 5–6 V servo rail | **separate** servo supply, not the ESP regulator |
| `GND` | common ground | shared with logic and servo supply |
| `/OE` | GPIO47 | **safety**: drive high to disable all outputs |
| `A0 A1 A2` | address jumpers | 0x40 + binary value = board index |

Pull-ups on SDA/SCL (2.2 kΩ–4.7 kΩ to 3.3 V) — many PCA9685 breakouts include
them. A **bulk reservoir capacitor** (≥ 470 µF) sits across `V+`/`GND` next to
each board (§22). Chain `/OE` on every board to the single GPIO47 safety line.

### `/OE` safety behaviour

`/OE` is active-low output-enable. Firmware holds it **high (outputs off)** at
boot and during panic/E-stop so no servo can move; it is pulled low only when the
configuration is validated and servos are armed (§21.1–21.3). A hardware E-stop
may also force `/OE` high directly.

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

| Rail | Feeds | Source |
| ---- | ----- | ------ |
| **5–6 V** | servomotors (PCA9685 `V+` and direct servos) | **separate** servo PSU/BEC |
| **3.3 V** | ESP32-S3 logic | ESP board regulator (USB or 5 V in) |

Mandatory measures:

* **Separate servo supply** — no servo is ever powered from the ESP32 regulator.
* **Size it for the servo count** — a full fretboard is dozens of servos; rate the
  5–6 V supply for the worst-case simultaneous inrush.
* **Fuse the servo rail.**
* **Reverse-polarity protection** on the incoming supply.
* **Bulk reservoir capacitor** near each PCA9685 `V+` (and across the servo rail).
* **Structured common ground** — tie logic ground and the servo-supply ground at
  one point.
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

## 6. Bring-up checklist

1. Wire everything with all supplies **off**.
2. Continuity-check grounds and confirm no rail-to-rail shorts.
3. Power **logic / 3.3 V only** (USB is fine); confirm the ESP32-S3 boots and
   serves the web UI.
4. Power the **servo rail**; with `/OE` high, verify no servo twitches, then arm
   and test one finger servo from the wizard.
5. Calibrate each finger's rest/press angle fret by fret (Frets step), then a
   plucker per string (Plucking step).
6. Verify the **STOP / panic** path neutralises the servos (forces `/OE` high and
   detaches direct servos).
