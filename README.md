# Orchestrion - Instrument à Cordes Contrôlé par MIDI

> Contrôle MIDI d'un instrument à cordes pincées (guitare, basse, ukulélé) utilisant des servomoteurs pour les frettes et le grattage.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Arduino](https://img.shields.io/badge/Arduino-Compatible-green.svg)](https://www.arduino.cc/)
[![MIDIUSB](https://img.shields.io/badge/MIDI-USB%20Native-orange.svg)](https://www.midi.org/)

[English version](README_EN.md) | **Version française**

## 📖 Description

Ce projet permet de transformer un instrument à cordes en instrument automatisé contrôlé par MIDI. Des servomoteurs actionnent les frettes pour changer les notes et grattent les cordes en réponse aux messages MIDI reçus via USB.

**Caractéristiques:**
- 🎸 Support multi-cordes (guitare, basse, ukulélé, etc.)
- 🎹 Contrôle MIDI via USB (latence ~1-3ms)
- 🔧 Configuration flexible par fichiers
- 🎛️ Mapping PCA9685 individuel par servo
- ⚡ Gestion intelligente de l'alimentation
- 📊 Architecture orientée objet modulaire

## 🖼️ Principe de Fonctionnement

### Architecture Matérielle

Le système utilise des contrôleurs PCA9685 pour piloter les servomoteurs via I2C:

<img src="https://raw.githubusercontent.com/glloq/Orchestrion_Plucked_Strings_Servomotors/main/img/Schemas.png?raw=true" alt="Architecture PCA9685" width="80%"/>

### Actionnement des Frettes

Différentes méthodes pour presser les cordes sur les frettes:

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/fingers%20servo.png" alt="Actionnement frettes" width="80%"/>

### Grattage des Cordes

Servo de grattage avec mouvement alterné (oscillation autour d'un centre):

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/grattage%20servo.png" alt="Grattage servo" width="60%"/>

## 🚀 Démarrage Rapide

### Matériel Requis

- **Microcontrôleur**: Teensy 4.0/4.1 (recommandé) ou Arduino Leonardo/Micro
- **Contrôleurs servo**: PCA9685 (jusqu'à 4 pour 64 servos)
- **Servomoteurs**: Pour frettes et grattage
- **Alimentation**: 5-6V suffisante pour tous les servos

### Installation

1. **Cloner le repository**
```bash
git clone https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors.git
```

2. **Installer les bibliothèques** (Arduino IDE)
```
Outils → Gérer les bibliothèques → Rechercher:
  - "Adafruit PWM Servo Driver"
```

3. **Configuration Teensy**
```
Outils → USB Type → "Serial + MIDI"
```

4. **Compiler et uploader**
Ouvrir `src/main.ino` et uploader sur la carte

### Configuration de Base

Éditer `src/config/string_configs.h`:

```cpp
const StringConfig stringConfigs[NUM_STRINGS] = {
  {
    .baseMidiNote = 40,           // Note MIDI à vide (E2)
    .numFrets = 12,               // Nombre de frettes

    .fretServos = {               // Mapping PCA+pin
      {0,0}, {0,1}, {0,2}, ...    // {pcaIndex, pin}
    },

    .pluckServo = {0, 12},        // Servo grattage

    .fretCalibration = {          // Calibration
      {45, 120}, ...              // {angleOpen, angleClosed}
    },

    .pluckAngleCenter = 90,       // Centre oscillation
    .pluckAmplitude = 15,         // Amplitude ±15°
  }
};
```

## 📂 Structure du Projet

```
├── src/                    # Code source Arduino
│   ├── main.ino           # Programme principal
│   ├── config/            # Configuration (settings.h, string_configs.h)
│   ├── core/              # PCA9685Manager, InstrumentManager
│   ├── string/            # StringInstrument, FretController, PluckController
│   ├── midi/              # MIDIHandler, NoteMapper
│   └── utils/             # Debug
│
├── ANALYSE_BESOIN.md      # Analyse fonctionnelle
├── LOGIQUE_CODE.md        # Algorithmes détaillés
├── LOGIQUE_SERVOS_DETAILLEE.md  # Logique des servos
├── STRUCTURE_PROJET.md    # Organisation du code
└── GUIDE_MIDIUSB.md       # Guide MIDIUSB
```

## 🎛️ Configuration

### Matériel (settings.h)

```cpp
#define NUM_STRINGS 4              // Nombre de cordes
#define PCA_COUNT 4                // Nombre de PCA9685
#define PIN_OE 4                   // Pin Output Enable
```

### Modes de Jeu

```cpp
#define LEGATO_MODE false          // Pas de re-grattage
#define AUTO_MUTE true             // Mute auto sur NOTE_OFF
#define VELOCITY_SENSITIVE false   // Sensibilité vélocité
```

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [ANALYSE_BESOIN.md](ANALYSE_BESOIN.md) | Analyse complète du besoin |
| [LOGIQUE_CODE.md](LOGIQUE_CODE.md) | Diagrammes de flux détaillés |
| [LOGIQUE_SERVOS_DETAILLEE.md](LOGIQUE_SERVOS_DETAILLEE.md) | Logique frettes et pluck |
| [STRUCTURE_PROJET.md](STRUCTURE_PROJET.md) | Organisation du code |
| [GUIDE_MIDIUSB.md](GUIDE_MIDIUSB.md) | Guide MIDIUSB complet |
| [src/README.md](src/README.md) | Guide d'utilisation du code |
| [CHANGELOG.md](CHANGELOG.md) | Historique des modifications |

## 🎵 Utilisation

### Mode MIDI

1. Connecter via USB
2. Le périphérique MIDI est reconnu automatiquement
3. Envoyer des messages NOTE_ON/NOTE_OFF depuis votre DAW
4. Le système mappe automatiquement les notes aux cordes

### Mode Debug (Série)

Activer `DEBUG_SERIAL_COMMANDS` dans `settings.h`:

```
p60,80  → Jouer note 60 vélocité 80
s60     → Arrêter note 60
a       → Tout arrêter
i       → Afficher l'état
```

## 🔧 Calibration

### Étapes de Calibration

1. **Frettes**: Régler `angleOpen` (repos) et `angleClosed` (appuyé)
2. **Pluck**: Régler `pluckAngleCenter` et `pluckAmplitude`
3. **Test**: Valider avec les commandes série
4. **Affiner**: Ajuster selon le résultat

Voir [src/README.md](src/README.md) pour le guide détaillé.

## 🤝 Contribution

Les contributions sont les bienvenues! N'hésitez pas à:
- 🐛 Signaler des bugs
- 💡 Proposer des fonctionnalités
- 📖 Améliorer la documentation
- 🔧 Soumettre des pull requests

## 📄 Licence

Ce projet est sous licence MIT - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 🙏 Remerciements

- [Adafruit](https://www.adafruit.com/) pour la bibliothèque PCA9685
- Communauté Arduino/Teensy
- Tous les contributeurs

## 📧 Contact

Pour toute question ou suggestion: [Issues GitHub](https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors/issues)

---

**Made with ❤️ for music automation**
