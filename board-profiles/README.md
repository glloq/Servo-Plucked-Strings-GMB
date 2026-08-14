# Board profiles

Machine-readable GPIO capability maps for the ESP32 boards supported by
**Servo-Plucked-Strings-GMB**. The web configurator and the firmware pin
manager use these files to filter which GPIO may carry which signal, per board
and per module variant (SPECIFICATION.md §11).

Each JSON file mirrors the corresponding built-in profile in the firmware
(`firmware/src/core/board/BoardProfile.cpp`). Keeping the JSON and the C++ in
sync means the browser UI and the on-device validator agree about every pin.

## Files

| File | Board | Source of truth |
| ---- | ----- | --------------- |
| `esp32-s3-devkitc-1.json` | Espressif ESP32-S3-DevKitC-1 **v1.0** (RGB LED on GPIO48) | `makeEsp32S3DevKitC1()` |
| `esp32-s3-devkitc-1-v1.1.json` | Espressif ESP32-S3-DevKitC-1 **v1.1** (RGB LED on GPIO38) | `makeEsp32S3DevKitC1V11()` |
| `esp32-wroom-32.json` | ESP32-WROOM-32 (DevKitC, 38-pin) | `makeEsp32Wroom32()` |
| `esp32-devkit-v1.json` | ESP32 DevKit v1 (30-pin) | `makeEsp32DevKitV1()` |

> **DevKitC-1 revisions.** Espressif moved the on-board RGB LED between board
> revisions: the original (v1.0) drives it from **GPIO48**, the v1.1 from
> **GPIO38**. The LED pin is `reserved`, the other one free, so each revision
> is its own profile — check the silkscreen / the Espressif user guide. The
> historical `esp32-s3-devkitc-1` identifier keeps naming the v1.0 board so
> stored profiles keep the pin map they were validated against.

## Top-level format

```jsonc
{
  "identifier": "esp32-s3-devkitc-1",   // stable id, matches profile.board.profile
  "displayName": "ESP32-S3-DevKitC-1",
  "description": "…",
  "reference": "SPECIFICATION.md sections 11.4 / 11.5",
  "recommendedAssignment": { … },        // default auto-assign table (§11.5)
  "pins": [ { …PinCapability… }, … ]
}
```

### `recommendedAssignment`

The default, conflict-free assignment the "Assign pins automatically"
button proposes (SPECIFICATION.md §11.5). A servo-per-fret instrument only needs
the PCA9685 I²C bus and its `/OE` safety line at board level; individual servos
are assigned **per servo** (a PCA channel or a direct GPIO) in the setup wizard.

| Key | Meaning | Value (S3 v1.0) |
| --- | ------- | ----- |
| `SDA` | PCA9685 I²C bus 0 data | `40` |
| `SCL` | PCA9685 I²C bus 0 clock | `41` |
| `SDA2` / `SCL2` | optional second I²C bus (`Wire1`) | `38` / `39` (v1.1: `39` / `42` — GPIO38 is its LED) |
| `SERVO_OE` | PCA9685 `/OE` safety line | `47` |
| `SERVO_OE2` | optional second-bus `/OE` | `21` |
| `ESTOP` | hardware E-stop safety input (`SafetyInput`) | `2` |
| `SERVO` | recommended free output pins for direct-GPIO servos | `[4, 5, 6, 7, 15, 16, 17, 18]` |

The `SERVO` array lists good pins for **direct-GPIO** servos (used when a servo is
wired straight to the ESP32 instead of a PCA9685). This is a starting profile, not
a universal rule — the UI can override every line (SPECIFICATION.md §11.5). The
second-bus and `ESTOP` defaults are **board-profile data on purpose**: the UI has
no hard-coded pin fallbacks, so a board with no recommendation simply leaves the
signal unassigned until the user picks a pin.

### `pins[]` — `PinCapability`

Each entry describes one physical GPIO. Fields match
`gmb::PinCapability` in `BoardProfile.h`:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `gpio` | int | GPIO number. |
| `exposed` | bool | Broken out on a board header. |
| `input` | bool | Usable as a digital input. |
| `output` | bool | Usable as a digital output. |
| `interrupt` | bool | Can raise a GPIO interrupt. |
| `internalPullUp` | bool | Has a usable internal pull-up — required for the `ESTOP` safety input (read as `INPUT_PULLUP`; classic-ESP32 input-only pins 34/35/36/39 have none). |
| `highSpeedOutput` | bool | Suitable for fast digital toggling. |
| `adc` | bool | Wired to an ADC channel. |
| `reserved` | bool | Reserved by firmware policy or hardware; never assignable. |
| `strapping` | bool | Boot-strapping pin (level sampled at reset). |
| `usb` | bool | Part of the USB-JTAG / native USB interface. |
| `onboardPeripheral` | bool | Wired to an on-board device (LED, UART header…). |
| `preference` | string | UI category: `"recommended"`, `"caution"`, or `"reserved"`. |
| `note` | string | Human-readable reason, shown in the UI. |

`preference` maps to the UI colours of SPECIFICATION.md §11.2:

* `recommended` → green — offered to beginners by default.
* `caution` → yellow — advanced mode only, shown with the `note` explanation.
* `reserved` → red — never selectable.

(The grey "already used" state of §11.2 is runtime state, not a static pin
property, so it does not appear here.)

## ESP32-S3-DevKitC-1 specifics

The profile encodes the ESP32-S3 restrictions of SPECIFICATION.md §11.4:

* **Strapping (reserved):** GPIO0 (also BOOT), GPIO3, GPIO45, GPIO46.
* **Native USB (reserved):** GPIO19 (D−), GPIO20 (D+) — kept free for a future
  USB transport.
* **Flash / PSRAM (reserved):** GPIO26–32.
* **Variant memory:** GPIO33/34 are **caution** (tied to memory on some
  modules); GPIO35/36/37 are **reserved** (octal Flash/PSRAM variants).
* **UART0 (reserved):** GPIO43 (TX), GPIO44 (RX) — programming / diagnostics.
* **On-board RGB LED (reserved):** GPIO48 on v1.0 boards, GPIO38 on v1.1.
* **Recommended:** GPIO1, 2, 4–18, 21, 39, 40, 41, 42, 47 — plus GPIO38 (v1.0)
  or GPIO48 (v1.1), whichever the LED does not occupy.

**GPIO22–25 do not exist on the ESP32-S3** and are intentionally absent from the
`pins` array.
