# Logique Détaillée du Code

## 1. DIAGRAMMES DE FLUX

### 1.1 Flux Principal (Loop)

```
┌─────────────────┐
│  SETUP          │
│  - Init I2C     │
│  - Init PCA9685 │
│  - Init MIDI    │
│  - Load Config  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LOOP           │◄─────────┐
└────────┬────────┘          │
         │                   │
         ▼                   │
    ┌─────────┐              │
    │ MIDI    │              │
    │ disponible? │          │
    └──┬───┬──┘              │
       │NO │YES              │
       │   │                 │
       │   ▼                 │
       │ ┌──────────────┐    │
       │ │ Read MIDI    │    │
       │ │ Message      │    │
       │ └──────┬───────┘    │
       │        │            │
       │        ▼            │
       │   ┌─────────┐       │
       │   │NOTE_ON? │       │
       │   └──┬───┬──┘       │
       │      │YES│NO        │
       │      │   │          │
       │      │   ▼          │
       │      │ ┌─────────┐  │
       │      │ │NOTE_OFF?│  │
       │      │ └──┬───┬──┘  │
       │      │    │YES│NO   │
       │      │    │   │     │
       │      ▼    ▼   │     │
       │   ┌──────────┐│     │
       │   │handleNote││     │
       │   │   On     ││     │
       │   └────┬─────┘│     │
       │        │      │     │
       │        │   ┌──▼─────▼──┐
       │        │   │handleNote │
       │        │   │   Off     │
       │        │   └─────┬─────┘
       │        │         │
       │        └─────┬───┘
       │              │
       ▼              ▼
    ┌──────────────────┐
    │ Check Timeouts   │
    │ - Auto release   │
    │ - Power saving   │
    └────────┬─────────┘
             │
             └──────────────────┘
```

### 1.2 Flux handleNoteOn Détaillé

```
┌────────────────────────┐
│ handleNoteOn(note, vel)│
└──────────┬─────────────┘
           │
           ▼
    ┌──────────────┐
    │ Map note to  │
    │ string/fret  │
    └──────┬───────┘
           │
           ▼
      ┌─────────┐
      │ Valid?  │
      └──┬───┬──┘
         │NO │YES
         │   │
         ▼   ▼
    ┌───────┐ ┌──────────────────┐
    │Return │ │ Get StringObject │
    │Error  │ └────────┬─────────┘
    └───────┘          │
                       ▼
                  ┌─────────────┐
                  │ String busy?│
                  └──┬───┬──────┘
                     │YES│NO
                     │   │
                     ▼   │
              ┌──────────┐│
              │ Release  ││
              │ current  ││
              │ fret     ││
              └─────┬────┘│
                    │     │
                    └──┬──┘
                       │
                       ▼
            ┌──────────────────┐
            │ Power ON servos  │
            │ (disable OE)     │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │ Press fret if >0 │
            │ (send PWM angle) │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │ Wait stabilization│
            │ (delay 100ms)    │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │ Pluck string     │
            │ (alternate angle)│
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │ Update state     │
            │ - currentFret    │
            │ - currentNote    │
            │ - isPlaying=true │
            │ - timestamp      │
            └──────────────────┘
```

### 1.3 Flux handleNoteOff Détaillé

```
┌────────────────────────┐
│ handleNoteOff(note)    │
└──────────┬─────────────┘
           │
           ▼
    ┌──────────────────┐
    │ Find string      │
    │ playing this note│
    └──────┬───────────┘
           │
           ▼
      ┌─────────┐
      │ Found?  │
      └──┬───┬──┘
         │NO │YES
         │   │
         ▼   ▼
    ┌───────┐ ┌────────────┐
    │Return │ │ Mute mode? │
    │       │ └──┬───┬─────┘
    └───────┘    │YES│NO
                 │   │
                 ▼   │
          ┌──────────┐│
          │Apply mute││
          │(pluck to ││
          │ string)  ││
          └────┬─────┘│
               │      │
               │      ▼
               │ ┌──────────┐
               │ │ Release  │
               │ │ fret     │
               │ └────┬─────┘
               │      │
               └───┬──┘
                   │
                   ▼
           ┌───────────────┐
           │ Update state  │
           │ - isPlaying=  │
           │   false       │
           │ - currentNote │
           │   = 0         │
           │ - currentFret │
           │   = -1        │
           └───────────────┘
```

