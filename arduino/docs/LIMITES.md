# Limites du projet — Version Arduino

Ce document décrit les limites **techniques** de l'implémentation Arduino
(taille mémoire, rapidité/latence, polyphonie, plateformes supportées).
Elles servent à dimensionner un instrument réaliste et à éviter les
mauvaises surprises.

> Résumé : le code utilise la bibliothèque **MIDIUSB**, donc une carte à
> **USB natif ATmega32u4 / SAMD / SAM** (Leonardo, Micro, Zero, MKR, Due) —
> une carte **SAMD (Zero/MKR)** est conseillée pour sa RAM. Chaque note
> frettée engage un délai bloquant d'environ **100 ms**, la polyphonie est
> limitée à **1 note par corde**, et la configuration consomme de la **SRAM**
> proportionnellement au nombre de cordes et de frettes.

---

## 1. Limites de taille (mémoire)

### 1.1 Empreinte de la configuration

La table `stringConfigs[]` est déclarée `const` **sans `PROGMEM`**. Sur AVR
(Leonardo/Micro), une donnée `const` non-`PROGMEM` est **recopiée en SRAM**
au démarrage : elle consomme donc de la RAM, pas seulement de la flash.

Taille d'une `StringConfig` (avec `MAX_FRETS = 24`) :

| Champ | Type | Octets |
|-------|------|-------:|
| `baseMidiNote` | `uint8_t` | 1 |
| `numFrets` | `uint8_t` | 1 |
| `fretServos[24]` | `ServoMapping` (2 o) | 48 |
| `pluckServo` | `ServoMapping` | 2 |
| `fretCalibration[24]` | `FretCalibration` (4 o) | 96 |
| `fretReversed[24]` | `bool` | 24 |
| `pluckAngleCenter` / `pluckAmplitude` / `pluckMuteAngle` | `uint16_t` ×3 | 6 |
| **Total** (AVR, alignement 1) | | **≈ 178 o / corde** |

Soit **≈ 712 octets** en SRAM pour la configuration par défaut
(`NUM_STRINGS = 4`), **avant** les tampons de bibliothèques (Wire, Serial,
MIDIUSB), le tas et la pile.

### 1.2 Marge par plateforme

| Carte | SRAM | Config 4×12 | Verdict |
|-------|-----:|------------:|---------|
| Uno / Nano (ATmega328) | 2 Ko | ~712 o (35 %) | ❌ pas d'USB natif |
| Leonardo / Micro (ATmega32u4) | 2,5 Ko | ~712 o (28 %) | ⚠️ OK pour **petites** configs |
| Zero / MKR (SAMD21) | 32 Ko | ~712 o (2 %) | ✅ conseillé (MIDIUSB) |
| Teensy 4.x | 1 Mo | négligeable | ✅ mais port `usbMIDI` requis |

### 1.3 Réduire l'empreinte

- **Ajuster `MAX_FRETS`** à votre maximum réel : passer de 24 à 12 fait
  tomber la `StringConfig` à ≈ 94 o (~376 o pour 4 cordes, **≈ 2× moins**).
- **Désactiver `DEBUG`** en production : sur AVR, chaque littéral
  `Serial.print("…")` **non** enveloppé dans `F()` est copié en SRAM. Le
  mode debug consomme donc beaucoup de RAM (et de flash) en plus.
- Sur AVR uniquement : envelopper les littéraux dans `F(...)`, ou porter
  `stringConfigs[]` en `PROGMEM` (voir `AUDIT.md`, recommandations).

---

## 2. Limites de rapidité (latence & débit)

L'architecture utilise des `delay()` **bloquants** : pendant un délai, la
boucle principale ne lit plus le MIDI ni ne met à jour les autres cordes.

| Action | Délai (défaut) | Réglage |
|--------|---------------:|---------|
| Appui d'une frette | `FRET_STABILIZATION_DELAY` = **100 ms** | `settings.h` |
| Ré-attaque normale (même corde) | +10 ms | en dur |
| Mute sur NOTE_OFF | `MUTE_DELAY` = **50 ms** | `settings.h` |
| Mise au repos au démarrage | ~5 ms × servos + 500 ms | `settings.h` |

Conséquences :

- **Note à vide (frette 0)** : pas de délai de frette → attaque quasi
  immédiate (uniquement le temps de course mécanique du servo de grattage).
- **Note frettée** : ~100 ms bloquants avant le grattage.
- **Débit sur une corde** : ~**5 à 8 notes/seconde** au maximum.
- **Accords** : les notes d'un accord sont traitées **séquentiellement** ;
  un accord de 4 notes frettées peut prendre jusqu'à ~**400 ms** pour sonner
  entièrement.
- **Gigue MIDI** : les messages reçus pendant un `delay()` sont mis en file
  d'attente USB et traités *après* le délai → jitter possible sur les
  passages rapides.

