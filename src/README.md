# Code Source - Orchestrion Plucked Strings Servomotors

## 📁 Structure du Projet

```
src/
├── main.ino                 # Fichier principal Arduino
│
├── config/                  # Configuration
│   ├── settings.h           # Paramètres globaux
│   └── string_configs.h     # Configuration des cordes
│
├── core/                    # Classes principales
│   ├── PCA9685Manager.h/cpp     # Gestion PCA9685
│   └── InstrumentManager.h/cpp  # Gestionnaire global
│
├── string/                  # Gestion des cordes
│   ├── StringInstrument.h/cpp   # Représentation d'une corde
│   ├── FretController.h/cpp     # Contrôle des frettes
│   └── PluckController.h/cpp    # Contrôle du grattage
│
├── midi/                    # Gestion MIDI
│   ├── MIDIHandler.h/cpp        # Réception MIDI
│   └── NoteMapper.h/cpp         # Conversion MIDI → Corde/Frette
│
└── utils/                   # Utilitaires
    └── Debug.h/cpp              # Debug et logging
```

## 🔧 Dépendances

### Bibliothèques Requises

Installez via le gestionnaire de bibliothèques Arduino:

1. **Adafruit PWM Servo Driver Library** (>= 2.4.0)
   - Auteur: Adafruit
   - Pour le contrôle des PCA9685

2. **MIDI Library** (>= 5.0.2)
   - Auteur: FortySevenEffects
   - Pour la réception MIDI

### Installation via Arduino IDE

```
Outils → Gérer les bibliothèques → Rechercher:
  - "Adafruit PWM Servo Driver"
  - "MIDI Library"
```

### Installation via PlatformIO

Ajoutez dans `platformio.ini`:
```ini
lib_deps =
    adafruit/Adafruit PWM Servo Driver Library @ ^2.4.0
    fortyseveneffects/MIDI Library @ ^5.0.2
```

## 🎛️ Configuration

### 1. Matériel (settings.h)

Modifiez selon votre setup:

```cpp
#define NUM_STRINGS 4              // Nombre de cordes
#define PCA_COUNT 4                // Nombre de PCA9685
#define PCA9685_BASE_ADDR 0x40     // Adresse I2C de base
#define PIN_OE 4                   // Pin Output Enable
```

### 2. Cordes (string_configs.h)

Configurez chaque corde:

```cpp
{
  .baseMidiNote = 40,            // Note MIDI à vide (E2)
  .numFrets = 12,                // Nombre de frettes

  .fretServos = {                // Mapping PCA+pin
    {0,0}, {0,1}, {0,2}, ...     // {pcaIndex, pin}
  },

  .pluckServo = {0, 12},         // Servo de grattage

  .fretCalibration = {           // Angles
    {45, 120}, ...               // {open, closed}
  },

  .pluckAngleCenter = 90,        // Position centrale
  .pluckAmplitude = 15,          // Amplitude ±15°
}
```

### 3. Modes de Jeu

Dans `settings.h`:

```cpp
#define LEGATO_MODE false          // Legato (pas de re-pluck)
#define AUTO_MUTE true             // Mute auto sur NOTE_OFF
#define VELOCITY_SENSITIVE false   // Sensibilité vélocité
```

### 4. Debug

```cpp
#define DEBUG                      // Logs série
//#define DEBUG_VERBOSE            // Logs détaillés
//#define DEBUG_SERIAL_COMMANDS    // Commandes test
//#define STARTUP_TEST             // Test démarrage
```

## 🚀 Compilation et Upload

### Arduino IDE

1. Ouvrir `src/main.ino`
2. Sélectionner la carte (Teensy 4.0 recommandé)
3. Installer les bibliothèques
4. Compiler et uploader

### PlatformIO

```bash
pio run -t upload
```

### Plateforme Recommandée

**Teensy 4.0** ou **Teensy 4.1**
- USB-MIDI natif
- Performances excellentes
- RAM suffisante (1MB)
- I2C fiable

Autres options:
- Arduino Mega (avec adaptateur USB-MIDI)
- ESP32 (BLE-MIDI ou adaptateur)

## 🎮 Utilisation

### Mode MIDI Normal

1. Connecter via USB-MIDI
2. Envoyer des messages NOTE_ON/NOTE_OFF
3. Le système mappe automatiquement les notes aux cordes

