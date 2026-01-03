# Orchestrion - MIDI-Controlled String Instrument

> MIDI control of a plucked string instrument (guitar, bass, ukulele) using servomotors for frets and plucking.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Arduino](https://img.shields.io/badge/Arduino-Compatible-green.svg)](https://www.arduino.cc/)
[![MIDIUSB](https://img.shields.io/badge/MIDI-USB%20Native-orange.svg)](https://www.midi.org/)

**English version** | [Version française](README.md)

## 📖 Description

This project transforms a string instrument into an automated MIDI-controlled instrument. Servomotors press the frets to change notes and pluck the strings in response to MIDI messages received via USB.

**Features:**
- 🎸 Multi-string support (guitar, bass, ukulele, etc.)
- 🎹 MIDI control via USB (latency ~1-3ms)
- 🔧 Flexible file-based configuration
- 🎛️ Individual PCA9685 mapping per servo
- ⚡ Smart power management
- 📊 Modular object-oriented architecture

## 🖼️ How It Works

### Hardware Architecture

The system uses PCA9685 controllers to drive servomotors via I2C:

<img src="https://raw.githubusercontent.com/glloq/Orchestrion_Plucked_Strings_Servomotors/main/img/Schemas.png?raw=true" alt="PCA9685 Architecture" width="80%"/>

### Fret Actuation

Different methods to press strings on frets:

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/fingers%20servo.png" alt="Fret actuation" width="80%"/>

### String Plucking

Plucking servo with alternating movement (oscillation around center):

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/grattage%20servo.png" alt="Plucking servo" width="60%"/>

## 🚀 Quick Start

### Required Hardware

- **Microcontroller**: Teensy 4.0/4.1 (recommended) or Arduino Leonardo/Micro
- **Servo controllers**: PCA9685 (up to 4 for 64 servos)
- **Servomotors**: For frets and plucking
- **Power supply**: 5-6V sufficient for all servos

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors.git
```

2. **Install libraries** (Arduino IDE)
```
Tools → Manage Libraries → Search for:
  - "Adafruit PWM Servo Driver"
```

3. **Teensy Configuration**
```
Tools → USB Type → "Serial + MIDI"
```

4. **Compile and upload**
Open `src/main.ino` and upload to the board

### Basic Configuration

Edit `src/config/string_configs.h`:

```cpp
const StringConfig stringConfigs[NUM_STRINGS] = {
  {
    .baseMidiNote = 40,           // Open string MIDI note (E2)
    .numFrets = 12,               // Number of frets

    .fretServos = {               // PCA+pin mapping
      {0,0}, {0,1}, {0,2}, ...    // {pcaIndex, pin}
    },

    .pluckServo = {0, 12},        // Plucking servo

    .fretCalibration = {          // Calibration
      {45, 120}, ...              // {angleOpen, angleClosed}
    },

    .pluckAngleCenter = 90,       // Oscillation center
    .pluckAmplitude = 15,         // Amplitude ±15°
  }
};
```

## 📂 Project Structure

```
├── src/                    # Arduino source code
│   ├── main.ino           # Main program
│   ├── config/            # Configuration (settings.h, string_configs.h)
│   ├── core/              # PCA9685Manager, InstrumentManager
│   ├── string/            # StringInstrument, FretController, PluckController
│   ├── midi/              # MIDIHandler, NoteMapper
│   └── utils/             # Debug
│
├── ANALYSE_BESOIN.md      # Functional analysis (French)
├── LOGIQUE_CODE.md        # Detailed algorithms (French)
├── LOGIQUE_SERVOS_DETAILLEE.md  # Servo logic (French)
├── STRUCTURE_PROJET.md    # Code organization (French)
└── GUIDE_MIDIUSB.md       # MIDIUSB guide (French/English)
```

## 🎛️ Configuration

### Hardware (settings.h)

```cpp
#define NUM_STRINGS 4              // Number of strings
#define PCA_COUNT 4                // Number of PCA9685
#define PIN_OE 4                   // Output Enable pin
```

### Playing Modes

```cpp
#define LEGATO_MODE false          // No re-pluck
#define AUTO_MUTE true             // Auto mute on NOTE_OFF
#define VELOCITY_SENSITIVE false   // Velocity sensitivity
```

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [ANALYSE_BESOIN.md](ANALYSE_BESOIN.md) | Complete requirements analysis |
| [LOGIQUE_CODE.md](LOGIQUE_CODE.md) | Detailed flow diagrams |
| [LOGIQUE_SERVOS_DETAILLEE.md](LOGIQUE_SERVOS_DETAILLEE.md) | Fret and pluck logic |
| [STRUCTURE_PROJET.md](STRUCTURE_PROJET.md) | Code organization |
| [GUIDE_MIDIUSB.md](GUIDE_MIDIUSB.md) | Complete MIDIUSB guide |
| [src/README.md](src/README.md) | Code usage guide |
| [CHANGELOG.md](CHANGELOG.md) | Change history |

## 🎵 Usage

### MIDI Mode

1. Connect via USB
2. MIDI device is automatically recognized
3. Send NOTE_ON/NOTE_OFF messages from your DAW
4. System automatically maps notes to strings

### Debug Mode (Serial)

Enable `DEBUG_SERIAL_COMMANDS` in `settings.h`:

```
p60,80  → Play note 60 velocity 80
s60     → Stop note 60
a       → Stop all
i       → Display status
```

## 🔧 Calibration

### Calibration Steps

1. **Frets**: Set `angleOpen` (rest) and `angleClosed` (pressed)
2. **Pluck**: Set `pluckAngleCenter` and `pluckAmplitude`
3. **Test**: Validate with serial commands
4. **Fine-tune**: Adjust based on results

See [src/README.md](src/README.md) for detailed guide.

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
- Arduino/Teensy community
- All contributors

## 📧 Contact

For questions or suggestions: [GitHub Issues](https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors/issues)

---

**Made with ❤️ for music automation**
