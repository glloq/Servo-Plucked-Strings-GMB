# Logique Détaillée des Servomoteurs

## 1. LOGIQUE DU SERVO DE GRATTAGE (PLUCK)

### 1.1 Principe de Base

Le servo de grattage effectue un mouvement d'oscillation autour d'une **position centrale neutre** pour simuler un mouvement de médiator (pick).

**Position centrale de repos**: 90° (position neutre au démarrage)

### 1.2 Mécanisme d'Alternance

```
Position Centrale (repos): 90°
Amplitude oscillation: ±15°
  → Position A: 90° - 15° = 75°
  → Position B: 90° + 15° = 105°
```

### 1.3 Séquence Détaillée

```
DÉMARRAGE
│
├─ Servo à 90° (position centrale)
│
PREMIÈRE NOTE (NOTE_ON #1)
│
├─ Mouvement vers Position A (75°)
│  └─ Gratte la corde en descendant
│
NOTE_OFF #1
│
├─ Retour à position centrale (90°)
│  └─ Libère la corde
│
DEUXIÈME NOTE (NOTE_ON #2)
│
├─ Mouvement vers Position B (105°)
│  └─ Gratte la corde en montant (mouvement inverse)
│
NOTE_OFF #2
│
├─ Retour à position centrale (90°)
│
TROISIÈME NOTE (NOTE_ON #3)
│
├─ Retour à Position A (75°)
│  └─ Gratte en descendant (alternance)
│
...et ainsi de suite
```

### 1.4 Schéma Visuel

```
        105° ───────────────────────────── Position B (grattage montant)
                      ╱│╲
                     ╱ │ ╲
                    ╱  │  ╲
         90° ──────●───┼───●───────────── Position Centrale (repos)
                  ╱    │    ╲
                 ╱     │     ╲
                ╱      │      ╲
        75° ───────────────────────────── Position A (grattage descendant)

Timeline:
Start  Note1  Off1  Note2  Off2  Note3  Off3  Note4
  │      │     │      │     │      │     │      │
  90°    75°   90°   105°   90°    75°   90°   105°
  │      ↓     ↑      ↓     ↑      ↓     ↑      ↓
       Gratte  Libère Gratte Libère Gratte Libère Gratte
```

### 1.5 Code de Configuration

```cpp
struct StringConfig {
  // ...

  // Configuration du grattage
  uint16_t pluckAngleCenter;    // Position centrale (90°)
  uint16_t pluckAmplitude;      // Amplitude d'oscillation (15°)
  uint16_t pluckMuteAngle;      // Angle pour étouffer (90°, contre la corde)
};

// Exemple pour une corde
{
  .pluckAngleCenter = 90,       // Position neutre
  .pluckAmplitude = 15,         // Oscillation de ±15°
  .pluckMuteAngle = 90          // Mute = position centrale
}
```

### 1.6 Implémentation de la Logique

```cpp
class PluckController {
private:
  uint16_t centerAngle;         // Position centrale (ex: 90°)
  uint16_t amplitude;           // Amplitude (ex: 15°)
  bool currentDirection;        // false = négatif (A), true = positif (B)

public:
  void init(uint16_t center, uint16_t amp) {
    centerAngle = center;
    amplitude = amp;
    currentDirection = false;   // Commence par position A

    // Initialiser à la position centrale
    moveToCenter();
  }

  void pluck(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];

    // Calculer l'angle selon la direction
    uint16_t angle;
    if (currentDirection) {
      angle = centerAngle + amplitude;  // Position B (105°)
    } else {
      angle = centerAngle - amplitude;  // Position A (75°)
    }

    // Envoyer la commande au servo
    uint16_t pwm = angleToPWM(angle);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, 0, pwm);

    // Alterner pour le prochain grattage
    currentDirection = !currentDirection;

    #ifdef DEBUG
    Serial.print("Pluck string ");
    Serial.print(stringIdx);
    Serial.print(" - angle: ");
    Serial.print(angle);
    Serial.print("° (");
    Serial.print(currentDirection ? "B↑" : "A↓");
    Serial.println(")");
    #endif
  }

  void returnToCenter(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];

    // Retour à la position centrale (libère la corde)
    uint16_t pwm = angleToPWM(centerAngle);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, 0, pwm);

    #ifdef DEBUG
    Serial.print("Pluck center - string ");
    Serial.print(stringIdx);
    Serial.print(" - angle: ");
    Serial.print(centerAngle);
    Serial.println("°");
    #endif
  }

  void mute(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];

    // Position mute (généralement la position centrale contre la corde)
    uint16_t pwm = angleToPWM(cfg.pluckMuteAngle);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, 0, pwm);
  }
};
```

