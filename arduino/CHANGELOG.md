# Changelog - Historique des Modifications

## [Réorganisation & Audit] - 2026-08-03

### Réorganisation par plateforme
- **Regroupement de tout le projet Arduino dans `arduino/`**
  - Sketch déplacé et renommé : `src/main.ino` → `arduino/Servo-Plucked-String/Servo-Plucked-String.ino`
  - Modules placés sous `arduino/Servo-Plucked-String/src/` (compilés
    récursivement par l'IDE Arduino **et** PlatformIO)
  - Documentation déplacée dans `arduino/docs/`
- **Ajout d'un dossier `esp32/`** (placeholder + feuille de route pour la
  future version ESP32)
- **Page d'accueil racine** (`README.md` / `README_EN.md`) refondue en
  vue multi-plateforme

### Audit du code (voir `docs/AUDIT.md`)
- **[Critique] La corde n'était jamais grattée** : `#ifndef LEGATO_MODE`
  excluait `pluck()` (macro à valeur testée au préprocesseur) → instrument
  muet. Corrigé (test runtime `if`).
- **[Critique] Structure non compilable dans l'IDE Arduino** : les `.cpp` en
  sous-dossiers n'étaient pas compilés. Corrigé via le sous-dossier `src/`.
- **[Important] Préprocesseur mal employé** sur `AUTO_MUTE` /
  `VELOCITY_SENSITIVE` → tests runtime.
- **[Moyen] Décalage d'indice des frettes** : la note la plus haute de chaque
  corde échouait silencieusement. Corrigé (frette N → index N-1).
- **[Mineur]** test mort `if (angle < 0)` et variable `header` inutilisée.

### Ajouté
- `docs/LIMITES.md` — limites du projet (taille mémoire, rapidité/latence,
  polyphonie, plateformes supportées)
- `docs/AUDIT.md` — rapport d'audit et recommandations
- `platformio.ini` — environnements PlatformIO (Leonardo, Micro, Zero, Due)
- `MUTE_DELAY` dans `settings.h`

### Vérifié
- Compilation + édition de liens de tous les modules via en-têtes Arduino
  simulés (`g++ -std=c++17 -Wall -Wextra`, sans warning)

## [Non versionnée] - 2026-01-03

### Ajouté
- **Implémentation complète du code C++ Arduino** (20 fichiers)
  - Structure modulaire orientée objet
  - Configuration (settings.h, string_configs.h)
  - Core (PCA9685Manager, InstrumentManager)
  - String (StringInstrument, FretController, PluckController)
  - MIDI (MIDIHandler, NoteMapper)
  - Utils (Debug)
  - Main (main.ino → Servo-Plucked-String.ino)
  - Documentation complète (arduino/README.md)

- **Support MIDIUSB** pour communication MIDI via USB natif
  - Remplacement de la bibliothèque MIDI standard par MIDIUSB
  - Support USB natif pour Teensy, Leonardo, Micro, etc.
  - Pas de bibliothèque externe à installer
  - Latence ultra-faible (~1-3ms)
  - Guide complet MIDIUSB (GUIDE_MIDIUSB.md)

### Modifié
- **MIDIHandler**
  - AVANT: Utilisation de la bibliothèque MIDI avec callbacks
  - APRÈS: Utilisation de MIDIUSB avec polling
  - Format des messages: `midiEventPacket_t` au lieu de callbacks
  - Décodage manuel des messages MIDI (status byte, data bytes)

- **settings.h**
  - Suppression de `MIDI_BAUD` (non nécessaire avec USB)
  - Suppression de `MIDI_CHANNEL_OMNI` (tous les canaux écoutés automatiquement)

### Ajouté (suite)
- **Documentation détaillée de la logique des servos** (`LOGIQUE_SERVOS_DETAILLEE.md`)
  - Explication complète du servo de grattage (oscillation autour d'un centre)
  - Explication complète des servos de frettes (position ouverte/fermée)
  - Schémas visuels et timelines
  - Exemples de code complets

- **Système de mapping flexible pour les servomoteurs**
  - Introduction de la structure `ServoMapping` pour mapper individuellement chaque servo
  - Permet un câblage non-séquentiel des servos sur les PCA9685
  - Support pour répartir les servos d'une corde sur plusieurs PCA

- **Structure `FretCalibration`**
  - Nouvelle structure avec `angleOpen` (position repos) et `angleClosed` (position activée)
  - Permet une calibration indépendante pour chaque frette

### Modifié
- **Structure `StringConfig`**
  - AVANT: `firstFretPin` (pin de départ) + calcul `pin = firstFretPin + fretNum`
  - APRÈS: `fretServos[24]` (tableau de `ServoMapping` pour chaque frette)
  - AVANT: `pluckPin` (simple numéro de pin)
  - APRÈS: `pluckServo` (structure `ServoMapping` avec PCA et pin)

- **Calibration des frettes**
  - AVANT: `fretAngles[24]` (un seul angle par frette)
  - APRÈS: `fretCalibration[24]` (structure avec `angleOpen` + `angleClosed`)

- **Calibration du pluck**
  - AVANT: `pluckAngleA` et `pluckAngleB` (angles absolus)
  - APRÈS: `pluckAngleCenter` + `pluckAmplitude` (oscillation autour d'un centre)
  - Exemple: centre=90°, amplitude=15° → oscillation entre 75° et 105°

- **Logique de contrôle des servos**
  - Fonction `pressFret()`: utilise maintenant `fretServos[fretNum]` pour obtenir PCA et pin
  - Fonction `pluck()`: utilise `pluckServo` au lieu de `pluckPin`
  - Fonction `mute()`: utilise `pluckServo` au lieu de `pluckPin`
  - Fonction `moveServosToRestPosition()`: itère sur les mappings au lieu de calculer les pins

### Avantages du Nouveau Système

1. **Flexibilité de câblage**
   - Les frettes peuvent être branchées dans n'importe quel ordre
   - Pas besoin de respecter une séquence pins 0,1,2,3...
   - Adaptation facile aux contraintes mécaniques

2. **Résilience**
   - Si un pin PCA est défectueux, on peut facilement utiliser un autre pin
   - Modification dans la config, pas dans le code

3. **Optimisation**
   - Minimisation de la longueur des câbles
   - Répartition de la charge électrique sur plusieurs PCA
   - Organisation logique selon le layout physique

4. **Évolutivité**
   - Possibilité de laisser des pins libres pour futures fonctionnalités
   - Ajout facile de nouveaux servos (vibrato, bend, etc.)

### Exemples d'Usage

Voir `STRUCTURE_PROJET.md` pour 5 cas d'usage détaillés:
- Câblage séquentiel classique
- Contournement de pin défectueux
- Optimisation de la longueur des câbles
- Répartition multi-PCA
- Expansion future

## [Initiale] - 2026-01-03

### Ajouté
- Documentation complète du projet
  - `ANALYSE_BESOIN.md`: Étude fonctionnelle et architecture
  - `LOGIQUE_CODE.md`: Diagrammes de flux et algorithmes
  - `STRUCTURE_PROJET.md`: Organisation des fichiers et modules
- Architecture orientée objet modulaire
- Support pour 4 contrôleurs PCA9685 (jusqu'à 64 servos)
- Configuration flexible par cordes
- Gestion MIDI complète (NOTE_ON/NOTE_OFF)
- Système de mapping MIDI → Corde/Frette