## 2. LOGIQUE DE CONVERSION MIDI

### 2.1 Algorithme de Mapping

```cpp
/**
 * Trouve la corde et la frette pour une note MIDI donnée
 *
 * Stratégie: Priorité à la corde la plus basse pouvant jouer la note
 * (pour éviter d'utiliser les frettes hautes quand une corde à vide suffit)
 */
struct NoteMapping {
  int8_t stringIndex;  // -1 si note impossible
  int8_t fretNumber;   // 0 = corde à vide
  bool valid;
};

NoteMapping mapMidiNote(uint8_t midiNote) {
  NoteMapping result = {-1, -1, false};
  int8_t bestString = -1;
  int8_t bestFret = 127;  // Commence très haut

  // Parcourir toutes les cordes
  for (int i = 0; i < NUM_STRINGS; i++) {
    StringConfig& cfg = stringConfigs[i];

    // La note est-elle dans la portée de cette corde?
    if (midiNote >= cfg.baseMidiNote &&
        midiNote <= cfg.baseMidiNote + cfg.numFrets) {

      int8_t fret = midiNote - cfg.baseMidiNote;

      // Préférer la frette la plus basse (corde plus grave)
      if (fret < bestFret) {
        bestString = i;
        bestFret = fret;
      }
    }
  }

  if (bestString != -1) {
    result.stringIndex = bestString;
    result.fretNumber = bestFret;
    result.valid = true;
  }

  return result;
}
```

### 2.2 Exemple de Mapping (Basse 4 cordes)

```
Cordes:
  0: E2 (MIDI 40) - 12 frettes → 40-52
  1: A2 (MIDI 45) - 12 frettes → 45-57
  2: D3 (MIDI 50) - 12 frettes → 50-62
  3: G3 (MIDI 55) - 12 frettes → 55-67

Note MIDI 50 (D3):
  - Corde 0: 50-40 = frette 10 ✓ possible
  - Corde 1: 50-45 = frette 5  ✓ possible
  - Corde 2: 50-50 = frette 0  ✓ possible ← CHOISI (frette la plus basse)
  - Corde 3: 50 < 55 = impossible

Résultat: Corde 2, Frette 0 (corde à vide)
```

### 2.3 Gestion de la Polyphonie

```cpp
/**
 * Gestion des notes simultanées
 * Limite: 1 note par corde
 */
void handlePolyphony(uint8_t midiNote) {
  NoteMapping map = mapMidiNote(midiNote);

  if (!map.valid) {
    return; // Note impossible
  }

  StringState& state = stringStates[map.stringIndex];

  // Si cette corde joue déjà une autre note
  if (state.isPlaying && state.currentMidiNote != midiNote) {
    // Cas 1: Legato sur même corde (pas de re-pluck)
    if (LEGATO_MODE) {
      releaseCurrentFret(map.stringIndex);
      pressFret(map.stringIndex, map.fretNumber);
      // PAS de pluck
    }
    // Cas 2: Re-attaque normale
    else {
      stopNote(map.stringIndex);
      delay(10); // Petit délai pour laisser servo se stabiliser
      playNote(map.stringIndex, map.fretNumber);
    }
  }
  // Nouvelle note sur corde libre
  else {
    playNote(map.stringIndex, map.fretNumber);
  }
}
```

## 3. LOGIQUE DE CONTRÔLE SERVO

### 3.1 Conversion Angle → PWM

