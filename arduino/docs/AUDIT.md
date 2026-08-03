# Audit du code — Version Arduino

Audit fonctionnel de la version Arduino/PCA9685, avec correction des
anomalies bloquantes et vérification de la compilation.

- **Périmètre** : `arduino/Servo-Plucked-String/` (sketch + modules `src/`).
- **Méthode** :
  1. Revue statique de tous les modules (`config`, `core`, `string`, `midi`,
     `utils`).
  2. **Compilation hôte** de tous les `.cpp` avec des en-têtes Arduino
     simulés (mocks : `Arduino.h`, `Wire.h`, `Adafruit_PWMServoDriver.h`,
     `MIDIUSB.h`), en `g++ -std=c++17 -Wall -Wextra`.
  3. Exécution d'un petit harnais exerçant l'API (init, `playNote`,
     `stopNote`, `stopAllNotes`, mapping MIDI).
- **Résultat** : compilation et édition de liens **propres** (aucun
  warning), harnais exécuté sans erreur. Les anomalies bloquantes
  ci-dessous ont été corrigées.

> Note : la compilation hôte valide la **syntaxe, les types et l'édition de
> liens** entre modules. Elle ne remplace pas un test sur cible réelle
> (comportement USB-MIDI, temps de course des servos, I2C physique).

---

## 1. Anomalies critiques (corrigées)

### C1 — La corde n'était jamais grattée (aucun son)

**Fichier** : `src/string/StringInstrument.cpp`

`settings.h` définit des macros à **valeur** : `LEGATO_MODE false`,
`AUTO_MUTE true`, `VELOCITY_SENSITIVE false`. Le code les testait avec le
préprocesseur (`#ifdef` / `#ifndef`), qui vérifie seulement si la macro est
**définie** — pas sa valeur. Comme `LEGATO_MODE` **est** définie (à `false`),
`#ifndef LEGATO_MODE` était toujours **faux** et le bloc de grattage
n'était **jamais compilé** :

```cpp
// AVANT — pluck() jamais compilé car LEGATO_MODE est défini
#ifndef LEGATO_MODE
  if (!pluckController.pluck()) return false;
#endif
```

Conséquence : un NOTE_ON appuyait la frette mais **ne grattait jamais** la
corde → instrument muet.

**Correction** : test à l'exécution (`if (LEGATO_MODE)` / `if (!…)`), le
compilateur repliant la constante. Le grattage n'est sauté que lors d'une
vraie transition legato ; une nouvelle note gratte toujours (conforme à
l'algorithme documenté dans `LOGIQUE_CODE.md`).

### C2 — Structure de sketch non compilable dans l'IDE Arduino

**Avant** : `src/main.ino` avec les `.cpp` dans des sous-dossiers
(`core/`, `string/`, `midi/`, `utils/`). L'IDE Arduino ne compile
**automatiquement** que les `.cpp` du dossier du sketch et ceux d'un
sous-dossier **`src/`**. Les modules n'étaient donc pas compilés → erreurs
d'édition de liens (« undefined reference »).

**Correction** : réorganisation en sketch Arduino valide —
`Servo-Plucked-String/Servo-Plucked-String.ino` + tous les modules sous
`Servo-Plucked-String/src/` (compilé récursivement par l'IDE **et** par
PlatformIO). Le `.ino` inclut désormais `src/…`. Les includes relatifs
internes (`../config/…`) restent inchangés.

---

## 2. Anomalies importantes (corrigées)

### H1 — Préprocesseur mal employé sur `AUTO_MUTE` / `VELOCITY_SENSITIVE`

Même cause que C1, ailleurs :

- `StringInstrument::stopNote` : `#ifdef AUTO_MUTE` (toujours vrai). La
  décision de mute vient déjà du paramètre `mute` (positionné à `AUTO_MUTE`
  par `InstrumentManager`). → simplifié en test runtime.
- `PluckController::pluck(uint8_t velocity)` : enveloppé dans
  `#ifdef VELOCITY_SENSITIVE`. → la méthode fait toujours son calcul lié à
  la vélocité ; c'est **l'appelant** (`StringInstrument`) qui décide de
  l'utiliser via `if (VELOCITY_SENSITIVE)`.

Un commentaire d'avertissement a été ajouté dans `settings.h` pour ces
macros à valeur (« tester avec `if`, jamais avec `#ifdef` »).

### M1 — Décalage d'indice : note la plus haute perdue

**Fichier** : `src/string/FretController.cpp`

`canPlayNote` / `mapNote` acceptaient `baseMidiNote + numFrets`, mais
`pressFret` indexait `fretServos[fretNum]` et rejetait `fretNum >= numFrets`.
Résultat :

- la note la plus haute de chaque corde (`base + numFrets`) était acceptée
  par le mappeur puis **échouait silencieusement** à l'appui ;
- `fretServos[0]` n'était jamais utilisé (la corde à vide n'appuie rien).

