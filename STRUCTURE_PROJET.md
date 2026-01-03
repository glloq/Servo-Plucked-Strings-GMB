# Structure du Projet - Organisation des Fichiers

## 1. ARBORESCENCE PROPOSÉE

```
Orchestrion_Plucked_Strings_Servomotors/
│
├── README.md                          # Documentation principale
├── ANALYSE_BESOIN.md                  # Étude du besoin
├── LOGIQUE_CODE.md                    # Logique détaillée
├── STRUCTURE_PROJET.md                # Ce fichier
│
├── img/                               # Images et schémas
│   ├── Schemas.png
│   └── ...
│
├── src/                               # Code source principal
│   ├── main.ino                       # Fichier principal Arduino
│   │
│   ├── config/                        # Configuration
│   │   ├── settings.h                 # Paramètres globaux
│   │   ├── string_configs.h           # Configuration des cordes
│   │   └── pins.h                     # Définition des pins
│   │
│   ├── core/                          # Classes principales
│   │   ├── PCA9685Manager.h
│   │   ├── PCA9685Manager.cpp
│   │   ├── ServoController.h
│   │   ├── ServoController.cpp
│   │   ├── InstrumentManager.h
│   │   └── InstrumentManager.cpp
│   │
│   ├── string/                        # Gestion des cordes
│   │   ├── StringInstrument.h
│   │   ├── StringInstrument.cpp
│   │   ├── FretController.h
│   │   ├── FretController.cpp
│   │   ├── PluckController.h
│   │   └── PluckController.cpp
│   │
│   ├── midi/                          # Gestion MIDI
│   │   ├── MIDIHandler.h
│   │   ├── MIDIHandler.cpp
│   │   ├── NoteMapper.h
│   │   └── NoteMapper.cpp
│   │
│   └── utils/                         # Utilitaires
│       ├── Debug.h
│       ├── Debug.cpp
│       ├── SerialCommands.h
│       └── SerialCommands.cpp
│
├── examples/                          # Exemples de configuration
│   ├── 4_string_bass/
│   │   └── string_configs.h
│   ├── 6_string_guitar/
│   │   └── string_configs.h
│   └── ukulele/
│       └── string_configs.h
│
├── tools/                             # Outils de calibration
│   ├── calibration_tool.ino           # Outil de calibration interactive
│   └── servo_tester.ino               # Test individuel des servos
│
└── docs/                              # Documentation supplémentaire
    ├── wiring_diagram.png
    ├── calibration_guide.md
    └── troubleshooting.md
```

## 2. DESCRIPTION DES MODULES

### 2.1 Fichier Principal (main.ino)

**Rôle** : Point d'entrée, setup() et loop()

```cpp
#include "config/settings.h"
#include "core/InstrumentManager.h"
#include "midi/MIDIHandler.h"
#include "utils/Debug.h"

// Objets globaux
InstrumentManager instrument;
MIDIHandler midiHandler;

void setup() {
  // Initialisation
  Debug::init();
  instrument.init();
  midiHandler.init(&instrument);

  Debug::log("System ready!");
}

void loop() {
  // Traiter les messages MIDI
  midiHandler.process();

  // Vérifier les timeouts
  instrument.update();

  // Commandes série (debug)
  #ifdef DEBUG_SERIAL_COMMANDS
  SerialCommands::process(&instrument);
  #endif
}
```

### 2.2 Module Configuration

#### settings.h - Paramètres Globaux

