# Guide MIDIUSB

## 📖 Qu'est-ce que MIDIUSB?

MIDIUSB est une bibliothèque qui permet la communication MIDI directement via USB sans nécessiter de port MIDI hardware (DIN 5 broches). C'est la méthode native pour les cartes modernes comme Teensy, Leonardo, Micro, etc.

## 🔌 Avantages de MIDIUSB

### Par rapport au MIDI hardware (DIN)
- ✅ **Pas de circuit supplémentaire** - Juste un câble USB
- ✅ **Plug & Play** - Reconnu comme périphérique MIDI par l'ordinateur
- ✅ **Latence ultra-faible** - Communication USB directe
- ✅ **Pas de conversion** - Pas besoin d'adaptateur USB-MIDI

### Par rapport à la bibliothèque MIDI standard
- ✅ **USB natif** - Utilise le port USB de la carte
- ✅ **Intégrée** - Pas de bibliothèque externe à installer
- ✅ **Compatible multi-plateforme** - Windows, macOS, Linux

## 🎛️ Cartes Compatibles

### Compatibilité Complète (USB natif MIDI)
- **Teensy 3.x / 4.x** - Recommandé ⭐
- **Arduino Leonardo**
- **Arduino Micro**
- **Arduino Due**
- **Arduino Zero / MKR**
- **ESP32** (avec USB OTG)