Le bus I2C à 400 kHz (~0,1 ms par ordre `setPWM`) **n'est pas** le goulot :
le facteur limitant est le **temps de course mécanique des servos**
(typiquement 0,1–0,2 s / 60°). Les délais par défaut sont calés sur cette
réalité physique ; les réduire trop fait « rater » la position aux servos.

---

## 3. Limites fonctionnelles

- **Polyphonie = nombre de cordes** : 1 note par corde à la fois
  (`NUM_STRINGS` voix max, 4 par défaut).
- **Allocation de voix simple** : le mappeur choisit la corde donnant la
  **frette la plus basse**. Deux notes qui tombent sur la même corde ne
  peuvent pas sonner ensemble — la seconde ré-attaque la corde. Il n'y a pas
  de « vol de voix » intelligent vers une autre corde libre.
- **Étendue par corde** : `baseMidiNote` (corde à vide) à
  `baseMidiNote + numFrets`. Les notes hors de toute corde sont ignorées.
- **Timeout de maintien** : une note tenue est relâchée automatiquement après
  `SERVO_TIMEOUT` (5 s) pour économiser l'alimentation. Les notes très
  longues ne « tiennent » donc pas indéfiniment.
- **Vélocité** : n'agit que sur l'**amplitude de grattage** si
  `VELOCITY_SENSITIVE = true` ; elle n'influence pas la pression des frettes.
- **Messages MIDI gérés** : NOTE_ON / NOTE_OFF, et CC 120 (All Sound Off) /
  CC 123 (All Notes Off). Pas de pitch-bend, vibrato, portamento ni sustain.
- **Legato** : mode **global** (`LEGATO_MODE`), pas une articulation
  décidée note par note.

---

## 4. Limites de plateforme (matériel)

### 4.1 Microcontrôleur — bibliothèque MIDIUSB requise

Le firmware utilise la bibliothèque **MIDIUSB** (`#include <MIDIUSB.h>`,
`MidiUSB.read()`), qui vise les cartes à **USB natif ATmega32u4 / SAMD / SAM** :

- ✅ **Supportés tels quels** : Leonardo, Micro, (Pro)Micro (32u4) ; Zero, MKR
  (SAMD21) ; Due (SAM3X).
- ⭐ **Conseillé** : une carte **SAMD (Zero / MKR)** — même USB natif que le
  32u4, mais **32 Ko de SRAM** (contre 2,5 Ko), donc large marge pour la
  configuration et les buffers.
- ⚠️ **Teensy 3.x / 4.x** : n'utilise **pas** la bibliothèque MIDIUSB mais sa
  propre API `usbMIDI`. Très puissant (600 MHz, 1 Mo de RAM) mais nécessite
  d'**adapter `src/midi/MIDIHandler.*`** (remplacer `MidiUSB.read()` par
  `usbMIDI.read()`). Ce n'est donc pas un remplacement direct.
- ❌ **Non supportés** : Uno, Nano, Mega (ATmega328/2560) — pas d'USB natif ;
  `MIDIUSB.h` ne compile pas. Il faudrait un pont série-MIDI et une autre
  bibliothèque MIDI.

### 4.2 Contrôleurs PCA9685

- Adresses I2C = `PCA9685_BASE_ADDR` (0x40) + index, consécutives.
- **Éviter 0x70** (adresse « all-call » par défaut du PCA9685).
- 16 canaux par carte → **servos max = `PCA_COUNT` × 16**.
- Besoin par corde : `numFrets` servos de frette + 1 servo de grattage
  (`numFrets + 1`). Config par défaut : 13 servos/corde × 4 = 52 servos →
  4 cartes PCA9685 (cohérent avec `PCA_COUNT = 4`).

### 4.3 Alimentation

- Les servos tirent un courant important (pic de calage ~0,5–1 A chacun).
  Prévoir une alimentation **5–6 V** dédiée, dimensionnée pour les
  mouvements **simultanés**.
- La broche `PIN_OE` (Output Enable, active à l'état bas) coupe globalement
  la sortie des PCA9685 : utilisée ici pour l'économie d'énergie après
  `SERVO_TIMEOUT`.

---

## 5. Tableau récapitulatif

| Dimension | Limite par défaut | Où la régler |
|-----------|-------------------|--------------|
| Cordes (voix) | 4 | `NUM_STRINGS` |
| Frettes / corde | 12 (max `MAX_FRETS` = 24) | `numFrets`, `MAX_FRETS` |
| Servos max | `PCA_COUNT` × 16 = 64 | `PCA_COUNT` |
| Polyphonie | 1 note / corde | (architecture) |
| Latence note frettée | ~100 ms | `FRET_STABILIZATION_DELAY` |
| Débit / corde | ~5–8 notes/s | délais + mécanique |
| Maintien max d'une note | 5 s | `SERVO_TIMEOUT` |
| SRAM config (4×12) | ~712 o | `MAX_FRETS`, `NUM_STRINGS` |
| Plateforme | USB natif (Teensy conseillé) | matériel |

Voir aussi [`AUDIT.md`](AUDIT.md) pour l'état de santé du code et les
recommandations d'optimisation.
