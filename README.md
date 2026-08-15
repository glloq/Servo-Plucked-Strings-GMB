# Servo-Plucked-Strings-GMB

> Firmware **ESP32-S3** pour un instrument à cordes pincées piloté en MIDI, où
> **chaque position de frette possède son propre servomoteur**. Toute la
> configuration se fait depuis une **page web** dans le navigateur — pas de
> moteur pas-à-pas, pas de chariot, pas de code à recompiler.

[![CI](https://github.com/glloq/Servo-Plucked-Strings-GMB/actions/workflows/ci.yml/badge.svg)](https://github.com/glloq/Servo-Plucked-Strings-GMB/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/ESP32-S3%20%7C%20WROOM--32%20%7C%20DevKit%20v1-informational.svg)](https://www.espressif.com/en/products/socs/esp32)
[![Build](https://img.shields.io/badge/build-PlatformIO%20%7C%20Arduino-orange.svg)](https://platformio.org/)
[![MIDI](https://img.shields.io/badge/MIDI-Wi--Fi%20(UDP)-green.svg)](https://www.midi.org/)

[English version](README_EN.md) | **Version française**

## 📖 Description

Ce projet transforme un instrument à cordes (guitare, basse, ukulélé,
mandoline, banjo…) en instrument automatisé contrôlé en MIDI. Pour sélectionner
une note, le système **ne déplace pas** un doigt le long de la corde : **chaque
frette équipée possède un servo-doigt dédié**. Presser le servo de la frette
cible bloque la corde à cette frette ; la frette 0 est la corde à vide et n'a
pas de servo. Un **servo de grattage** (ou de strum) met ensuite la corde en
vibration.

La hauteur de note est purement électrique :

```text
note = openNote + frette + capo + transpose
```

Aucun homing, aucun positionnement millimétrique : jouer une note revient à
choisir quel servo-doigt presser.

**Caractéristiques :**
- 🎸 1 à 6 cordes (accords), instruments à pincer ou à gratter
- 🎹 MIDI over Wi-Fi (UDP), sélection corde/frette par CC + découverte SysEx GMB
- 🕹️ Servos sur **PCA9685** (I²C) et/ou **GPIO direct** (LEDC), mixables par servo
- ⚙️ Doigt à engrenage : **un servo pour deux frettes** d'une même corde
- ⚡ Gestion du courant d'appel (étalement des démarrages + coupure PWM au repos)
- 🌐 Interface web complète : assistant de configuration, calibration guidée, banc de test
- 🧪 Cœur C++17 pur, testé sur PC (suite de tests natifs exécutée en CI à chaque push)

## 🎼 Principe

Une **corde** = plusieurs **servos-doigts** (un par frette équipée) + un **servo
de grattage** :

```text
        ┌────────────────────── une corde ──────────────────────┐
   sillet                                                     chevalet
    │  [doigt frette1] [doigt frette2] [doigt frette3] …          │
    ╞════●══════════════●══════════════●═════════════════════════╡  ← la corde
    0     1              2              3      (positions de frette)
    │                                                             │
    └─ servo de grattage (pluck) : met la corde en vibration ────┘
```

Pour jouer une note, le firmware :

1. **relâche** le doigt actuellement pressé sur la corde,
2. **presse** le servo-doigt de la frette cible (frette 0 = corde à vide, aucun doigt),
3. **laisse stabiliser**, puis
4. **gratte** la corde avec le servo de grattage.

Un seul doigt est pressé à la fois sur une corde. Jusqu'à **6 cordes** jouent en
parallèle (accords).

### Ce qui est configurable par servo

- **Position de contact corde/frette** : angle de repos ↔ angle d'appui (en µs) ;
- **Sens de rotation** (`inverted`) — monter le servo dans n'importe quel sens ;
- **Frettes arbitraires** — on n'équipe que les frettes voulues, les trous sont
  permis (ex. frettes 1, 3, 5, 12) ;
- **Doigt à engrenage** (`fretB`) — **un servo pour deux frettes** d'une même
  corde (deux doigts antagonistes, neutre = les deux levés), pour diviser par
  deux le nombre de servos sur le bas du manche. Voir
  [`docs/GEARED_FINGERS.md`](docs/GEARED_FINGERS.md) ;
- **Source** : un canal d'un **PCA9685** *ou* un **GPIO direct** de l'ESP32,
  mixables sur le même instrument.

### Gestion intelligente du courant

Trois mécanismes combinés évitent de saturer l'alimentation 5–6 V / les PCA9685 :

1. **Coupure PWM au repos** (`disableAtRest`) : un doigt inactif ne consomme ~rien ;
2. **Un seul doigt actif par corde** : on relâche l'ancien doigt avant de presser
   le nouveau (jamais deux couples de calage simultanés sur une corde) ;
3. **Étalement des démarrages** (`ServoActivationGovernor`) : sur un accord, les
   appuis de plusieurs cordes sont décalés dans le temps (`maxConcurrentMoves`,
   `staggerMs`) pour ne pas cumuler les pics d'appel de courant.

Câblage recommandé : **1 PCA9685 par corde** (ses doigts de frettes + son
grattage tiennent sur ≤ 16 canaux), jusqu'à **8 PCA par bus I2C** (adresses
0x40–0x47) et **16 au total** sur les deux bus de l'ESP32-S3 (table de
capacité : `hardware/README.md`). Le mapping reste néanmoins libre par servo.

## 🎹 Réception MIDI

- **Notes** en MIDI over Wi-Fi (UDP, **port 5006**).
- **Allocation automatique** : envoyez de simples notes, elles sont réparties
  sur les cordes ; ou **forcez une corde/frette exacte** avec des CC (tablature) :
  `CC20 = corde`, `CC21 = frette`, puis `Note On`. Voir
  [`STRING_FRET_SELECTION.md`](STRING_FRET_SELECTION.md) et
  [`docs/MIDI_PROTOCOL.md`](docs/MIDI_PROTOCOL.md).
- Une frette **sans servo** est traitée comme « non disponible » : la sélection
  explicite bascule alors en allocation automatique (politique configurable).
- **CC7 / CC11** (volume / expression) modulent l'attaque, **CC64** le sustain.
  **CC120** (All Sound Off) coupe le son immédiatement et **CC123** (All Notes Off)
  relâche les notes — sémantique **MIDI standard**, l'instrument **reste armé**. Un
  vrai panic est une commande distincte (`POST /api/panic` ou la broche E-stop).
- **SysEx GMB** (`F0 7D 00 …`) : un contrôleur *General-MIDI-Boop* découvre les
  capacités de l'instrument (tessiture, polyphonie, CC, accordage) et s'adapte.
  Voir [`SYSEX_CAPABILITIES.md`](SYSEX_CAPABILITIES.md).

## 🖥️ Interface web

Toute la configuration se fait dans le navigateur (servie par l'ESP32, ou en
ouvrant `web-interface/index.html` en **mode démo**). L'interface suit une règle
simple : **un écran de création ne montre que les décisions que le logiciel ne peut
pas prendre lui-même**. Vous décrivez la mécanique de votre machine, le logiciel en
déduit les servos, les cartes PCA9685, les canaux, les GPIO, le timing et le MIDI.
Tout reste modifiable, mais derrière un *Modifier…* ou un *Avancé*.

Trois pages principales — **Instrument**, **Configurer**, **Câblage** — plus le menu
engrenage (appareil & Wi-Fi, MIDI, matériel avancé, sécurité, diagnostics,
développeur). Aperçu détaillé :
[`docs/WEB_INTERFACE.md`](docs/WEB_INTERFACE.md).

**Premier démarrage** — tant que rien n'a été configuré, l'interface ouvre sur un
écran d'accueil qui mène directement à la création (modèle ou instrument sur mesure).
Une fois la configuration appliquée, **Instrument** redevient la page d'accueil.

**Instrument** — manche jouable façon GMB : un cercle de note par frette utilisée
et par corde à vide, gros arrêt d'urgence + ré-armement, sélecteur de mode de jeu,
et une barre d'accords qui gratte l'accord sur plusieurs cordes.
<p align="center"><img src="img/screenshots/fretboard.png" alt="Page Instrument" width="90%"/></p>

**Configurer** — cinq étapes : **Instrument → Frettes → Cordes → Test → Terminer**.
L'étape 1 est un véritable *concepteur d'instrument* : accordage, puis trois
questions mécaniques — *comment les frettes sont-elles actionnées ?* (une action par
frette · un servo pour deux frettes · cordes à vide · personnalisé), *comment la
corde est-elle jouée ?* (médiator simple · aller/retour · grattage), *comment la
corde est-elle arrêtée ?* (laisser résonner · médiator · étouffoir · servo de
descente). Chaque carte affiche le nombre de servos qu'elle implique, et le logiciel
répond par le récapitulatif de ce qu'il vient de générer.
<p align="center"><img src="img/screenshots/wizard.png" alt="Configurer — étape Instrument" width="90%"/></p>

Les étapes de calibration ne montrent plus que les positions à trouver à l'œil —
repos et appui — avec un test, la note, et *Frette suivante →*. Le câblage tient en
une ligne (`PCA #2 · CH7 ✓  Modifier…`).
<p align="center"><img src="img/screenshots/calibration.png" alt="Configurer — calibration des frettes" width="90%"/></p>


**Câblage** — le faisceau est **généré**, pas configuré : le schéma ESP32 + PCA9685
de l'instrument courant (un ou deux bus I²C, adresses, corde·rôle par broche,
contrôles de conflit en direct, export SVG) avec les conseils de **câblage de
puissance** (étoile, condensateur de réservoir par carte, 100 nF, `/OE` fail-safe),
puis la **check-list de mise en service** dont chaque étape est une vraie barrière
(les cases de l'étape suivante restent désactivées tant que la précédente n'est pas
complète, avec déverrouillage explicite).
<p align="center"><img src="img/screenshots/wiring.png" alt="Carte de câblage ESP32 + PCA9685" width="90%"/></p>

**⚙ Matériel avancé** — tout ce que le générateur décide normalement reste accessible
en un clic : carte ESP32, capacité et bus des PCA9685, réactivité (rapide /
équilibrée / alimentation limitée, avec chaque valeur exacte), grille GPIO et arrêt
d'urgence matériel, adressage I²C et budget de pull-ups, dossier puissance & sécurité dont l'estimateur
donne le pic **gouverné** (sous les limites de courant) *et* le pic **absolu** (tous
les servos calés) par branche — le câblage et l'alimentation se dimensionnent sur
l'absolu, le governor étant logiciel. Le budget de pull-ups I²C ne suppose rien :
une carte reste *inconnue* tant que vous n'avez pas déclaré ce qui est monté.
<p align="center"><img src="img/screenshots/wiring-power.png" alt="Puissance & sécurité — arbre de puissance et estimateur" width="90%"/></p>
<p align="center"><img src="img/screenshots/pins.png" alt="Broches GPIO + brochage de la carte" width="90%"/></p>

## 🔌 Matériel

<img src="img/Schemas.png" alt="Architecture PCA9685" width="80%"/>

- **Carte** : ESP32-S3-DevKitC-1, ESP32-WROOM-32 (DevKitC 38 broches) ou ESP32
  DevKit v1 (30 broches), sélectionnable — le profil de carte filtre les GPIO
  utilisables et le brochage est affiché graphiquement.
- **Servos** : PWM issu d'un **canal PCA9685** (I²C, jusqu'à 8 cartes 0x40–0x47,
  16 canaux chacune) **ou** d'un **GPIO direct** (LEDC, jusqu'à 8 servos),
  mixables par servo.
- **Sécurité** : la ligne `/OE` des PCA (active à l'état bas) neutralise
  instantanément tous les servos PCA ; les servos directs sont détachés à l'arrêt.
  À câbler sur un vrai bouton d'arrêt matériel. Voir [`docs/SAFETY.md`](docs/SAFETY.md).
- **Alimentation** : rail servo 5–6 V **séparé**, dimensionné au nombre de servos
  (aucun servo alimenté par le régulateur de l'ESP32).

Détails : [`hardware/`](hardware/) (BOM, câblage) et
[`docs/PIN_CONFIGURATION.md`](docs/PIN_CONFIGURATION.md).

## 🚀 Démarrage rapide

### 1. Tester la logique sur PC (sans matériel)

```bash
cd firmware/test
make            # compile le cœur C++ + les tests, puis les exécute
```

Attendu : `… tests, … checks, 0 failures` (le nombre exact évolue avec la suite ;
la [CI](https://github.com/glloq/Servo-Plucked-Strings-GMB/actions/workflows/ci.yml)
fait foi).

### 2. Compiler / flasher le firmware (PlatformIO)

```bash
cd firmware
pio run                     # build ESP32-S3-DevKitC-1
pio run -t upload           # flashe le firmware (interface web incluse)
```

L'interface web est **embarquée dans le binaire** : rien d'autre à téléverser.
(Optionnel, pour itérer sur l'UI sans recompiler : `./sync_web_data.sh` puis
`pio run -t uploadfs` — les fichiers LittleFS priment sur la copie embarquée.)

(Arduino IDE : ouvrir `firmware/firmware.ino`, le dossier `src/` est compilé
récursivement. Voir [`docs/ARDUINO_IDE_BUILD.md`](docs/ARDUINO_IDE_BUILD.md).)

### 3. Première configuration

Au premier démarrage, l'ESP32 crée un point d'accès Wi-Fi
**`Servo-Plucked-Strings-GMB`**. Connectez-vous, ouvrez l'adresse de la carte
dans un navigateur : l'**assistant de configuration** vous guide (instrument,
cordes, servos par frette), et la **calibration guidée** vous fait régler chaque
doigt frette par frette (presser → ajuster l'angle de contact → tester la note →
suivant). Voir [`docs/FIRST_CONFIGURATION.md`](docs/FIRST_CONFIGURATION.md).

## ✅ Vérification

| Contrôle | Commande | Ce qu'il garantit |
|----------|----------|-------------------|
| Tests natifs | `cd firmware/test && make` | logique cœur (MIDI/CC, allocation, FSM par corde, config servo-frette, doigts à engrenage, governor, SysEx) |
| Compile plateforme | `firmware/test/hostcheck/run.sh` | `main.cpp` + adaptateurs ESP32 compilent (stubs) |
| Profils JSON | `firmware/test/profilecheck/run.sh` | les 6 profils chargent via le vrai parseur (round-trip) |
| Interface web | ouvrir `web-interface/index.html` | wizard + calibration + sélection CC (backend simulé) |
| Build firmware | `cd firmware && pio run` | build ESP32-S3 réel (toolchain PlatformIO requise) |

## 📂 Structure du dépôt

```text
Servo-Plucked-Strings-GMB/
├── firmware/               Firmware ESP32-S3
│   ├── src/core/           Cœur C++17 pur (MIDI, sélection CC, allocation,
│   │                       machine à états par corde, governor, SysEx, sécurité)
│   ├── src/platform/esp32/ Adaptateurs ESP32 (Wi-Fi, serveur web, ServoBank, stockage)
│   ├── src/main.cpp        Intégration matérielle + scheduler servo-par-frette
│   └── test/               Tests natifs (g++) + hostcheck + profilecheck
├── web-interface/          Interface web (3 pages : Instrument, Configurer,
│                           Câblage + modal engrenage : appareil, MIDI,
│                           matériel avancé, sécurité, diagnostics, développeur)
├── instrument-profiles/    Profils prêts (ukulélé + variante à engrenage, guitare,
│                           basse, mandoline, banjo)
├── board-profiles/         Profils de carte ESP32 (S3, WROOM-32, DevKit v1)
├── hardware/               BOM, schémas, câblage
├── mechanics/              Notes mécaniques (doigts, grattage)
├── docs/                   Guides détaillés
├── img/                    Schémas
├── SPECIFICATION.md        Spécification complète du projet
├── README.md               ce fichier
└── README_EN.md            English version
```

## 📚 Documentation

| Guide | Contenu |
|-------|---------|
| [SPECIFICATION.md](SPECIFICATION.md) | Spécification complète (architecture, capacités, sécurité, phases) |
| [docs/FIRST_CONFIGURATION.md](docs/FIRST_CONFIGURATION.md) | Première mise en route pas à pas |
| [docs/CALIBRATION.md](docs/CALIBRATION.md) | Calibration servo-par-frette + assistant d'installation |
| [docs/GEARED_FINGERS.md](docs/GEARED_FINGERS.md) | Doigts à engrenage (1 servo → 2 frettes) |
| [docs/PIN_CONFIGURATION.md](docs/PIN_CONFIGURATION.md) | Broches (I²C, /OE, servos directs) |
| [docs/NETWORK_HOTSPOT.md](docs/NETWORK_HOTSPOT.md) | Hotspot + portail captif |
| [docs/MIDI_PROTOCOL.md](docs/MIDI_PROTOCOL.md) | Notes, sélection CC corde/frette, SysEx |
| [STRING_FRET_SELECTION.md](STRING_FRET_SELECTION.md) | Spécification de la sélection CC |
| [SYSEX_CAPABILITIES.md](SYSEX_CAPABILITIES.md) | Protocole SysEx de découverte des capacités |
| [docs/SAFETY.md](docs/SAFETY.md) | E-stop, /OE, gestion du courant |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Organisation du code |
| [docs/WEB_INTERFACE.md](docs/WEB_INTERFACE.md) | Pages de l'interface (avec captures) |
| [docs/ARDUINO_IDE_BUILD.md](docs/ARDUINO_IDE_BUILD.md) | Compiler le firmware ESP32 depuis l'IDE Arduino |
| [hardware/POWER_AND_SAFETY.md](hardware/POWER_AND_SAFETY.md) | Circuit de référence : distribution, chaîne d'arrêt d'urgence, `/OE` fail-safe |
| [hardware/I2C_PCA9685.md](hardware/I2C_PCA9685.md) | Bus I²C : adresses, cavaliers A0–A2, pull-ups |
| [hardware/COMMISSIONING.md](hardware/COMMISSIONING.md) | Mise sous tension par étapes avant la première note |
| [hardware/schematics/](hardware/schematics/) | Schémas (distribution, E-stop + /OE, ESP32 ↔ PCA9685) |

## 🎛️ La famille GMB

Le projet reste spécialisé pour éviter un firmware universel trop complexe. Les
technologies de sélection de note sont réparties sur des dépôts séparés :

| Dépôt | Sélection de note |
|-------|-------------------|
| [Stepper-Plucked-Strings-GMB](https://github.com/glloq/Stepper-Plucked-Strings-GMB) | un moteur pas-à-pas déplace un doigt le long de chaque corde |
| **Servo-Plucked-Strings-GMB** (ce dépôt) | **un servo-doigt dédié par position de frette** |
| Solenoid-Plucked-Strings-GMB | un solénoïde fixe par position de frette |

> ℹ️ La version **Arduino / MIDIUSB** historique (Leonardo + PCA9685) ne fait
> plus partie de ce dépôt : elle est maintenue séparément dans un dépôt dédié à
> l'Arduino. Ce dépôt est désormais **100 % ESP32-S3**.

## 🚦 État & limites

- Firmware complet, cœur vérifié par les tests natifs ; **non encore validé sur
  un instrument physique** (timing servo et courant sous charge à valider au banc).
- L'E-stop logiciel ne remplace pas une **coupure matérielle** de l'alimentation
  servo : câbler le `/OE` des PCA sur un vrai bouton d'arrêt. Voir
  [`docs/SAFETY.md`](docs/SAFETY.md).

## 🤝 Contribution

Les contributions sont les bienvenues :
- 🐛 signaler des bugs
- 💡 proposer des fonctionnalités
- 📖 améliorer la documentation
- 🔧 soumettre des pull requests

## 📄 Licence

Ce projet est sous licence MIT — voir le fichier [LICENSE](LICENSE).

## 🙏 Remerciements

- [Adafruit](https://www.adafruit.com/) pour la bibliothèque PCA9685
- [ArduinoJson](https://arduinojson.org/) et [ESPAsyncWebServer](https://github.com/ESP32Async/ESPAsyncWebServer)
- Communauté ESP32 / PlatformIO

---

**Made with ❤️ for music automation**