```cpp
/**
 * Convertit un angle (0-180°) en valeur PWM pour PCA9685
 *
 * PCA9685 utilise 12 bits (0-4095) pour le cycle PWM
 * Fréquence typique servo: 50Hz (période 20ms)
 * Pulse servo: 1ms (0°) à 2ms (180°)
 */
uint16_t angleToPWM(uint16_t angle) {
  // Limiter l'angle
  if (angle > 180) angle = 180;

  // Calcul linéaire
  // SERVO_MIN_PULSE = 150 (≈1ms)
  // SERVO_MAX_PULSE = 600 (≈2ms)
  uint16_t pulse = map(angle,
                       0, 180,
                       SERVO_MIN_PULSE, SERVO_MAX_PULSE);

  return pulse;
}
```

### 3.2 Gestion du Sens de Rotation

```cpp
/**
 * Certains servos sont montés à l'envers
 * Il faut inverser l'angle
 */
uint16_t applyReversed(uint16_t angle, bool reversed) {
  if (reversed) {
    return 180 - angle;
  }
  return angle;
}

// Exemple d'utilisation
void pressFret(uint8_t stringIdx, uint8_t fretNum) {
  StringConfig& cfg = stringConfigs[stringIdx];

  uint16_t angle = cfg.fretAngles[fretNum];
  bool reversed = cfg.fretReversed[fretNum];

  uint16_t finalAngle = applyReversed(angle, reversed);
  uint16_t pwm = angleToPWM(finalAngle);

  // Utiliser le mapping pour trouver PCA et pin
  ServoMapping& servo = cfg.fretServos[fretNum];
  uint8_t pcaIndex = servo.pcaIndex;
  uint8_t pin = servo.pin;

  pcaManager.setPWM(pcaIndex, pin, 0, pwm);
}
```

### 3.3 Logique d'Alternance du Pluck

```cpp
/**
 * Alterne entre deux angles pour simuler un mouvement de pick
 * Évite que le servo reste toujours du même côté
 */
class PluckController {
private:
  bool currentAngleState;  // false=angleA, true=angleB

public:
  void pluck(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];

    // Choisir l'angle selon l'état
    uint16_t angle = currentAngleState ?
                     cfg.pluckAngleB :
                     cfg.pluckAngleA;

    uint16_t pwm = angleToPWM(angle);

    // Utiliser le mapping du servo pluck
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, 0, pwm);

    // Alterner pour la prochaine fois
    currentAngleState = !currentAngleState;

    // Log pour debug
    #ifdef DEBUG
    Serial.print("Pluck string ");
    Serial.print(stringIdx);
    Serial.print(" angle: ");
    Serial.println(angle);
    #endif
  }

  void mute(uint8_t stringIdx) {
    StringConfig& cfg = stringConfigs[stringIdx];
    uint16_t pwm = angleToPWM(cfg.pluckMuteAngle);

    // Utiliser le mapping du servo pluck
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaManager.setPWM(pluckServo.pcaIndex, pluckServo.pin, 0, pwm);
  }
};
```

## 4. LOGIQUE DE TIMING

### 4.1 Séquencement des Actions

```cpp
/**
 * Timing précis pour coordination frette/pluck
 */
void playNote(uint8_t stringIdx, uint8_t fret) {
  unsigned long t0 = millis();

  // 1. Activer alimentation servos (si désactivée)
  enableServoPower();
  delay(5);  // Laisser le temps au régulateur

  // 2. Presser la frette (si nécessaire)
  if (fret > 0) {
    pressFret(stringIdx, fret);
  }

  // 3. Attendre stabilisation mécanique
  unsigned long t1 = millis();
  unsigned long elapsed = t1 - t0;
  if (elapsed < FRET_STABILIZATION_DELAY) {
    delay(FRET_STABILIZATION_DELAY - elapsed);
  }

  // 4. Gratter la corde
  pluckController.pluck(stringIdx);

  // 5. Mettre à jour l'état
  StringState& state = stringStates[stringIdx];
  state.currentFret = fret;
  state.currentMidiNote = stringConfigs[stringIdx].baseMidiNote + fret;
  state.isPlaying = true;
  state.lastActivity = millis();

  #ifdef DEBUG
  unsigned long t2 = millis();
  Serial.print("Total time: ");
  Serial.print(t2 - t0);
  Serial.println("ms");
  #endif
}
```

