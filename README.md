# Orchestrion - Instrument à Cordes Contrôlé par MIDI

> Contrôle MIDI d'un instrument à cordes pincées (guitare, basse, ukulélé)
> utilisant des servomoteurs pour les frettes et le grattage.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Arduino](https://img.shields.io/badge/Arduino-Compatible-green.svg)](https://www.arduino.cc/)
[![MIDIUSB](https://img.shields.io/badge/MIDI-USB%20Native-orange.svg)](https://www.midi.org/)

[English version](README_EN.md) | **Version française**

## 📖 Description

Ce projet transforme un instrument à cordes en instrument automatisé
contrôlé par MIDI. Des servomoteurs actionnent les frettes pour changer les
notes et grattent les cordes en réponse aux messages MIDI reçus via USB.

Le dépôt est organisé **par plateforme matérielle**, chacune dans son
dossier :

| Plateforme | Dossier | État | MIDI |
|------------|---------|------|------|
| **Arduino / PCA9685** | [`arduino/`](arduino/) | ✅ Fonctionnel | USB natif (MIDIUSB) |
| **ESP32-S3 (servo-par-frette)** | [`esp32/`](esp32/) | ✅ Fonctionnel | Wi-Fi MIDI + CC corde/frette + SysEx |

👉 **Arduino** : [`arduino/README.md`](arduino/README.md) — installation, configuration,
calibration et utilisation.
👉 **ESP32** : [`esp32/README.md`](esp32/README.md) — version **servo-par-frette** (un
servo par position de frette, interface web + assistant d'installation, réception MIDI
avec CC de sélection corde/frette).

**Caractéristiques:**
- 🎸 Support multi-cordes (guitare, basse, ukulélé, etc.)
- 🎹 Contrôle MIDI via USB (latence ~1-3 ms)
- 🔧 Configuration flexible par fichiers
- 🎛️ Mapping PCA9685 individuel par servo
- ⚡ Gestion intelligente de l'alimentation
- 📊 Architecture orientée objet modulaire

## 🖼️ Principe de Fonctionnement

### Architecture Matérielle

Le système utilise des contrôleurs PCA9685 pour piloter les servomoteurs via I2C:

<img src="img/Schemas.png" alt="Architecture PCA9685" width="80%"/>

### Actionnement des Frettes

Différentes méthodes pour presser les cordes sur les frettes:

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/fingers%20servo.png" alt="Actionnement frettes" width="80%"/>

### Grattage des Cordes

Servo de grattage avec mouvement alterné (oscillation autour d'un centre):

<img src="https://github.com/glloq/OneStringGuitar/blob/main/img/grattage%20servo.png" alt="Grattage servo" width="60%"/>

## 📂 Structure du Dépôt

```
├── arduino/                    # ✅ Version Arduino (PCA9685 + MIDIUSB)
│   ├── README.md               #    Guide de la plateforme Arduino
│   ├── platformio.ini          #    Environnements PlatformIO
│   ├── CHANGELOG.md
│   ├── Servo-Plucked-String/   #    Sketch Arduino
│   │   ├── Servo-Plucked-String.ino
│   │   └── src/                #    Modules (config, core, string, midi, utils)
│   └── docs/                   #    Documentation détaillée + LIMITES + AUDIT
│
├── esp32/                      # ✅ Version ESP32-S3 (servo-par-frette)
│   ├── README.md               #    Guide de la plateforme ESP32
│   ├── firmware/               #    Firmware (cœur C++ testable + adaptateurs + tests)
│   ├── web-interface/          #    Interface web (wizard + assistant d'installation)
│   ├── instrument-profiles/    #    Profils prêts (ukulélé, guitare, basse, mandoline, banjo)
│   ├── board-profiles/         #    Carte ESP32-S3-DevKitC-1
│   └── docs/                   #    Documentation détaillée
│
├── img/                        # Schémas partagés
├── README.md                   # ce fichier
└── README_EN.md
```

## 🚀 Démarrage Rapide (Arduino)

1. **Matériel** : un **Arduino Leonardo** (ATmega32u4, USB natif) + un ou
   plusieurs **PCA9685** + servomoteurs + alimentation 5-6 V.
2. **Bibliothèques** : *Adafruit PWM Servo Driver* et *MIDIUSB*.
3. **Ouvrir** `arduino/Servo-Plucked-String/Servo-Plucked-String.ino` dans
   l'IDE Arduino (ou `pio run` avec `arduino/platformio.ini`).
4. **Configurer** vos cordes dans
   `arduino/Servo-Plucked-String/src/config/string_configs.h`.

Détails complets dans [`arduino/README.md`](arduino/README.md).

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [arduino/README.md](arduino/README.md) | Guide d'utilisation de la version Arduino |
| [arduino/docs/LIMITES.md](arduino/docs/LIMITES.md) | **Limites** (taille, rapidité, plateformes) |
| [arduino/docs/AUDIT.md](arduino/docs/AUDIT.md) | **Audit** du code et corrections |
| [arduino/docs/ANALYSE_BESOIN.md](arduino/docs/ANALYSE_BESOIN.md) | Analyse fonctionnelle |
| [arduino/docs/LOGIQUE_CODE.md](arduino/docs/LOGIQUE_CODE.md) | Diagrammes de flux détaillés |
| [arduino/docs/LOGIQUE_SERVOS_DETAILLEE.md](arduino/docs/LOGIQUE_SERVOS_DETAILLEE.md) | Logique frettes et pluck |
| [arduino/docs/STRUCTURE_PROJET.md](arduino/docs/STRUCTURE_PROJET.md) | Organisation du code |
| [arduino/docs/GUIDE_MIDIUSB.md](arduino/docs/GUIDE_MIDIUSB.md) | Guide MIDIUSB complet |
| [arduino/CHANGELOG.md](arduino/CHANGELOG.md) | Historique des modifications |
| [esp32/README.md](esp32/README.md) | Feuille de route ESP32 |

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
- Communauté Arduino
- Tous les contributeurs

## 📧 Contact

Pour toute question ou suggestion: [Issues GitHub](https://github.com/glloq/Orchestrion_Plucked_Strings_Servomotors/issues)

---

**Made with ❤️ for music automation**