**Correction** : convention clarifiée et indexation corrigée —
**frette 0 = corde à vide**, **frettes 1..numFrets** stockées à l'index
`fretNum-1`. Les `numFrets` entrées correspondent donc à `numFrets` frettes,
et la note haute est jouable. `pressFret`/`releaseFret`/`releaseAll`/
`isFretPressed` mis à jour ; `mapNote`/`canPlayNote` étaient déjà cohérents
avec cette convention. Documenté dans `string_configs.h`.

---

## 3. Anomalies mineures (corrigées)

- **L1** — `PluckController::pluck` : test mort `if (angle < 0)` sur un
  `uint16_t` (jamais négatif) → supprimé ; borne haute conservée.
- **L2** — `MIDIHandler::processMidiMessage` : variable `header` inutilisée
  (warning `-Wall`) → retirée (le statut MIDI est décodé depuis `byte1`).

---

## 4. Recommandations (non corrigées — décisions produit)

Ces points ne sont pas des bugs mais méritent attention. Ils ne sont pas
appliqués pour rester non-intrusif ; à décider par le mainteneur.

- **R1 — SRAM sur AVR** : `stringConfigs[]` est `const` sans `PROGMEM` →
  copié en SRAM. Sur Leonardo/Micro, envisager `PROGMEM` (accès via
  `memcpy_P`) ou réduire `MAX_FRETS`. Sans objet sur Teensy. Voir
  `LIMITES.md §1`.
- **R2 — Littéraux `F()`** : avec `DEBUG`, les `Serial.print("…")` non
  enveloppés dans `F()` consomment de la SRAM sur AVR. Recommandé si cible
  AVR ; inutile sur Teensy.
- **R3 — `NoteMapper::noteToString`** renvoie un `static char[8]` partagé :
  correct tel qu'utilisé (un appel par `print`), mais fragile si appelé deux
  fois dans une même expression.
- **R4 — Sous-dépassement** : dans `pluck`, `pluckAngleCenter - amplitude`
  sous-dépasse si `centre < amplitude` (rare : centre ≈ 90°, amplitude
  ≤ 25°). Clampé par la borne haute, sans plantage.
- **R5 — `PLUCK_DELAY`** est défini mais inutilisé (grattage par simple
  positionnement) → marqué « reserved ».
- **R6 — Fichier `LICENSE` absent** alors que le README annonce MIT et
  pointe vers `LICENSE`. À ajouter.
- **R7 — Plateforme vs bibliothèque MIDI** : le code utilise la bibliothèque
  **MIDIUSB** (`MidiUSB.read()`), qui cible les cartes 32u4/SAMD/SAM
  (Leonardo, Micro, Zero, MKR, Due). L'ancien README recommandait le
  **Teensy**, qui emploie une API **différente** (`usbMIDI`) et exigerait
  d'adapter `MIDIHandler`. La documentation a été corrigée en ce sens
  (voir `LIMITES.md §4.1`) ; pour viser réellement le Teensy, porter
  `MIDIHandler` sur `usbMIDI`.

---

## 5. Fichiers modifiés par l'audit

| Fichier | Nature |
|---------|--------|
| `src/string/StringInstrument.cpp` | C1, H1 (grattage + mute runtime) |
| `src/string/PluckController.cpp` | H1, L1 (pluck vélocité + test mort) |
| `src/string/FretController.cpp` | M1 (indexation des frettes) |
| `src/config/settings.h` | avertissement macros, `MUTE_DELAY` |
| `src/config/string_configs.h` | convention d'indexation documentée |
| `src/midi/MIDIHandler.cpp` | L2 (variable inutilisée) |
| *(arborescence)* | C2 (structure de sketch Arduino) |
