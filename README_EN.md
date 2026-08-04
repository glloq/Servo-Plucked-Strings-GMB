# Orchestrion - MIDI-Controlled String Instrument

> MIDI control of a plucked string instrument (guitar, bass, ukulele) using
> servomotors for frets and plucking.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Arduino](https://img.shields.io/badge/Arduino-Compatible-green.svg)](https://www.arduino.cc/)
[![MIDIUSB](https://img.shields.io/badge/MIDI-USB%20Native-orange.svg)](https://www.midi.org/)

**English version** | [Version française](README.md)

## 📖 Description

This project turns a string instrument into an automated, MIDI-controlled
instrument. Servomotors press the frets to change notes and pluck the strings
in response to MIDI messages received over USB.

The repository is organized **per hardware platform**, each in its own folder:

| Platform | Folder | Status | MIDI |
|----------|--------|--------|------|
| **Arduino / PCA9685** | [`arduino/`](arduino/) | ✅ Working | Native USB (MIDIUSB) |
| **ESP32-S3 (servo-per-fret)** | [`esp32/`](esp32/) | ✅ Working | Wi-Fi MIDI + string/fret CC + SysEx |

👉 **Arduino**: [`arduino/README.md`](arduino/README.md) — install, configure,
calibrate and use.
👉 **ESP32**: [`esp32/README.md`](esp32/README.md) — the **servo-per-fret** version
(one servo per fret position, web interface + guided install helper, MIDI reception
with string/fret selection CC).

**Features:**
- 🎸 Multi-string support (guitar, bass, ukulele, etc.)
- 🎹 MIDI control via USB (latency ~1-3 ms)
- 🔧 Flexible file-based configuration
- 🎛️ Individual PCA9685 mapping per servo
- ⚡ Smart power management
- 📊 Modular object-oriented architecture

## 🖼️ How It Works

### Hardware Architecture

The system uses PCA9685 controllers to drive servomotors via I2C:

<img src="img/Schemas.png" alt="PCA9685 Architecture" width="80%"/>

### Fret Actuation

Different methods to press strings on frets:

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/fingers%20servo.png" alt="Fret actuation" width="80%"/>

### String Plucking

Plucking servo with alternating movement (oscillation around center):

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/grattage%20servo.png" alt="Plucking servo" width="60%"/>

## 📂 Repository Structure

```
├── arduino/                    # ✅ Arduino version (PCA9685 + MIDIUSB)
│   ├── README.md               #    Arduino platform guide
│   ├── platformio.ini          #    PlatformIO environments
│   ├── CHANGELOG.md
│   ├── Servo-Plucked-String/   #    Arduino sketch
│   │   ├── Servo-Plucked-String.ino
│   │   └── src/                #    Modules (config, core, string, midi, utils)
│   └── docs/                   #    Detailed docs + LIMITS + AUDIT
│
├── esp32/                      # ✅ ESP32-S3 version (servo-per-fret)
│   ├── README.md               #    ESP32 platform guide
│   ├── firmware/               #    Firmware (testable C++ core + adapters + tests)
│   ├── web-interface/          #    Web UI (setup wizard + install helper)
│   ├── instrument-profiles/    #    Ready profiles (ukulele, guitar, bass, mandolin, banjo)
│   ├── board-profiles/         #    ESP32-S3-DevKitC-1 board
│   └── docs/                   #    Detailed documentation
│
├── img/                        # Shared schematics
├── README.md                   # French landing page
└── README_EN.md                # this file
```

## 🚀 Quick Start (Arduino)

1. **Hardware**: an **Arduino Leonardo** (ATmega32u4, native USB) + one or
   more **PCA9685** boards + servomotors + a 5-6 V power supply.
2. **Libraries**: *Adafruit PWM Servo Driver* and *MIDIUSB*.
3. **Open** `arduino/Servo-Plucked-String/Servo-Plucked-String.ino` in the
   Arduino IDE (or `pio run` with `arduino/platformio.ini`).
4. **Configure** your strings in
   `arduino/Servo-Plucked-String/src/config/string_configs.h`.

Full details in [`arduino/README.md`](arduino/README.md).

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [arduino/README.md](arduino/README.md) | Arduino version usage guide |
| [arduino/docs/LIMITES.md](arduino/docs/LIMITES.md) | **Limits** (size, speed, platforms) — French |
| [arduino/docs/AUDIT.md](arduino/docs/AUDIT.md) | Code **audit** and fixes — French |
| [arduino/docs/ANALYSE_BESOIN.md](arduino/docs/ANALYSE_BESOIN.md) | Requirements analysis — French |
| [arduino/docs/LOGIQUE_CODE.md](arduino/docs/LOGIQUE_CODE.md) | Detailed flow diagrams — French |
| [arduino/docs/LOGIQUE_SERVOS_DETAILLEE.md](arduino/docs/LOGIQUE_SERVOS_DETAILLEE.md) | Fret and pluck logic — French |
| [arduino/docs/STRUCTURE_PROJET.md](arduino/docs/STRUCTURE_PROJET.md) | Code organization — French |
| [arduino/docs/GUIDE_MIDIUSB.md](arduino/docs/GUIDE_MIDIUSB.md) | Complete MIDIUSB guide — French |
| [arduino/CHANGELOG.md](arduino/CHANGELOG.md) | Change history |
| [esp32/README.md](esp32/README.md) | **ESP32 (servo-per-fret) guide** — firmware, web UI, install helper |

## 🤝 Contributing

Contributions are welcome! Feel free to:
- 🐛 Report bugs
- 💡 Suggest features
- 📖 Improve documentation
- 🔧 Submit pull requests

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Adafruit](https://www.adafruit.com/) for the PCA9685 library
- Arduino community
- All contributors

## 📧 Contact

For questions or suggestions: [GitHub Issues](https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors/issues)

---

**Made with ❤️ for music automation**
