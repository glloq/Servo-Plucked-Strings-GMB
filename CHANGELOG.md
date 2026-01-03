# Changelog - Historique des Modifications

## [Non versionnée] - 2026-01-03

### Ajouté
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