### 4.2 Gestion des Timeouts

```cpp
/**
 * Économie d'énergie et protection des servos
 */
void checkTimeouts() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();

  // Vérifier toutes les 500ms
  if (now - lastCheck < 500) return;
  lastCheck = now;

  bool anyActive = false;

  // Parcourir toutes les cordes
  for (int i = 0; i < NUM_STRINGS; i++) {
    StringState& state = stringStates[i];

    // Si une note est en cours
    if (state.isPlaying) {
      // Timeout atteint?
      if (now - state.lastActivity > SERVO_POWER_TIMEOUT) {
        // Relâcher la frette (économie énergie)
        if (state.currentFret > 0) {
          releaseFret(i, state.currentFret);
        }
        // La corde continue de vibrer mais le servo est désactivé
      }
      else {
        anyActive = true;
      }
    }
  }

  // Si aucune corde active, couper l'alimentation des servos
  if (!anyActive) {
    disableServoPower();
  }
}
```

## 5. LOGIQUE D'INITIALISATION

### 5.1 Séquence de Démarrage

```cpp
void setup() {
  // 1. Communication série (debug)
  Serial.begin(115200);
  Serial.println("Orchestrion Plucked Strings - Starting...");

  // 2. Initialiser I2C
  Wire.begin();
  Wire.setClock(I2C_FREQUENCY);

  // 3. Pin de contrôle alimentation servos
  pinMode(PIN_OE, OUTPUT);
  disableServoPower();  // Démarrer avec servos désactivés

  // 4. Initialiser les PCA9685
  initPCA9685Controllers();

  // 5. Position initiale des servos
  moveServosToRestPosition();

  // 6. Charger la configuration
  loadConfiguration();

  // 7. Initialiser MIDI
  MIDI.begin(MIDI_CHANNEL_OMNI);
  MIDI.setHandleNoteOn(handleNoteOn);
  MIDI.setHandleNoteOff(handleNoteOff);

  // 8. Test rapide (optionnel)
  #ifdef STARTUP_TEST
  performStartupTest();
  #endif

  Serial.println("Ready!");
}
```

### 5.2 Initialisation des PCA9685

```cpp
void initPCA9685Controllers() {
  for (int i = 0; i < PCA_COUNT; i++) {
    uint8_t addr = PCA9685_BASE_ADDR + i;

    Serial.print("Init PCA9685 #");
    Serial.print(i);
    Serial.print(" @ 0x");
    Serial.println(addr, HEX);

    // Créer l'objet Adafruit_PWMServoDriver
    Adafruit_PWMServoDriver pca = Adafruit_PWMServoDriver(addr);

    pca.begin();
    pca.setPWMFreq(50);  // 50Hz pour servos

    // Attendre stabilisation
    delay(10);

    // Stocker dans le tableau
    pcaControllers[i] = pca;
  }
}
```

### 5.3 Position de Repos

```cpp
/**
 * Positionner tous les servos en position neutre
 * Évite les mouvements brusques au démarrage
 */
void moveServosToRestPosition() {
  Serial.println("Moving servos to rest position...");

  enableServoPower();
  delay(10);

  // Pour chaque corde
  for (int s = 0; s < NUM_STRINGS; s++) {
    StringConfig& cfg = stringConfigs[s];

    // Frettes en position relâchée (90° neutre généralement)
    for (int f = 0; f < cfg.numFrets; f++) {
      ServoMapping& servo = cfg.fretServos[f];
      uint16_t pwm = angleToPWM(90);  // Position neutre
      pcaControllers[servo.pcaIndex].setPWM(servo.pin, 0, pwm);
      delay(5);
    }

    // Pluck en position repos (angleA)
    uint16_t pwm = angleToPWM(cfg.pluckAngleA);
    ServoMapping& pluckServo = cfg.pluckServo;
    pcaControllers[pluckServo.pcaIndex].setPWM(pluckServo.pin, 0, pwm);
  }

  delay(500);  // Laisser les servos se positionner
  disableServoPower();  // Couper l'alimentation

  Serial.println("Rest position OK");
}
```