```cpp
#ifndef SETTINGS_H
#define SETTINGS_H

// ========== CONFIGURATION MATÉRIELLE ==========
#define NUM_STRINGS 4              // Nombre de cordes
#define PCA_COUNT 4                // Nombre de PCA9685
#define PCA9685_BASE_ADDR 0x40     // Adresse I2C de base
#define PIN_OE 4                   // Pin Output Enable (inversé)
#define I2C_FREQUENCY 400000       // 400kHz

// ========== TIMING ==========
#define FRET_PRESS_DELAY 100       // Délai stabilisation frette (ms)
#define PLUCK_DELAY 50             // Durée impulsion pluck (ms)
#define SERVO_TIMEOUT 5000         // Timeout inactivité (ms)

// ========== CALIBRATION SERVO ==========
#define SERVO_MIN_PULSE 150        // Pulse min (≈1ms sur 4096)
#define SERVO_MAX_PULSE 600        // Pulse max (≈2ms sur 4096)
#define SERVO_FREQ 50              // Fréquence PWM (Hz)

// ========== MIDI ==========
#define MIDI_CHANNEL MIDI_CHANNEL_OMNI  // Tous les canaux
#define MIDI_BAUD 31250            // Vitesse MIDI standard

// ========== MODES DE JEU ==========
#define LEGATO_MODE false          // true = pas de re-pluck sur même corde
#define AUTO_MUTE true             // true = mute automatique sur NOTE_OFF
#define VELOCITY_SENSITIVE false   // true = velocity → force pluck

// ========== DEBUG ==========
#define DEBUG                      // Activer logs série
//#define DEBUG_VERBOSE            // Logs détaillés
//#define DEBUG_SERIAL_COMMANDS    // Commandes test via série
//#define STARTUP_TEST             // Test au démarrage

#endif
```

#### string_configs.h - Configuration des Cordes

```cpp
#ifndef STRING_CONFIGS_H
#define STRING_CONFIGS_H

#include <Arduino.h>

// ========== STRUCTURE DE CONFIGURATION ==========
struct StringConfig {
  uint8_t baseMidiNote;         // Note MIDI à vide
  uint8_t numFrets;             // Nombre de frettes
  uint8_t pcaIndex;             // Index du PCA9685 (0-3)
  uint8_t firstFretPin;         // Pin de la 1ère frette
  uint8_t pluckPin;             // Pin du servo pluck

  // Calibration des frettes
  uint16_t fretAngles[24];      // Angle d'activation (max 24 frettes)
  bool fretReversed[24];        // Sens inversé?

  // Calibration du pluck
  uint16_t pluckAngleA;         // 1er angle
  uint16_t pluckAngleB;         // 2ème angle (alternance)
  uint16_t pluckMuteAngle;      // Angle mute
};

// ========== CONFIGURATION BASSE 4 CORDES ==========
// Accordage standard: E-A-D-G

const StringConfig stringConfigs[NUM_STRINGS] = {
  // Corde 0: E2 (MIDI 40)
  {
    .baseMidiNote = 40,           // E2
    .numFrets = 12,
    .pcaIndex = 0,
    .firstFretPin = 0,            // Pins 0-11 pour frettes
    .pluckPin = 12,               // Pin 12 pour pluck

    // Angles frettes (à calibrer)
    .fretAngles = {90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90},
    .fretReversed = {false, false, false, false, false, false,
                     false, false, false, false, false, false},

    // Angles pluck
    .pluckAngleA = 45,
    .pluckAngleB = 135,
    .pluckMuteAngle = 90
  },

  // Corde 1: A2 (MIDI 45)
  {
    .baseMidiNote = 45,
    .numFrets = 12,
    .pcaIndex = 1,
    .firstFretPin = 0,
    .pluckPin = 12,

    .fretAngles = {90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90},
    .fretReversed = {false, false, false, false, false, false,
                     false, false, false, false, false, false},

    .pluckAngleA = 45,
    .pluckAngleB = 135,
    .pluckMuteAngle = 90
  },

  // Corde 2: D3 (MIDI 50)
  {
    .baseMidiNote = 50,
    .numFrets = 12,
    .pcaIndex = 2,
    .firstFretPin = 0,
    .pluckPin = 12,

    .fretAngles = {90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90},
    .fretReversed = {false, false, false, false, false, false,
                     false, false, false, false, false, false},

    .pluckAngleA = 45,
    .pluckAngleB = 135,
    .pluckMuteAngle = 90
  },

  // Corde 3: G3 (MIDI 55)
  {
    .baseMidiNote = 55,
    .numFrets = 12,
    .pcaIndex = 3,
    .firstFretPin = 0,
    .pluckPin = 12,

    .fretAngles = {90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90},
    .fretReversed = {false, false, false, false, false, false,
                     false, false, false, false, false, false},

    .pluckAngleA = 45,
    .pluckAngleB = 135,
    .pluckMuteAngle = 90
  }
};

#endif
```

### 2.3 Module Core

#### PCA9685Manager.h

