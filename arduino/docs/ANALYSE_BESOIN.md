# Étude du Besoin - Instrument à Cordes Contrôlé par MIDI avec Servomoteurs

## 1. OBJECTIF DU PROJET

Créer un système de contrôle automatisé d'un instrument à cordes pincées (guitare, basse, ukulélé) via MIDI, utilisant :
- Des servomoteurs pour actionner les frettes (changement de notes)
- Des servomoteurs pour gratter les cordes (pluck)
- Des contrôleurs PCA9685 pour piloter les servomoteurs via I2C

## 2. ANALYSE FONCTIONNELLE

### 2.1 Fonctions Principales

#### A. Réception MIDI
- Écouter les messages MIDI via USB
- Traiter les messages NOTE_ON (début de note)
- Traiter les messages NOTE_OFF (fin de note)
- Gérer le velocity (intensité de la note)

#### B. Calcul de Position
- Convertir le numéro MIDI en corde + frette
- Déterminer quelle corde jouer (selon l'accord de base)
- Calculer quelle frette actionner (si nécessaire)
- Gérer les cas d'impossibilité (note hors portée)

#### C. Contrôle des Frettes
- Activer le servomoteur de frette (appui)
- Désactiver le servomoteur de frette (relâchement)
- Gérer l'angle d'activation selon la configuration
- Gérer le sens de rotation (selon le montage mécanique)

#### D. Contrôle du Grattage
- Gratter la corde au bon moment (après activation frette)
- Alterner l'angle de grattage (pour simulation pick)
- Étouffer la note sur NOTE_OFF (optionnel)
- Synchroniser grattage et frettes

#### E. Gestion Énergétique
- Couper l'alimentation des servos au repos (pin OE du PCA9685)
- Réactiver uniquement lors du jeu
- Économiser l'énergie et éviter la surchauffe

### 2.2 Contraintes Techniques

#### Matériel
- Jusqu'à 16 servos par PCA9685
- Plusieurs PCA9685 en cascade possible (adresses I2C différentes)
- Timing précis requis (coordination frettes/grattage)
- Alimentation suffisante pour tous les servos

#### Performance
- Latence minimale entre MIDI et action mécanique
- Réactivité pour jeu en temps réel
- Pas de conflit I2C entre multiples PCA9685

#### Fiabilité
- Gestion des erreurs (servo bloqué, I2C défaillant)
- Calibration persistante des positions
- Protection contre les commandes invalides

## 3. ARCHITECTURE MATÉRIELLE

### 3.1 Composants

```
┌─────────────┐
│ Microcontrôleur │ (Arduino, Teensy, ESP32, etc.)
│ avec USB-MIDI   │
└────┬────────┘
     │ I2C
     ├──────────┬──────────┬──────────┐
     │          │          │          │
┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐
│PCA9685 │ │PCA9685 │ │PCA9685 │ │PCA9685 │
│ Adr:0x40│ │Adr:0x41│ │Adr:0x42│ │Adr:0x43│
└────┬───┘ └───┬────┘ └───┬────┘ └───┬────┘
     │         │          │          │
  16 servos 16 servos  16 servos  16 servos
```

### 3.2 Mapping Exemple (4 cordes)

**Corde 1** (Mi grave - E2, MIDI 40)
- Frettes 1-12 : PCA9685 #0, pins 0-11
- Servo pluck : PCA9685 #0, pin 12

**Corde 2** (La - A2, MIDI 45)
- Frettes 1-12 : PCA9685 #1, pins 0-11
- Servo pluck : PCA9685 #1, pin 12

**Corde 3** (Ré - D3, MIDI 50)
- Frettes 1-12 : PCA9685 #2, pins 0-11
- Servo pluck : PCA9685 #2, pin 12

**Corde 4** (Sol - G3, MIDI 55)
- Frettes 1-12 : PCA9685 #3, pins 0-11
- Servo pluck : PCA9685 #3, pin 12

## 4. ARCHITECTURE LOGICIELLE

### 4.1 Structure Orientée Objet

```
┌─────────────────┐
│  MIDIController │  ← Réception et parsing MIDI
└────┬────────────┘
     │
┌────▼──────────────┐
│ NoteMapper        │  ← Conversion MIDI → Corde/Frette
└────┬──────────────┘
     │
┌────▼──────────────┐
│ InstrumentManager │  ← Gestion globale de l'instrument
└────┬──────────────┘
     │
     ├─────┬─────┬─────┬─────┐
     │     │     │     │     │
┌────▼──┐ │     │     │     │
│String │ │     │     │     │  ← Objet représentant 1 corde
│  #1   │ │     │     │     │
└───┬───┘ │     │     │     │
    │     │     │     │     │
┌───▼──────▼──┐  │     │     │
│FretController│  │     │     │  ← Contrôle des servos de frette
└──────────────┘  │     │     │
                  │     │     │
┌─────────────────▼─────▼─────▼─┐
│   PluckController             │  ← Contrôle du servo de grattage
└───────────────────────────────┘
         │
┌────────▼────────┐
│ PCA9685Manager  │  ← Gestion bas niveau I2C
└─────────────────┘
```

### 4.2 Classes Principales

#### Classe `PCA9685Manager`
**Responsabilité** : Communication I2C avec les contrôleurs PCA9685
```cpp
class PCA9685Manager {
  - Initialisation de multiples PCA9685
  - Contrôle PWM (angle servo)
  - Activation/désactivation (pin OE)
  - Gestion des adresses I2C
}
```

#### Classe `ServoController`
**Responsabilité** : Contrôle individuel d'un servomoteur
```cpp
class ServoController {
  - Numéro PCA
  - Pin sur le PCA
  - Angles min/max
  - Angle actuel
  - Sens de rotation
  - Méthodes : activate(), deactivate(), setAngle()
}
```

#### Classe `FretController`
**Responsabilité** : Gestion des servos de frettes pour une corde
```cpp
class FretController {
  - Tableau de ServoController (1 par frette)
  - Méthodes : pressFret(num), releaseFret(num), releaseAll()
}
```

#### Classe `PluckController`
**Responsabilité** : Gestion du servo de grattage
```cpp
class PluckController {
  - ServoController pluckServo
  - Angles de grattage (alternatifs)
  - État actuel (angle A ou B)
  - Méthodes : pluck(), mute(), alternate()
}
```

#### Classe `StringInstrument`
**Responsabilité** : Représentation d'une corde complète
```cpp
class StringInstrument {
  - Note MIDI de base (corde à vide)
  - FretController
  - PluckController
  - Nombre de frettes
  - Méthodes : playNote(midiNote), stopNote()
}
```

#### Classe `InstrumentManager`
**Responsabilité** : Gestion globale de l'instrument
```cpp
class InstrumentManager {
  - Tableau de StringInstrument
  - Méthodes : init(), findStringForNote(midiNote), playNote(), stopNote()
}
```

#### Classe `MIDIHandler`
**Responsabilité** : Réception et traitement MIDI
```cpp
class MIDIHandler {
  - Callback NOTE_ON
  - Callback NOTE_OFF
  - Filtrage des canaux
  - Méthodes : process(), handleNoteOn(), handleNoteOff()
}
```

## 5. LOGIQUE DE FONCTIONNEMENT

### 5.1 Séquence NOTE_ON

```
1. Réception message MIDI NOTE_ON (note=60, velocity=80)
   │
2. Identification corde appropriée
   │  → Note 60 (C4) sur corde Sol (55) → frette 5
   │
3. Activation du servo de frette
   │  → pressFret(5) → Angle défini dans config
   │
4. Délai stabilisation (50-100ms)
   │
5. Grattage de la corde
   │  → pluck() → Alterne angle A/B
   │
6. Maintien frette enfoncée
```

### 5.2 Séquence NOTE_OFF

```
1. Réception message MIDI NOTE_OFF (note=60)
   │
2. Option A : Relâchement simple
   │  → releaseFret(5)
   │  → La corde continue à vibrer
   │
3. Option B : Étouffement (mute)
   │  → Servo pluck contre la corde
   │  → mute()
   │  → Puis releaseFret(5)
```

### 5.3 Algorithme de Mapping Note → Corde/Frette

```cpp
Pour chaque corde de l'instrument:
  Si (noteMidi >= cordeBaseMidi) ET (noteMidi <= cordeBaseMidi + nbFrettes):
    frette = noteMidi - cordeBaseMidi
    retourner {corde, frette}

Si aucune corde trouvée:
  retourner {erreur: note hors portée}
```

### 5.4 Gestion Polyphonie Limitée

Contrainte : Une corde ne peut jouer qu'une note à la fois

```cpp
handleNoteOn(midiNote):
  corde, frette = mapNoteToString(midiNote)

  Si corde occupée par une autre note:
    corde.stopCurrentNote()  // Relâche frette actuelle

  corde.playNote(frette)
```

### 5.5 Timing Critique

```
Événement          | Délai
─────────────────────────────────────
MIDI reçu          | T+0ms
Activation frette  | T+5ms   (envoi I2C)
Servo en position  | T+100ms (mouvement mécanique)
Pluck déclenché    | T+105ms
Corde vibre        | T+110ms
```

## 6. STRUCTURE DE DONNÉES

### 6.1 Configuration Globale (settings.h)

```cpp
// Configuration générale
#define NUM_STRINGS 4           // Nombre de cordes
#define PCA_COUNT 4             // Nombre de PCA9685
#define PIN_OE 4                // Pin pour désactiver servos
#define I2C_FREQUENCY 400000    // Fréquence I2C (400kHz)

// Timings
#define FRET_STABILIZATION_DELAY 100  // ms
#define PLUCK_DURATION 50             // ms
#define SERVO_POWER_TIMEOUT 5000      // ms inactivité avant coupure

// Calibration servos
#define SERVO_MIN_PULSE 150     // Pulse min (microseconds)
#define SERVO_MAX_PULSE 600     // Pulse max (microseconds)
```

### 6.2 Configuration de Corde

```cpp
struct StringConfig {
  uint8_t baseMidiNote;        // Note MIDI à vide (ex: 40 pour E2)
  uint8_t numFrets;            // Nombre de frettes (ex: 12)
  uint8_t pcaAddress;          // Adresse I2C du PCA (0x40-0x47)
  uint8_t firstFretPin;        // Pin PCA de la 1ère frette (ex: 0)
  uint8_t pluckPin;            // Pin PCA du servo grattage (ex: 12)

  // Calibration frettes
  uint16_t fretAngles[MAX_FRETS];    // Angle pour activer frette
  bool fretReversed[MAX_FRETS];      // Sens rotation (true=inverse)

  // Calibration pluck
  uint16_t pluckAngleA;        // 1er angle de grattage
  uint16_t pluckAngleB;        // 2ème angle de grattage (alterné)
  uint16_t pluckMuteAngle;     // Angle pour étouffer
};
```

### 6.3 État Runtime

```cpp
struct StringState {
  int8_t currentFret;          // Frette active (-1 = aucune)
  uint8_t currentMidiNote;     // Note MIDI jouée (0 = aucune)
  bool isPlaying;              // Corde en train de jouer?
  unsigned long lastActivity;  // Timestamp dernière action
};
```

## 7. GESTION DES CAS LIMITES

### 7.1 Note Hors Portée
```
Si note trop basse OU trop haute:
  → Ignorer le message
  → (Optionnel) Logger l'erreur
  → (Optionnel) Transposer à l'octave disponible
```

### 7.2 Plusieurs Notes Simultanées sur Même Corde
```
Si NOTE_ON reçu alors corde occupée:
  → Relâcher frette actuelle
  → Activer nouvelle frette
  → Re-gratter
```

### 7.3 Défaillance I2C
```
Si communication PCA9685 échoue:
  → Réessayer (max 3 fois)
  → Si échec persistant: désactiver la corde concernée
  → Continuer avec les autres cordes
```

### 7.4 Alimentation Insuffisante
```
Monitoring optionnel de tension:
  Si tension < seuil:
    → Réduire nombre de servos actifs simultanément
    → Séquencer les activations
```

## 8. OPTIMISATIONS POSSIBLES

### 8.1 Performance
- Utiliser interruptions pour MIDI (pas de polling)
- Buffer des commandes servo (envoi groupé I2C)
- Pré-calcul des valeurs PWM

### 8.2 Qualité Musicale
- Vibrato (oscillation micro de la frette)
- Velocity → force de grattage (angle pluck variable)
- Legato (pas de re-grattage si même corde)

### 8.3 Énergie
- Sleep mode entre notes
- Désactivation progressive des servos (OE)
- PWM réduit pour maintien position

## 9. PLAN DE DÉVELOPPEMENT

### Phase 1 : Base
1. Communication PCA9685 (lib Adafruit)
2. Contrôle servo simple
3. Réception MIDI basique

### Phase 2 : Logique
4. Mapping MIDI → Corde/Frette
5. Classe StringInstrument
6. Synchronisation Frette + Pluck

### Phase 3 : Raffinement
7. Calibration par configuration
8. Gestion erreurs
9. Optimisations timing

### Phase 4 : Avancé
10. Gestion polyphonie multi-cordes
11. Modes de jeu (staccato, legato)
12. Interface de calibration (Serial)

## 10. QUESTIONS À RÉSOUDRE

1. **Choix microcontrôleur** : Arduino Mega? Teensy? ESP32?
   - Besoin : USB-MIDI natif, I2C stable, assez de mémoire

2. **Alimentation** : 5V ou 6V pour les servos?
   - Dépend du couple nécessaire pour les frettes

3. **Calibration** : Manuelle ou automatique?
   - Proposition : fichier config + mode calibration interactif

4. **Mute** : Systématique sur NOTE_OFF ou optionnel?
   - Proposition : paramètre par corde

5. **Latence acceptable** : < 50ms? < 100ms?
   - À tester en situation réelle

## CONCLUSION

Le système repose sur une architecture modulaire permettant:
- Configuration flexible (nombre de cordes, frettes, angles)
- Extensibilité (ajout de cordes/fonctionnalités)
- Maintenabilité (classes spécialisées)
- Performance (I2C optimisé, timing précis)

La prochaine étape est l'implémentation du code en suivant cette architecture.