## 6. LOGIQUE DE GESTION D'ERREURS

### 6.1 Détection d'Erreur I2C

```cpp
bool sendPWMSafe(uint8_t pcaIndex, uint8_t pin, uint16_t pwm) {
  const int MAX_RETRIES = 3;

  for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Vérifier que le PCA existe
    if (pcaIndex >= PCA_COUNT) {
      Serial.println("ERROR: Invalid PCA index");
      return false;
    }

    // Tenter l'envoi
    pcaControllers[pcaIndex].setPWM(pin, 0, pwm);

    // Vérifier si l'I2C a réussi
    if (Wire.getWriteError() == 0) {
      return true;  // Succès
    }

    // Échec, réessayer
    Serial.print("I2C error, retry ");
    Serial.println(attempt + 1);
    delay(10);
    Wire.clearWriteError();
  }

  // Échec définitif
  Serial.print("FATAL: I2C comm failed for PCA ");
  Serial.println(pcaIndex);
  return false;
}
```

### 6.2 Protection Contre les Valeurs Invalides

```cpp
void pressFretSafe(uint8_t stringIdx, uint8_t fret) {
  // Vérifications
  if (stringIdx >= NUM_STRINGS) {
    Serial.println("ERROR: Invalid string index");
    return;
  }

  StringConfig& cfg = stringConfigs[stringIdx];

  if (fret >= cfg.numFrets) {
    Serial.println("ERROR: Fret number too high");
    return;
  }

  // Vérifier que l'angle est dans une plage raisonnable
  uint16_t angle = cfg.fretAngles[fret];
  if (angle > 180) {
    Serial.print("WARNING: Angle clamped to 180° (was ");
    Serial.print(angle);
    Serial.println(")");
    angle = 180;
  }

  // Appliquer
  pressFret(stringIdx, fret);
}
```

## 7. LOGIQUE DE DEBUG

### 7.1 Mode Verbose

```cpp
#ifdef DEBUG_VERBOSE
void logNoteEvent(const char* event, uint8_t note, uint8_t vel) {
  Serial.print("[");
  Serial.print(millis());
  Serial.print("ms] ");
  Serial.print(event);
  Serial.print(" - Note: ");
  Serial.print(note);
  Serial.print(" (");

  // Afficher le nom de la note
  const char* noteNames[] = {"C", "C#", "D", "D#", "E", "F",
                             "F#", "G", "G#", "A", "A#", "B"};
  Serial.print(noteNames[note % 12]);
  Serial.print(note / 12 - 1);

  Serial.print(") Vel: ");
  Serial.println(vel);
}
#endif
```

### 7.2 Commandes Série pour Test

```cpp
/**
 * Interface série pour tester sans MIDI
 * Commandes:
 *   p<string>,<fret>  : Press fret (ex: p2,5)
 *   r<string>,<fret>  : Release fret
 *   s<string>         : Pluck string
 *   a                 : Print all states
 */
void processSerialCommands() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd.startsWith("p")) {
    // Parse p<string>,<fret>
    int comma = cmd.indexOf(',');
    int str = cmd.substring(1, comma).toInt();
    int fret = cmd.substring(comma + 1).toInt();

    Serial.print("Pressing string ");
    Serial.print(str);
    Serial.print(" fret ");
    Serial.println(fret);

    pressFret(str, fret);
  }
  else if (cmd.startsWith("s")) {
    int str = cmd.substring(1).toInt();
    Serial.print("Plucking string ");
    Serial.println(str);
    pluckController.pluck(str);
  }
  else if (cmd == "a") {
    printAllStates();
  }
}
```

## CONCLUSION

Cette logique de code repose sur:
1. **Modularité** : Chaque fonction a une responsabilité claire
2. **Robustesse** : Gestion d'erreurs et protections
3. **Performance** : Timing optimisé, I2C efficace
4. **Debugabilité** : Logs détaillés et commandes de test

Prochaine étape: Implémentation concrète en C++ pour Arduino/Teensy.