```cpp
#ifndef PCA9685_MANAGER_H
#define PCA9685_MANAGER_H

#include <Adafruit_PWMServoDriver.h>
#include "config/settings.h"

/**
 * Gère la communication avec les contrôleurs PCA9685
 */
class PCA9685Manager {
private:
  Adafruit_PWMServoDriver controllers[PCA_COUNT];
  bool initialized[PCA_COUNT];

public:
  PCA9685Manager();

  // Initialisation
  bool init();
  bool initController(uint8_t index);

  // Contrôle PWM
  bool setPWM(uint8_t pcaIndex, uint8_t pin, uint16_t value);
  bool setAngle(uint8_t pcaIndex, uint8_t pin, uint16_t angle);

  // Utilitaires
  uint16_t angleToPWM(uint16_t angle);
  bool isInitialized(uint8_t pcaIndex);
};

#endif
```

#### InstrumentManager.h

```cpp
#ifndef INSTRUMENT_MANAGER_H
#define INSTRUMENT_MANAGER_H

#include "PCA9685Manager.h"
#include "config/string_configs.h"
#include "../string/StringInstrument.h"

/**
 * Gère l'ensemble de l'instrument
 */
class InstrumentManager {
private:
  PCA9685Manager pcaManager;
  StringInstrument strings[NUM_STRINGS];
  bool servoPowerEnabled;
  unsigned long lastActivity;

public:
  InstrumentManager();

  // Initialisation
  bool init();

  // Contrôle des notes
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(uint8_t midiNote);

  // Gestion de l'alimentation
  void enableServoPower();
  void disableServoPower();

  // Mise à jour périodique
  void update();

  // Accès aux cordes
  StringInstrument* getString(uint8_t index);
  PCA9685Manager* getPCAManager();

  // Debug
  void printStatus();
};

#endif
```

### 2.4 Module String

#### StringInstrument.h

```cpp
#ifndef STRING_INSTRUMENT_H
#define STRING_INSTRUMENT_H

#include "FretController.h"
#include "PluckController.h"
#include "config/string_configs.h"

/**
 * Représente une corde complète de l'instrument
 */
class StringInstrument {
private:
  StringConfig config;
  FretController fretController;
  PluckController pluckController;

  // État
  int8_t currentFret;           // -1 si aucune
  uint8_t currentMidiNote;
  bool isPlaying;
  unsigned long lastActivity;

public:
  StringInstrument();

  // Initialisation
  void init(const StringConfig& cfg, PCA9685Manager* pcaManager);

  // Contrôle
  bool playNote(uint8_t midiNote, uint8_t velocity);
  bool stopNote(bool mute);

  // État
  bool canPlayNote(uint8_t midiNote);
  uint8_t getCurrentNote() { return currentMidiNote; }
  bool getIsPlaying() { return isPlaying; }

  // Accès
  StringConfig& getConfig() { return config; }
};

#endif
```

#### FretController.h

```cpp
#ifndef FRET_CONTROLLER_H
#define FRET_CONTROLLER_H

#include "../core/PCA9685Manager.h"
#include "config/string_configs.h"

/**
 * Contrôle les servomoteurs de frettes
 */
class FretController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  int8_t activeFret;

public:
  FretController();

  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Contrôle
  bool pressFret(uint8_t fretNum);
  bool releaseFret(uint8_t fretNum);
  bool releaseAll();

  // État
  int8_t getActiveFret() { return activeFret; }
};

#endif
```

#### PluckController.h

```cpp
#ifndef PLUCK_CONTROLLER_H
#define PLUCK_CONTROLLER_H

#include "../core/PCA9685Manager.h"
#include "config/string_configs.h"

/**
 * Contrôle le servomoteur de grattage
 */
class PluckController {
private:
  StringConfig* config;
  PCA9685Manager* pcaManager;
  bool currentAngleState;  // false=A, true=B

public:
  PluckController();

  void init(StringConfig* cfg, PCA9685Manager* pca);

  // Actions
  bool pluck();
  bool mute();
  bool setPosition(uint16_t angle);

  // Utilitaires
  void alternate() { currentAngleState = !currentAngleState; }
};

#endif
```

### 2.5 Module MIDI

#### MIDIHandler.h