### 1.7 Séquence playNote() avec Grattage

```cpp
void playNote(uint8_t stringIdx, uint8_t fret) {
  // 1. Presser la frette si nécessaire
  if (fret > 0) {
    fretController.pressFret(stringIdx, fret);
    delay(FRET_STABILIZATION_DELAY);
  }

  // 2. Gratter la corde (mouvement alterné)
  pluckController.pluck(stringIdx);

  // Note: Le servo reste à la position A ou B
  // Il ne retourne PAS automatiquement au centre
}

void stopNote(uint8_t stringIdx, bool withMute) {
  if (withMute) {
    // Option 1: Étouffer activement
    pluckController.mute(stringIdx);
    delay(50);
  } else {
    // Option 2: Retour au centre (laisse vibrer)
    pluckController.returnToCenter(stringIdx);
  }

  // Relâcher la frette
  fretController.releaseAll(stringIdx);
}
```

### 1.8 Variantes Possibles

#### Variante 1: Oscillation Asymétrique
```cpp
// Utile si le mécanisme est décentré
.pluckAngleA = 70,    // Grattage vers le bas
.pluckAngleB = 110,   // Grattage vers le haut
.pluckAngleCenter = 90
```

#### Variante 2: Amplitude Variable selon Velocity
```cpp
void pluck(uint8_t stringIdx, uint8_t velocity) {
  // Amplitude proportionnelle à la vélocité MIDI (0-127)
  uint16_t dynamicAmplitude = map(velocity, 0, 127, 5, 25);

  uint16_t angle = currentDirection ?
    centerAngle + dynamicAmplitude :
    centerAngle - dynamicAmplitude;

  // ... reste du code
}
```

#### Variante 3: Retour Automatique au Centre
```cpp
void pluck(uint8_t stringIdx) {
  // Gratter
  moveToAlternatePosition();
  delay(20);  // Temps du grattage

  // Retour immédiat au centre
  returnToCenter(stringIdx);
}
```

---

## 2. LOGIQUE DES SERVOS DE FRETTES

### 2.1 Principe de Base

Chaque servo de frette peut être dans **deux positions**:
- **Position OUVERTE** (repos): La frette est libre, corde non appuyée
- **Position FERMÉE** (activée): Le servo appuie sur la corde contre la frette

### 2.2 Paramètres de Configuration

```cpp
struct FretServoConfig {
  uint16_t angleClosed;   // Angle quand la frette est ACTIVÉE (corde appuyée)
  uint16_t angleOpen;     // Angle quand la frette est RELÂCHÉE (position repos)
  bool reversed;          // Sens de rotation inversé?
};
```

### 2.3 Schéma Mécanique

```
POSITION OUVERTE (repos)                POSITION FERMÉE (activée)
     ┌─────┐                                 ┌─────┐
     │Servo│                                 │Servo│
     └──┬──┘                                 └──┬──┘
        │                                       │
      ╱─┴─╲                                   ╱─┴─╲
     │  ○  │ angleOpen (ex: 45°)             │  ○  │ angleClosed (ex: 120°)
      ╲───╱                                   ╲───╱
        │                                       │
        │ bras du servo                         │ bras du servo
        │                                       │
        ⌇ doigt/poussoir                        ⌇ doigt/poussoir
        ⌇                                       ⌇
        ⌇                                       │
        ⌇                                       │ APPUIE
        ⌇                                       ▼
  ══════════════ corde                    ══════╪══════ corde
  ────┬─────────                          ────┬─┴──────
      │ frette                                │ frette
      ▼                                       ▼

  Corde vibre librement               Corde appuyée sur la frette
  (note de la corde à vide)           (note modifiée)
```

### 2.4 Exemple de Configuration

#### Configuration Type 1: Servo au-dessus de la corde
```cpp
// Le servo pousse vers le bas pour appuyer
{
  .angleClosed = 120,   // Servo poussé → appuie sur la corde
  .angleOpen = 45,      // Servo relevé → corde libre
  .reversed = false
}
```

#### Configuration Type 2: Servo en-dessous de la corde
```cpp
// Le servo pousse vers le haut pour appuyer
{
  .angleClosed = 60,    // Servo poussé → appuie sur la corde
  .angleOpen = 135,     // Servo baissé → corde libre
  .reversed = true      // Sens inversé par rapport au Type 1
}
```

#### Configuration Type 3: Servo sur le côté avec levier
```cpp
// Système à levier, mouvement latéral
{
  .angleClosed = 90,    // Levier à 90° → corde appuyée
  .angleOpen = 30,      // Levier à 30° → corde libre
  .reversed = false
}
```