### Non Compatible
- Arduino Uno (pas d'USB natif)
- Arduino Mega (pas d'USB natif)
- Arduino Nano (ancien modèle)

> **Note**: Les cartes non compatibles nécessitent un adaptateur USB-MIDI externe

## 🔧 Configuration dans Arduino IDE

### Teensy (Recommandé)

**Menu Outils → USB Type:**
- Sélectionner **"Serial + MIDI"** ou **"MIDI"**

```
USB Type: Serial + MIDI
```

Cela active le port MIDI USB natif.

### Arduino Leonardo/Micro

MIDIUSB est automatiquement disponible. Aucune configuration spéciale nécessaire.

## 📨 Format des Messages MIDI

### Structure midiEventPacket_t

```cpp
typedef struct {
  uint8_t header;  // Type de paquet
  uint8_t byte1;   // Status byte (type + canal)
  uint8_t byte2;   // Data byte 1
  uint8_t byte3;   // Data byte 2
} midiEventPacket_t;
```

### Exemple NOTE_ON

```
header = 0x09       // Note On event
byte1  = 0x90       // Note On sur canal 1 (0x90 = 1001 0000)
byte2  = 60         // Note number (C4)
byte3  = 80         // Velocity
```

### Décodage du Status Byte

```cpp
byte messageType = byte1 & 0xF0;  // Type de message (4 bits hauts)
byte channel = (byte1 & 0x0F) + 1; // Canal (4 bits bas, 1-16)

// Types de messages:
// 0x80 = Note Off
// 0x90 = Note On
// 0xB0 = Control Change
// 0xC0 = Program Change
// 0xE0 = Pitch Bend
```

## 💻 Utilisation dans le Code

### Lecture des Messages

```cpp
void process() {
  midiEventPacket_t event;

  do {
    event = MidiUSB.read();
    if (event.header != 0) {
      // Traiter le message
      processMidiMessage(event);
    }
  } while (event.header != 0);
}
```

### Traitement NOTE_ON

```cpp
void processMidiMessage(midiEventPacket_t event) {
  byte messageType = event.byte1 & 0xF0;
  byte channel = (event.byte1 & 0x0F) + 1;

  switch (messageType) {
    case 0x90:  // Note On
      if (event.byte3 > 0) {
        handleNoteOn(channel, event.byte2, event.byte3);
      } else {
        // Velocity 0 = Note Off
        handleNoteOff(channel, event.byte2, 0);
      }
      break;

    case 0x80:  // Note Off
      handleNoteOff(channel, event.byte2, event.byte3);
      break;
  }
}
```

## 🎹 Test de la Connexion

### Test Simple

Uploadez ce code pour tester:

```cpp
#include <MIDIUSB.h>

void setup() {
  Serial.begin(115200);
  Serial.println("MIDIUSB Test Ready");
}

void loop() {
  midiEventPacket_t event = MidiUSB.read();

  if (event.header != 0) {
    Serial.print("MIDI received - Type: 0x");
    Serial.print(event.byte1, HEX);
    Serial.print(" Note: ");
    Serial.print(event.byte2);
    Serial.print(" Vel: ");
    Serial.println(event.byte3);
  }
}
```

### Logiciels de Test

**Windows:**
- MIDI-OX
- ASIO4ALL (pour latence faible)

**macOS:**
- Audio MIDI Setup (intégré)
- MIDI Monitor

**Linux:**
- amidi
- QjackCtl

### Commande Test (Linux/macOS)

```bash
# Lister les périphériques MIDI
aseqdump -l

# Écouter les événements MIDI
aseqdump -p "Teensy MIDI"
```

## 🐛 Dépannage

### Périphérique MIDI non détecté

**Vérifier:**
1. USB Type dans Arduino IDE (doit être MIDI ou Serial+MIDI)
2. Câble USB (certains câbles sont charge-only)
3. Drivers USB (généralement auto-installés)

**Teensy:**
```
Outils → USB Type → Serial + MIDI
Outils → Port → (sélectionner le port Teensy)
```

### Messages MIDI non reçus

**Vérifier:**
1. Logiciel MIDI envoie sur le bon périphérique
2. Canal MIDI correct (le code écoute tous les canaux)
3. Moniteur série pour voir les logs

### Latence importante

**Optimisations:**
1. Utiliser `MidiUSB.read()` dans `loop()` sans delay
2. Ne pas utiliser `Serial.print()` pour chaque message en production
3. Désactiver DEBUG en production

## 📊 Performances

### Latence Typique

```
USB MIDI natif:     ~1-3 ms
MIDI hardware:      ~3-5 ms
MIDI via Serial:    ~5-10 ms
```

### Throughput

MIDIUSB peut gérer:
- **~1000 messages/seconde** sans problème
- Suffisant pour jeu en temps réel même dense

## 🔄 Migration depuis MIDI Library

### Ancien Code (MIDI Library)

```cpp
#include <MIDI.h>
MIDI_CREATE_DEFAULT_INSTANCE();

void setup() {
  MIDI.begin(MIDI_CHANNEL_OMNI);
  MIDI.setHandleNoteOn(handleNoteOn);
  MIDI.setHandleNoteOff(handleNoteOff);
}

void loop() {
  MIDI.read();
}
```

### Nouveau Code (MIDIUSB)

```cpp
#include <MIDIUSB.h>

void setup() {
  // Pas d'initialisation nécessaire
}

void loop() {
  midiEventPacket_t event;
  do {
    event = MidiUSB.read();
    if (event.header != 0) {
      processMidiMessage(event);
    }
  } while (event.header != 0);
}

void processMidiMessage(midiEventPacket_t event) {
  byte type = event.byte1 & 0xF0;
  if (type == 0x90) {  // Note On
    handleNoteOn(event.byte2, event.byte3);
  } else if (type == 0x80) {  // Note Off
    handleNoteOff(event.byte2);
  }
}
```

## 📚 Ressources

### Documentation Officielle
- [MIDIUSB Library Reference](https://www.arduino.cc/reference/en/libraries/midiusb/)
- [USB MIDI Specification](https://www.usb.org/sites/default/files/midi10.pdf)

### Exemples
- Arduino IDE → Fichier → Exemples → MIDIUSB
- [Teensy MIDI Examples](https://www.pjrc.com/teensy/td_midi.html)

## 💡 Conseils

1. **Toujours utiliser le mode Serial + MIDI** pendant le développement pour avoir les logs
2. **Passer en mode MIDI pur** en production pour économiser la RAM
3. **Tester avec un logiciel MIDI** avant de tester avec votre DAW
4. **Désactiver DEBUG** en production pour de meilleures performances

## 🎵 Utilisation avec DAWs

### Ableton Live
1. Préférences → Link/MIDI
2. Activer "Track" et "Remote" pour le périphérique Teensy

### FL Studio
1. Options → MIDI Settings
2. Activer le périphérique Teensy dans la liste

### Reaper
1. Options → Preferences → MIDI Devices
2. Activer le périphérique et choisir le mode

### Logic Pro
1. Préférences → MIDI
2. Le périphérique devrait apparaître automatiquement

Profitez de la communication MIDI USB native! 🎸
