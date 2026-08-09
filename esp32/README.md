# Version ESP32 — Servo-par-frette

> Firmware **ESP32-S3** d'un instrument à cordes pincées piloté en MIDI, où **chaque
> position de frette possède son propre servomoteur** (pas de moteur pas-à-pas).
> Configuration entièrement depuis une **page web** dans le navigateur.

Cette version reprend l'architecture du projet
[`glloq/Stepper-Plucked-Strings-GMB`](https://github.com/glloq/Stepper-Plucked-Strings-GMB)
— réception MIDI (avec **CC de sélection corde/frette**), grattage par servo,
allocation de notes, SysEx/GMB, interface web, cœur C++ testable — mais **remplace
tout le sous-système pas-à-pas par des servos dédiés par frette**.

---

## Principe

Une **corde** = plusieurs **servos-doigts** (un par frette) + un **servo de grattage** :

```
        ┌────────────────────── une corde ──────────────────────┐
   sillet                                                     chevalet
    │  [doigt frette1] [doigt frette2] [doigt frette3] …          │
    ╞════●══════════════●══════════════●═════════════════════════╡  ← la corde
    0     1              2              3      (positions de frette)
    │                                                             │
    └─ servo de grattage (pluck) : pince la corde ───────────────┘
```

Pour jouer une note, le firmware :

1. **relâche** le doigt actuellement pressé sur la corde,
2. **presse** le servo-doigt de la frette cible (frette 0 = corde à vide, aucun doigt),
3. **laisse stabiliser**, puis
4. **gratte** la corde avec le servo de grattage.

Jusqu'à **6 cordes** jouent en parallèle (accords).

### Ce qui est configurable par servo

- **Position de contact corde/frette** (angle de repos ↔ angle d'appui, en µs) ;
- **Sens de rotation** (`inverted`) — pour monter le servo dans n'importe quel sens ;
- **Position de frette arbitraire** — on équipe uniquement les frettes voulues, les
  trous sont permis (ex. frettes 1, 3, 5, 12) ;
- **Doigt à engrenage** (`fretB`) — **un servo pour deux frettes** d'une même corde
  (deux doigts antagonistes, neutre = les deux levés), pour diviser par deux les
  servos sur le bas du manche ; les frettes étroites gardent le doigt simple, les
  deux se mélangent. Voir [`docs/GEARED_FINGERS.md`](docs/GEARED_FINGERS.md) ;
- **Source** : canal d'un **PCA9685** *ou* **GPIO direct** de l'ESP32, mixables.

### Gestion intelligente du courant (limiter la surcharge PCA)

Trois mécanismes combinés évitent de saturer l'alimentation 5–6 V / les PCA9685 :

1. **Coupure PWM au repos** (`disableAtRest`) : un doigt inactif ne consomme ~rien ;
2. **Un seul doigt actif par corde** : on relâche l'ancien doigt avant de presser le
   nouveau (jamais deux couples de calage simultanés sur une corde) ;
3. **Étalement des démarrages** (`ServoActivationGovernor`) : sur un accord, les
   appuis de plusieurs cordes sont décalés dans le temps (`maxConcurrentMoves`,
   `staggerMs`) pour ne pas cumuler les pics d'appel de courant.

Câblage recommandé : **1 PCA9685 par corde** (ses doigts de frettes + son grattage
tiennent sur ≤ 16 canaux), jusqu'à **8 PCA** (adresses 0x40–0x47). Le mapping reste
néanmoins libre par servo.

---

## Réception MIDI (identique au dépôt de référence)

- **Notes** en MIDI over Wi-Fi (UDP, port 5006).
- **Allocation automatique** : envoyez de simples notes, elles sont réparties sur les
  cordes ; ou **forcez une corde/frette exacte** avec des CC (tablature) :
  `CC20 = corde`, `CC21 = frette`, puis `Note On`. Voir
  [`STRING_FRET_SELECTION.md`](STRING_FRET_SELECTION.md) et
  [`docs/MIDI_PROTOCOL.md`](docs/MIDI_PROTOCOL.md).
- Une frette **sans servo** est traitée comme « non disponible » : la sélection
  explicite bascule alors en allocation automatique (politique configurable).
- **SysEx GMB** : un contrôleur (General-MIDI-Boop) découvre les capacités de
  l'instrument et s'adapte.

---

## Démarrage rapide

### 1. Tester la logique sur PC (sans matériel)

```bash
cd firmware/test
make            # compile le cœur C++ + les tests, puis les exécute
```

Attendu : `… tests, … checks, 0 failures`.

### 2. Compiler / flasher le firmware (PlatformIO)

```bash
cd firmware
./sync_web_data.sh          # copie l'interface web dans l'image LittleFS
pio run                     # build ESP32-S3-DevKitC-1
pio run -t uploadfs         # envoie l'interface web
pio run -t upload           # flashe le firmware
```

(Arduino IDE : ouvrir `firmware/firmware.ino`, le dossier `src/` est compilé
récursivement.)

### 3. Première configuration

Au premier démarrage, l'ESP32 crée un point d'accès Wi-Fi
**`Servo-Plucked-Strings-GMB`**. Connectez-vous, ouvrez l'adresse de la carte dans un
navigateur : l'**assistant de configuration** vous guide (instrument, cordes, servos
par frette), et l'**assistant d'installation** vous fait régler chaque doigt frette
par frette (presser → ajuster l'angle de contact → tester la note → suivant).

---

## Vérification

| Contrôle | Commande | Ce qu'il garantit |
|----------|----------|-------------------|
| Tests natifs | `cd firmware/test && make` | logique cœur (MIDI/CC, allocation, FSM, config servo-frette, doigts à engrenage, governor) |
| Compile plateforme | `firmware/test/hostcheck/run.sh` | `main.cpp` + adaptateurs ESP32 compilent (stubs) |
| Profils JSON | `firmware/test/profilecheck/run.sh` | les 5 profils chargent via le vrai parseur (round-trip) |
| Interface web | ouvrir `web-interface/index.html` | wizard + assistant + sélection CC (backend simulé) |
| Build firmware | `cd firmware && pio run` | build ESP32-S3 réel (toolchain PlatformIO requise) |

---

## Structure

```
esp32/
├── firmware/
│   ├── src/core/         Cœur C++17 pur (MIDI, sélection CC, allocation,
│   │                     machine à états par corde, governor courant, SysEx, sécurité)
│   ├── src/platform/esp32/  Adaptateurs ESP32 (Wi-Fi, serveur web, ServoBank, stockage)
│   ├── src/main.cpp      Intégration matérielle + scheduler servo-par-frette
│   └── test/             Tests natifs (g++) + hostcheck + profilecheck
├── web-interface/        Interface web (wizard, assistant d'installation, dashboard,
│                         moniteur MIDI, sélection CC, SysEx)
├── instrument-profiles/  Profils prêts à l'emploi (ukulélé, guitare, basse, mandoline, banjo)
├── board-profiles/       Carte ESP32-S3-DevKitC-1
└── docs/                 Guides détaillés
```

## Documentation

| Guide | Contenu |
|-------|---------|
| [docs/CALIBRATION.md](docs/CALIBRATION.md) | Calibration servo-par-frette + assistant d'installation |
| [docs/GEARED_FINGERS.md](docs/GEARED_FINGERS.md) | Doigts à engrenage (1 servo → 2 frettes) : étude, config, calibration |
| [docs/PIN_CONFIGURATION.md](docs/PIN_CONFIGURATION.md) | Broches (I2C, /OE, servos directs) |
| [docs/NETWORK_HOTSPOT.md](docs/NETWORK_HOTSPOT.md) | Hotspot bouton BOOT + portail captif (ouverture auto de la page) |
| [docs/MIDI_PROTOCOL.md](docs/MIDI_PROTOCOL.md) | Notes, sélection CC corde/frette, SysEx |
| [STRING_FRET_SELECTION.md](STRING_FRET_SELECTION.md) | Spécification de la sélection CC |
| [docs/SAFETY.md](docs/SAFETY.md) | E-stop, /OE, gestion du courant |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Organisation du code |
| [docs/WEB_INTERFACE.md](docs/WEB_INTERFACE.md) | Pages de l'interface |

## État & limites

- Firmware complet, cœur vérifié par les tests natifs ; **non validé sur un
  instrument physique** (timing servo, courant sous charge à valider au banc).
- L'E-stop logiciel ne remplace pas une **coupure matérielle** de l'alimentation
  servo (câbler le /OE des PCA sur un vrai bouton d'arrêt). Voir
  [`docs/SAFETY.md`](docs/SAFETY.md).
- Le dossier [`../arduino/`](../arduino/) (version Leonardo/PCA9685) reste inchangé.