### 2.5 Séquence Détaillée d'une Frette

```
REPOS (corde à vide)
│
├─ Servo à angleOpen (ex: 45°)
│  └─ Corde vibre librement
│
NOTE_ON (ex: frette 5)
│
├─ Servo frette 5 → angleClosed (ex: 120°)
│  └─ Le mécanisme appuie sur la corde
│     └─ Corde contact avec frette 5
│     └─ Note modifiée
│
│  [La corde est maintenue appuyée]
│
NOTE_OFF
│
├─ Servo frette 5 → angleOpen (ex: 45°)
│  └─ Le mécanisme se relève
│     └─ Corde libérée
│
REPOS
```

### 2.6 Timeline Multi-Frettes

```
Frette 1:  Open ────Close───────────────Open─────────
           45°      120°                45°

Frette 2:  Open ─────────────Close──────────Open─────
           45°               120°           45°

Frette 5:  Open ──────────────────Close──────────Open
           45°                    120°          45°

           │    │   │   │   │   │   │   │   │   │
Time:      0   100 200 300 400 500 600 700 800 900 ms

Events:    │    │               │               │
           │    Note(MIDI 45)   Note(MIDI 47)  Note(MIDI 50)
           │    → Frette 0      → Frette 2     → Frette 5
           Start
```

### 2.7 Implémentation de la Logique

```cpp
class FretController {
private:
  struct FretState {
    uint16_t angleOpen;     // Position repos
    uint16_t angleClosed;   // Position activée
    bool reversed;          // Sens inversé?
    bool isPressed;         // État actuel
  };

  FretState frets[MAX_FRETS];
  PCA9685Manager* pcaManager;

public:
  void init(StringConfig& config) {
    // Initialiser chaque frette avec sa configuration
    for (int f = 0; f < config.numFrets; f++) {
      frets[f].angleOpen = config.fretAngles[f].angleOpen;
      frets[f].angleClosed = config.fretAngles[f].angleClosed;
      frets[f].reversed = config.fretReversed[f];
      frets[f].isPressed = false;

      // Mettre toutes les frettes en position ouverte (repos)
      releaseFret(f);
    }
  }

  void pressFret(uint8_t stringIdx, uint8_t fretNum) {
    StringConfig& cfg = stringConfigs[stringIdx];

    if (fretNum >= cfg.numFrets) {
      Serial.println("ERROR: Fret number out of range");
      return;
    }

    // Obtenir l'angle de fermeture
    uint16_t angle = frets[fretNum].angleClosed;

    // Appliquer l'inversion si nécessaire
    if (frets[fretNum].reversed) {
      angle = 180 - angle;
    }

    // Envoyer au servo
    uint16_t pwm = angleToPWM(angle);
    ServoMapping& servo = cfg.fretServos[fretNum];
    pcaManager->setPWM(servo.pcaIndex, servo.pin, 0, pwm);

    // Mettre à jour l'état
    frets[fretNum].isPressed = true;

    #ifdef DEBUG
    Serial.print("Press fret ");
    Serial.print(fretNum);
    Serial.print(" on string ");
    Serial.print(stringIdx);
    Serial.print(" - angle: ");
    Serial.print(angle);
    Serial.println("°");
    #endif
  }

  void releaseFret(uint8_t stringIdx, uint8_t fretNum) {
    StringConfig& cfg = stringConfigs[stringIdx];

    if (fretNum >= cfg.numFrets) return;

    // Obtenir l'angle d'ouverture (repos)
    uint16_t angle = frets[fretNum].angleOpen;

    // Appliquer l'inversion si nécessaire
    if (frets[fretNum].reversed) {
      angle = 180 - angle;
    }

    // Envoyer au servo
    uint16_t pwm = angleToPWM(angle);
    ServoMapping& servo = cfg.fretServos[fretNum];
    pcaManager->setPWM(servo.pcaIndex, servo.pin, 0, pwm);

    // Mettre à jour l'état
    frets[fretNum].isPressed = false;

    #ifdef DEBUG
    Serial.print("Release fret ");
    Serial.print(fretNum);
    Serial.print(" on string ");
    Serial.print(stringIdx);
    Serial.print(" - angle: ");
    Serial.print(angle);
    Serial.println("°");
    #endif
  }

  void releaseAll(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];

    // Relâcher toutes les frettes de cette corde
    for (int f = 0; f < cfg.numFrets; f++) {
      if (frets[f].isPressed) {
        releaseFret(stringIdx, f);
        delay(5);  // Petit délai entre chaque relâchement
      }
    }
  }
};
```

### 2.8 Structure de Configuration Mise à Jour