```cpp
#ifndef MIDI_HANDLER_H
#define MIDI_HANDLER_H

#include <MIDI.h>
#include "../core/InstrumentManager.h"

/**
 * Gère la réception et le traitement des messages MIDI
 */
class MIDIHandler {
private:
  InstrumentManager* instrument;

  // Callbacks MIDI
  static void handleNoteOnStatic(byte channel, byte note, byte velocity);
  static void handleNoteOffStatic(byte channel, byte note, byte velocity);

  void handleNoteOn(byte channel, byte note, byte velocity);
  void handleNoteOff(byte channel, byte note, byte velocity);

public:
  MIDIHandler();

  void init(InstrumentManager* inst);
  void process();

  static MIDIHandler* instance;  // Pour callbacks statiques
};

#endif
```

#### NoteMapper.h

```cpp
#ifndef NOTE_MAPPER_H
#define NOTE_MAPPER_H

#include <Arduino.h>
#include "config/string_configs.h"

/**
 * Conversion note MIDI → corde/frette
 */
struct NoteMapping {
  int8_t stringIndex;
  int8_t fretNumber;
  bool valid;
};

class NoteMapper {
public:
  static NoteMapping mapNote(uint8_t midiNote);
  static const char* noteToString(uint8_t midiNote);
};

#endif
```

## 3. DÉPENDANCES EXTERNES

### 3.1 Bibliothèques Arduino Requises

```cpp
// À installer via le gestionnaire de bibliothèques Arduino

#include <Wire.h>                      // I2C (intégré)
#include <Adafruit_PWMServoDriver.h>   // Contrôle PCA9685
#include <MIDI.h>                      // USB-MIDI
```

### 3.2 Installation des Bibliothèques

```bash
# Via Arduino IDE:
# Outils → Gérer les bibliothèques → Rechercher:
# - "Adafruit PWM Servo Driver Library"
# - "MIDI Library" (FortySevenEffects)

# Via PlatformIO:
lib_deps =
    adafruit/Adafruit PWM Servo Driver Library @ ^2.4.0
    fortyseveneffects/MIDI Library @ ^5.0.2
```

## 4. PLATEFORME CIBLE

### 4.1 Recommandations Microcontrôleur

| Plateforme    | RAM  | Flash | I2C | USB-MIDI | Recommandation |
|---------------|------|-------|-----|----------|----------------|
| Arduino Uno   | 2KB  | 32KB  | ✓   | ✗        | ✗ Insuffisant  |
| Arduino Mega  | 8KB  | 256KB | ✓   | ✗        | ⚠ Possible*    |
| Teensy 3.2    | 64KB | 256KB | ✓   | ✓        | ✓ Recommandé   |
| Teensy 4.0    | 1MB  | 2MB   | ✓   | ✓        | ✓ Excellent    |
| ESP32         | 520KB| 4MB   | ✓   | ✗**      | ⚠ Possible     |

\* Nécessite adaptateur USB-MIDI externe
\*\* Nécessite BLE-MIDI ou adaptateur

### 4.2 Configuration Recommandée

**Choix optimal : Teensy 4.0**
- USB-MIDI natif
- Performances excellentes
- I2C fiable et rapide
- Debugging facile

## 5. FICHIER platformio.ini (optionnel)

```ini
[env:teensy40]
platform = teensy
board = teensy40
framework = arduino

lib_deps =
    adafruit/Adafruit PWM Servo Driver Library @ ^2.4.0
    fortyseveneffects/MIDI Library @ ^5.0.2

build_flags =
    -D USB_MIDI
    -D DEBUG

monitor_speed = 115200
```

## 6. CHECKLIST AVANT IMPLÉMENTATION

- [ ] Choisir la plateforme matérielle (Teensy 4.0 recommandé)
- [ ] Définir le nombre de cordes (4, 5, 6...)
- [ ] Définir le nombre de frettes par corde
- [ ] Calculer le nombre de PCA9685 nécessaires
- [ ] Planifier l'alimentation (5V/6V, ampérage suffisant)
- [ ] Préparer le câblage I2C (pull-ups si nécessaire)
- [ ] Installer les bibliothèques requises
- [ ] Créer le fichier string_configs.h personnalisé

## PROCHAINES ÉTAPES

1. **Validation de la structure** : Confirmer l'organisation proposée
2. **Implémentation du code** : Coder les classes une par une
3. **Tests unitaires** : Tester chaque module individuellement
4. **Intégration** : Assembler le système complet
5. **Calibration** : Régler les angles des servos
6. **Tests réels** : Valider sur l'instrument physique

Prêt à commencer l'implémentation?