### Mode Debug (Série)

Activer `DEBUG_SERIAL_COMMANDS` dans settings.h

Commandes disponibles:
```
p60,80  - Jouer note 60 vélocité 80
s60     - Arrêter note 60
a       - Arrêter toutes les notes
i       - Afficher l'état
h       - Aide
```

### Moniteur Série

Ouvrir à 115200 bauds pour voir les logs:

```
========================================
  Orchestrion Plucked Strings Servos
========================================

System Information:
  Strings: 4
  PCA9685 count: 4
  I2C frequency: 400 kHz

Initializing PCA9685 controllers...
Init PCA9685 #0 @ 0x40
  OK
...
=== Instrument Ready ===
```

## 🔍 Calibration

### Étape 1: Frettes

Pour chaque frette, trouvez:
- **angleOpen**: Angle quand la corde est libre
- **angleClosed**: Angle quand le servo appuie sur la corde

Méthode:
1. Utiliser les commandes série
2. Tester différents angles
3. Noter les valeurs optimales
4. Mettre à jour `string_configs.h`

### Étape 2: Pluck

Trouvez:
- **pluckAngleCenter**: Position neutre (généralement 90°)
- **pluckAmplitude**: Amplitude d'oscillation (typiquement 10-20°)

### Étape 3: Sens de Rotation

Si un servo est monté à l'envers:
```cpp
.fretReversed = {true, false, ...}
```

## 🐛 Dépannage

### Servos ne bougent pas

- Vérifier alimentation (5-6V suffisant)
- Vérifier pin OE (doit être LOW pour enable)
- Vérifier adresses I2C des PCA9685

### I2C ne fonctionne pas

- Vérifier résistances pull-up (4.7kΩ)
- Tester avec i2c_scanner
- Réduire I2C_FREQUENCY si instable

### Notes incorrectes

- Vérifier `baseMidiNote` dans config
- Vérifier le mapping des servos
- Utiliser le moniteur série pour debug

### Latence importante

- Réduire `FRET_STABILIZATION_DELAY`
- Vérifier fréquence I2C (400kHz recommandé)
- Optimiser le code si nécessaire

## 📊 Monitoring

### État en Temps Réel

Commande `i` en mode debug:
```
=== Instrument Status ===
Servo power: ON
String 0: MIDI 45 (A2) fret 5
String 1: idle
String 2: MIDI 50 (D3) fret 0
String 3: idle
========================
```

### Logs MIDI

```
[MIDI] NOTE_ON - Ch:1 Note:60 (C4) Vel:80
MIDI 60 (C4) → String 2, Fret 10
Press fret 10 - angle: 120° (PCA2, pin 10)
Pluck - angle: 75° (A↓) PCA2, pin 12
```

## 🔧 Personnalisation

### Ajouter une Corde

1. Augmenter `NUM_STRINGS` dans settings.h
2. Ajouter une entrée dans `stringConfigs[]`
3. Configurer le mapping et la calibration

### Changer l'Accordage

Modifier `baseMidiNote` pour chaque corde:
```cpp
// Accordage Drop D
.baseMidiNote = 38,  // D2 au lieu de E2
```

### Ajouter des Frettes

1. Augmenter `numFrets`
2. Étendre les tableaux `fretServos` et `fretCalibration`

## 📚 Documentation Complète

Voir les fichiers à la racine du projet:
- `ANALYSE_BESOIN.md` - Architecture complète
- `LOGIQUE_CODE.md` - Algorithmes détaillés
- `LOGIQUE_SERVOS_DETAILLEE.md` - Logique des servos
- `STRUCTURE_PROJET.md` - Organisation du code

## 💡 Conseils

1. **Commencer simple**: Tester avec 1-2 cordes d'abord
2. **Calibrer minutieusement**: Prendre le temps de bien régler chaque servo
3. **Surveiller l'alimentation**: Vérifier la tension sous charge
4. **Logs utiles**: Activer DEBUG pendant le développement
5. **Tests progressifs**: Tester frettes, puis pluck, puis MIDI

## 🤝 Contribution

Le code est structuré pour faciliter l'ajout de fonctionnalités:
- Vibrato: Ajouter une classe `VibratoController`
- Bend: Modifier `FretController` pour positions intermédiaires
- Effets: Ajouter dans `StringInstrument`

Bon développement! 🎸