```cpp
struct FretCalibration {
  uint16_t angleOpen;     // Angle position repos (corde libre)
  uint16_t angleClosed;   // Angle position activée (corde appuyée)
};

struct StringConfig {
  uint8_t baseMidiNote;
  uint8_t numFrets;

  ServoMapping fretServos[24];
  ServoMapping pluckServo;

  // Calibration des frettes (NOUVELLE STRUCTURE)
  FretCalibration fretCalibration[24];  // Open + Closed pour chaque frette
  bool fretReversed[24];                // Sens inversé?

  // Calibration du pluck
  uint16_t pluckAngleCenter;   // Position centrale (90°)
  uint16_t pluckAmplitude;     // Amplitude oscillation (15°)
  uint16_t pluckMuteAngle;     // Angle mute (90°)
};
```

### 2.9 Exemple de Configuration Complète

```cpp
const StringConfig stringConfigs[NUM_STRINGS] = {
  // Corde 0: E2 (MIDI 40)
  {
    .baseMidiNote = 40,
    .numFrets = 12,

    // Mapping servos
    .fretServos = {
      {0,0}, {0,1}, {0,2}, {0,3}, {0,4}, {0,5},
      {0,6}, {0,7}, {0,8}, {0,9}, {0,10}, {0,11}
    },
    .pluckServo = {0, 12},

    // Calibration frettes: {angleOpen, angleClosed}
    .fretCalibration = {
      //  Open Closed    (chaque frette peut avoir des angles différents)
      {   45,  120  },  // Frette 1
      {   45,  120  },  // Frette 2
      {   50,  125  },  // Frette 3 (angle légèrement différent)
      {   45,  120  },  // Frette 4
      {   45,  120  },  // Frette 5
      {   45,  120  },  // Frette 6
      {   45,  120  },  // Frette 7
      {   45,  120  },  // Frette 8
      {   45,  120  },  // Frette 9
      {   45,  120  },  // Frette 10
      {   45,  120  },  // Frette 11
      {   45,  120  }   // Frette 12
    },

    // Sens de rotation
    .fretReversed = {
      false, false, false, false, false, false,
      false, false, false, false, false, false
    },

    // Calibration pluck
    .pluckAngleCenter = 90,   // Position neutre
    .pluckAmplitude = 15,     // ±15° d'oscillation
    .pluckMuteAngle = 90      // Mute = position centrale
  }
};
```

### 2.10 Initialisation au Démarrage

```cpp
void setup() {
  // ... init I2C, PCA9685 ...

  // Mettre tous les servos en position de repos
  moveAllServosToRestPosition();
}

void moveAllServosToRestPosition() {
  Serial.println("Moving all servos to rest position...");

  enableServoPower();
  delay(10);

  for (int s = 0; s < NUM_STRINGS; s++) {
    StringConfig& cfg = stringConfigs[s];

    // Frettes → Position OUVERTE (repos)
    for (int f = 0; f < cfg.numFrets; f++) {
      uint16_t angle = cfg.fretCalibration[f].angleOpen;

      if (cfg.fretReversed[f]) {
        angle = 180 - angle;
      }

      uint16_t pwm = angleToPWM(angle);
      ServoMapping& servo = cfg.fretServos[f];
      pcaControllers[servo.pcaIndex].setPWM(servo.pin, 0, pwm);
      delay(5);
    }

    // Pluck → Position CENTRALE (repos)
    uint16_t pwm = angleToPWM(cfg.pluckAngleCenter);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaControllers[pluckServo.pcaIndex].setPWM(pluckServo.pin, 0, pwm);
  }

  delay(500);
  disableServoPower();

  Serial.println("All servos at rest position");
}
```

---

## 3. RÉSUMÉ DES LOGIQUES

### Servo de Grattage (Pluck)
- **Position de repos**: Centre (90°)
- **Mouvement**: Oscillation alternée autour du centre (90° ± 15°)
- **NOTE_ON**: Mouvement vers A (75°) ou B (105°), alternance
- **NOTE_OFF**: Retour au centre (90°) ou maintien position

### Servos de Frettes
- **Position de repos**: OUVERTE (ex: 45°), corde libre
- **Position activée**: FERMÉE (ex: 120°), corde appuyée
- **NOTE_ON**: Transition OUVERTE → FERMÉE
- **NOTE_OFF**: Transition FERMÉE → OUVERTE

### Avantages de cette Approche
1. **Calibration indépendante**: Chaque servo a ses propres angles
2. **Flexibilité mécanique**: Adaptation à différents montages
3. **Sens réversible**: Support des servos montés à l'envers
4. **Mouvement naturel**: Simulation réaliste du jeu humain
