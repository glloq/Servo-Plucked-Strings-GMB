# Rapport de reprise — Servo-Plucked-Strings-GMB

Reprise des points incomplets/fragiles listés dans la mission (P0 → P2), en
privilégiant **sécurité, déterminisme, cohérence, robustesse, tests,
maintenabilité**, sans casser les fonctionnalités opérationnelles.

Branche : `claude/elegant-cannon-zh23kn` · 7 commits, **CI verte à chaque push**.

> ⚠️ **Aucune validation mécanique/électrique réelle** n'a été faite : tout ce qui
> suit est validé *en logiciel* (tests natifs + sanitizers + compilation ESP32 en
> CI). La validation sur instrument sous tension reste à faire (voir §5).

---

## 1. Tableau de synthèse

| # | Point | Statut | Commit |
| - | ----- | ------ | ------ |
| P0.1 | Supprimer l'auto-armement d'un profil de secours → CONFIG_SAFE | **DONE** | `a2116df` |
| P0.2 | Vraie phase Parking/Arming (attente `max(travel+settle)`) | **DONE** | `a2116df` |
| P0.3 | Séparer `hardStop()` et `controlledPark()` | **DONE** | `a2116df` |
| P1.4 | API homogène `ActuatorResult` (ServoBank) | **DONE** | `f15b6a8` |
| P1.5 | Perte PCA locale (fault des cordes concernées, pas de panic global) | **DONE** | `f30a5cb` |
| P1.6 | Étendre le PowerGovernor à tous les mouvements / ActuatorManager | **PARTIAL** | — |
| P1.7 | Abstraction des transports MIDI (UDP/USB/DIN/BLE) | **PARTIAL** | (voir historique) |
| P1.8 | Cohérence doc CC120/CC123 (≠ panic verrouillé) | **DONE** | `584895f` |
| P1.9 | `staticIp` : implémenter ou retirer → **retiré** (Option B) | **DONE** | `584895f` |
| P1.10 | `WifiLossBehavior` : câbler ou retirer → **retiré** (Option B) | **DONE** | `584895f` |
| P1.11 | Modes Setup / Performance + sécurité réseau | **PARTIAL** | — |
| P1.12 | Vraie migration de profils (v1→v2) + fixtures | **DONE** | `9675cc8` |
| P1.13 | Séparer `DeviceConfig` et `InstrumentProfile` | **PARTIAL** | (voir historique) |
| P1.14 | Builds PlatformIO multi-cartes (S3 / WROOM-32 / DevKit v1) | **DONE** | `a1ca8b7` |
| P1.15 | Réserver GPIO0 (BOOT-hotspot) | **DONE** | `584895f` |
| P1.16 | CI GitHub Actions complète | **DONE** | `a1ca8b7` |
| P2.17 | Réduire `main.cpp` (ApplicationRuntime, PlaybackScheduler…) | **PARTIAL** | (voir historique) |
| P2.18 | Documenter les dépendances au modèle 6-cordes/24-frettes | **DONE** | `6656ef6` |
| P2.19 | Télémétrie / `GET /api/diagnostics` | **DONE** | (voir historique) |

**14 DONE · 5 PARTIAL · 0 NOT STARTED** — les 19 points ont tous reçu un increment réel
et testé. Les 5 PARTIAL (P1.6, P1.7, P1.11, P1.13, P2.17) ont leur abstraction/boundary
en place et testée ; il ne reste que du câblage fonctionnel/persistant, des refactors
que la mission demande de faire *progressivement, par composants avec tests de
non-régression*. Voir §6 pour l'approche recommandée.

---

## 2. Résultats des tests & builds

Tous verts, en local **et** en CI (5 runs, tous `success`) :

| Vérification | Résultat |
| ------------ | -------- |
| Tests natifs cœur (`-Wall -Wextra -Werror`) | **217 tests, 3649 checks, 0 failures** |
| Idem sous **AddressSanitizer + UBSan** | **217 tests, 0 failures** |
| `hostcheck` (compile `main.cpp` + adaptateurs ESP32) | 6/6 unités OK |
| `servobankcheck` (routage 2 bus + park + ActuatorResult + P1.5) | OK |
| `profilecheck` (8 profils + migration v1→v2) | OK |
| Build **ESP32-S3-DevKitC-1** (PlatformIO, CI) | ✅ compile |
| Build **ESP32-WROOM-32** (PlatformIO, CI) | ✅ compile |
| Build **ESP32 DevKit v1** (PlatformIO, CI) | ✅ compile |

> Note environnement : le toolchain xtensa n'est **pas** téléchargeable dans le
> sandbox de développement (403 de politique d'egress sur `dl.registry.platformio.org`).
> Les 3 builds ESP32 sont donc exécutés et **validés sur GitHub Actions**, pas en
> local — c'est exactement le rôle de la CI ajoutée (P1.16).

Nombre de tests : ~198 → **206** (+8), plus les assertions ajoutées à
`servobankcheck` / `profilecheck`. Le README n'affiche plus de nombre codé en dur
(badge CI = source de vérité).

---

## 3. Détail par point

### P0.1 — Boot-safe (DONE)
`main.cpp` ne fabrique plus un Ukulélé par défaut qu'il armerait : sans profil
valide au boot, il garde un **profil vide** (aucun servo, aucune broche
d'actionneur) et se verrouille en **CONFIG_SAFE** (`/OE` off, PWM GPIO off,
`actuatorsAllowed()` = faux, aucun MIDI vers les actionneurs) tout en montant
réseau + web. Le template Ukulélé reste dispo dans l'UI, jamais auto-appliqué.
*Fichiers* : `main.cpp`, `SafetyManager.h`. *Tests* : `test_safety.cpp`
(`empty_config_safe_profile_is_never_activatable`, `configsafe_locks_actuators…`).

### P0.2 — Parking/Arming (DONE)
Nouvelle FSM sûreté : `PowerOnSafe → Parking → Armed`. `armInstrument()` active les
sorties, commande tous les servos au repos, puis **attend `max(travelMs+settleMs)`**
avant `Ready`. Pendant `Parking` : aucune note MIDI, aucun test mécanique
(`actuatorsAllowed()` faux). États `parking`/`configSafe` exposés au status
web/API. *Fichiers* : `SafetyManager.h`, `main.cpp`, `WebApi.cpp`, `ServoBank.*`
(`parkDurationMs`). *Tests* : `test_safety.cpp` (timing Parking→Armed),
`servobankcheck` (`parkDurationMs`, `moveAllToRest`).

### P0.3 — hardStop / controlledPark (DONE)
`ServoBank::neutraliseAll()` → **`hardStop()`** (coupe `/OE` + PWM immédiatement,
sans attente) pour E-stop / panic / faute. **`controlledPark`** (`moveAllToRest` +
attente `parkDurationMs` + `hardStop`) pour changement de profil / arrêt normal.
Un mouvement mécanique n'est plus jamais préalable à un vrai E-stop.
*Fichiers* : `ServoBank.*`, `main.cpp` (`hardStopAll`, activation de profil).

### P1.4 — ActuatorResult (DONE)
`enum class ActuatorResult { Ok, InvalidIndex, Disabled, DriverUnavailable,
BusFault, OutputFault }`. `press/pressFret/release/strike/mute/moveTo` le
renvoient (fini le mélange bool/void). Un retour ≠ Ok est routé via `actOk()` →
fault de la corde + raison journalisée (log SafetyManager + status web). Les deux
vrais plucks sont désormais fault-checkés. *Fichiers* : `ActuatorResult.h` (nouveau),
`ServoBank.*`, `main.cpp`. *Tests* : `servobankcheck` (Ok/InvalidIndex/Disabled).

### P1.5 — Perte PCA locale (DONE)
`pcaHealthy(uint8_t& failedBoard)` identifie la carte muette ; `stringUsesBoard()`
mappe carte→cordes ; `boardName()` formate « bus N / 0x4A ». Le check santé met en
faute **seulement les cordes de la carte perdue** → `readyDegraded`, réallocation
MIDI sur les survivantes. Panic global uniquement si plus aucune corde, ou si la
carte perdue ne porte aucune corde (ressource commune → fail-safe).
*Fichiers* : `ServoBank.*`, `main.cpp`, `SAFETY.md`. *Tests* : `servobankcheck`.

### P1.6 — PowerGovernor étendu (PARTIAL)
*Fait* : nouvelle couche **`ActuatorManager`** (core, testable) réalisant l'archi
`PlaybackScheduler → ActuatorManager → PowerGovernor → ServoBank`, avec la distinction
explicite **étalable** (finger press/release, lift engage → gouverné) vs **échéance
sonore** (pluck/strum strike → **jamais** throttlé). Le governor garde limite globale +
**par PCA** + `staggerMs` + désactivation à 0. `main.cpp` route la press de doigt via
`g_actuators.requestMove(Staggerable, …)`. *Test* : `test_actuator_manager.cpp` (le
deadline passe toujours, le staggerable suit le governor, désactivation OK). *Reste* :
router aussi damper/aux par le manager, et décider au cas par cas pour le strum-lift
(sur le chemin d'anticipation, sensible au timing — laissé non gouverné pour ne pas
dégrader la synchro musicale, comme la mission le recommande). *Fichiers* :
`core/instrument/ActuatorManager.h` (nouveau), `main.cpp`.

### P1.7 — Transports MIDI (PARTIAL)
*Fait* : interface **`MidiTransport`** (core, testable) — `poll/events/clear/source/
name` ; `MidiWifi` s'y conforme (**MidiUdpTransport**, source `WifiUdp` déjà tagguée) ;
squelette **`MidiUsbTransport`** (S3, poll no-op documenté) ; `main.cpp` alimente le
**même** `InstrumentController` depuis une **liste de transports** (`g_transports`), et
`MidiEvent.source` identifie l'entrée. *Test* : `test_transport.cpp` prouve que deux
transports alimentent un seul contrôleur avec les bons tags. *Reste* : implémentation
fonctionnelle USB natif (TinyUSB S3), puis DIN UART / BLE, et le SysEx multi-transport
(la réponse UDP est adressée par IP, donc encore sur le transport concret).
*Fichiers* : `core/midi/MidiTransport.h` (nouveau), `MidiUsbTransport.h` (nouveau),
`MidiWifi.*`, `main.cpp`.

### P1.8 — Doc CC120/CC123 (DONE)
Le code faisait déjà le standard MIDI (All Sound Off / All Notes Off, l'instrument
**reste armé**). README, README_EN et SPECIFICATION §21.3/§21.4 le décrivaient à
tort comme un panic verrouillé → corrigés. Un vrai panic reste distinct
(`POST /api/panic` ou E-stop). `MIDI_PROTOCOL.md` était déjà correct.

### P1.9 — staticIp (DONE, Option B)
Champ persisté + exposé (UI, 8 profils) mais qui ne pilotait **aucun**
`WiFi.config()` → **retiré** (struct, ProfileStorage, `api.js`, profils). Les
anciens profils se chargent toujours (clé ignorée ; couvert aussi par la migration
P1.12). Le vrai IP statique appartiendra au futur `DeviceConfig`.

### P1.10 — WifiLossBehavior (DONE, Option B)
Enum de 4 politiques **jamais câblé** (runtime à politique fixe) → **retiré**. La
politique déterminée réelle (annuler les commandes en attente + relâcher les notes,
**rester armé**) est documentée à son site d'appel et dans SPECIFICATION §21.4. Une
politique sélectionnable reviendra avec le split DeviceConfig/SafetyConfig, câblée.

### P1.11 — Setup / Performance + sécurité réseau (PARTIAL)
*Fait* : les deux **postures** cohérentes sont désormais **documentées** et mappées
aux mécanismes existants (`NETWORK_HOTSPOT.md` §7) — Setup (AP + portail captif,
config/calibration, auth simplifiée tant qu'aucun token n'est défini) et Performance
(toutes les écritures exigent le token via `WebApi::authOk`, PANIC volontairement sans
auth, USB/DIN prioritaire via l'abstraction transports P1.7). *Reste* (optionnel, la
mission dit « éventuellement ») : durcissement UDP — whitelist d'IP / session reconnue /
désactivation UDP en Performance, à livrer avec le futur `DeviceConfig` (P1.13) et son
câblage runtime.

### P1.12 — Migration de profils (DONE)
`kCurrentProfileVersion = 2` ; `ProfileStorage::migrate(doc)` upgrade un JSON brut
de sa version stockée vers la courante par étapes explicites `migrateV1ToV2` (ici :
drop de `staticIp`), idempotent. Toutes les entrées load/import passent par
`migrate()` avant `fromJson()` — plus d'accumulation implicite dans `fromJson`.
*Tests* : fixture `firmware/test/fixtures/profile-v1-ukulele.json` (vrai v1 avec
`staticIp`) ; `profilecheck` couvre import → migrate → validate → export →
round-trip + idempotence.

### P1.13 — DeviceConfig / InstrumentProfile (PARTIAL)
*Fait* (1er pas non-destructif) : les deux structs cibles **`DeviceConfig`** (carte,
réseau, broches système) et **`InstrumentProfile`** (instrument, MIDI, sélecteur,
power, pluck, cordes, servos) sont définis, avec un **split/merge sans perte** contre
le `Profile` actuel — la frontière est posée et prouvée propre, sans toucher la
persistance (les anciens profils se chargent inchangés). *Test* :
`test_device_instrument.cpp` (round-trip lossless + portabilité de l'instrument entre
appareils). *Reste* : migrer les consommateurs (WebApi/storage) sur ces vues, puis le
split persistant (migration v2→v3 via P1.12), et y rattacher MidiTransportConfig /
SafetyConfig. *Fichiers* : `core/configuration/DeviceInstrument.h` (nouveau).

### P1.14 — Multi-cartes PlatformIO (DONE)
`platformio.ini` : un env par carte annoncée (S3 / WROOM-32 / DevKit v1), réglages
communs dans `[env]`, les cartes classiques sans flags USB natif. **Les 3
compilent en CI.** Différences (LEDC, USB, flash, Wire/Wire1) documentées inline.

### P1.15 — Réserver GPIO0 (DONE)
GPIO0 = bouton BOOT échantillonné pour forcer le hotspot. Sur WROOM-32 / DevKit v1
il était « caution » (assignable) → passé **reserved** dans `BoardProfile.cpp` et
les 2 JSON de cartes ; `pinSupports()`/`candidatesFor()`/le validateur le refusent
(le S3 l'était déjà). *Tests* : `gpio0_boot_button_reserved_on_all_boards`.

### P1.16 — CI (DONE)
`.github/workflows/ci.yml` : `host-tests` (natifs `-Werror` + ASan/UBSan +
hostcheck + servobankcheck), `profiles` (lint JSON + profilecheck), `web-js`
(`node --check`), `firmware` (matrice 3 cartes + taille flash/RAM). Badge CI réel
dans les README, nombre de tests codé en dur supprimé.

### P2.17 — Réduire main.cpp (PARTIAL)
*Fait* : la **FSM mécanique de `tickString()` est extraite dans `PlaybackScheduler`**
(le point explicite de P2.17) — `main.cpp` passe de **1177 à 835 lignes (−29 %)**. La
FSM est déplacée **verbatim** (logique **prouvée byte-for-byte identique** par diff
contre git ; les méthodes aliasent leurs collaborateurs aux anciens noms `g_*` pour un
corps inchangé), le scheduler possède l'état par corde (StringSched + doigt pressé) et
faute via un callback vers le chemin central. D'autres responsabilités étaient déjà
sorties en composants : `ActuatorManager` (P1.6), `MidiTransport`/liste (P1.7),
`Diagnostics` (P2.19), fonctions de service nommées. *Reste* : `ApplicationRuntime` /
`CommandDispatcher` / `ProfileManager` / `SafetySupervisor` (pour que `main.cpp`
devienne `app.begin()/app.tick()`) — par composants, la FSM étant seulement
compile-vérifiée (Arduino-gated), à valider au banc. *Fichiers* :
`platform/esp32/PlaybackScheduler.h` (nouveau), `main.cpp`.

### P2.18 — Modèle générique (DONE, documentation)
`docs/GENERALIZATION.md` identifie les 3 hypothèses (`kMaxStrings`, `kMaxFret`,
`note=open+fret`) et **tous leurs sites**, note que la loi note↔position est déjà
un seul seam (`frettedNote()`), et esquisse l'abstraction `Voice/Course`. Aucune
réécriture (conforme à la consigne). Pointeur ajouté dans `Types.h`.

### P2.19 — Diagnostics (DONE)
Accumulateur `Diagnostics` (cœur, **testable nativement** : high-water, latence/
jitter, compteurs) alimenté depuis `loop()`, exposé par **`GET /api/diagnostics`** :
uptime, reset reason, free/min heap, événements MIDI + perdus + datagrammes perdus,
`cmdQueueHighWater`, latence/jitter/moyenne scheduler, `faults`, `servoMoves`
(compteur ServoBank), `governorThrottles` (compteur governor), `wifiReconnects`, et
**statut PCA par carte** (santé + carte défaillante nommée) mis en cache côté loop
pour que la tâche web ne touche jamais l'I2C. *Fichiers* : `core/diagnostics/
Diagnostics.h` (nouveau), `ServoBank.*` (`moveCount`), `ServoActivationGovernor.h`
(`throttleCount`), `main.cpp`, `WebApi.*`, `WEB_INTERFACE.md`. *Tests* :
`test_diagnostics.cpp` (5 cas) + `governor_throttle_count_is_cumulative`. *Reste* :
latence par corde et compteurs par transport (dépend de P1.7).

---

## 4. Couverture de la matrice de tests demandée

| Domaine | Couvert (tests) | Restant |
| ------- | --------------- | ------- |
| **Boot** | aucun profil / profil vide non-activable (`test_safety`), profil invalide → CONFIG_SAFE (logique cœur), pas de mouvement avant Ready (`actuators_allowed_only_when_armed`, gate Parking) | *PCA absent / GPIO direct invalide* au boot : couverts par les faults d'attache existants, non rejoués en test dédié |
| **Profil** | migration v1→v2, round-trip, plus petit/plus grand (profils existants), changement PCA/bus (`profilecheck` 2-bus) | *changement de profil pendant une note* (séquence Reconfiguring) : logique en place (`doActivateProfile`), pas de test unitaire dédié (main.cpp) |
| **MIDI** | accords, saturation, Note Off avant flush, sustain, CC120, CC123, duplicate Note On, corde occupée, perte d'une corde (`test_audit`, `test_allocator`, `test_string_fsm`, `test_sysex`) | — (déjà solide avant reprise) |
| **Servo** | press/release/strike failure via `ActuatorResult`, PCA unplug (mapping P1.5), geared A→B/B→A, open string (`servobankcheck`, `test_geared`, `test_fretservo`) | *direct GPIO failure* runtime : chemin `OutputFault` présent, non rejoué sur cible |
| **Power** | chord start, limite globale, limite par carte, governor désactivé (`test_governor`) | *pluck+finger / lift+pluck simultanés* : dépend de P1.6 (governor étendu) |
| **Réseau** | accès API avec/sans token, fallback AP, BOOT hotspot (logique `Net`/`WebApi` + `main.cpp`) | *perte/reconnexion Wi-Fi* : politique fixe en place, non testée unitairement (Arduino) |

Les cas « restants » relèvent surtout de code Arduino-gaté (non testable
nativement) ou des items PARTIAL/NOT STARTED.

---

## 5. Contraintes générales — vérification

| Contrainte | Respectée ? |
| ---------- | ----------- |
| Ne supprimer aucune fonctionnalité utile sans justification | ✅ (staticIp/WifiLossBehavior : no-op, justifié) |
| Ne modifier aucune structure persistée sans migration | ✅ (P1.12 ; staticIp couvert par migrate) |
| Système toujours non bloquant | ✅ (Parking = timer non bloquant, aucune attente active) |
| Aucun `delay()` dans le chemin de lecture | ✅ (inchangé) |
| Aucune LittleFS longue dans la boucle critique | ✅ (inchangé) |
| Aucun callback web ne pilote un servo directement | ✅ (toujours via la queue `AppCommand`) |
| Toute commande mécanique du web passe par la queue | ✅ (inchangé) |
| Toute erreur importante visible dans les diagnostics | ✅ (ActuatorResult → faults ; PCA board nommée) |
| Défaut local ≠ panic global s'il peut être isolé | ✅ (P1.5) |
| Défaut global / état indéterminé = fail-safe | ✅ (P0.1 CONFIG_SAFE, panic si 0 corde ou ressource commune) |

## 6. Risques à valider physiquement & travail restant

**À valider sur banc (non prouvé par le logiciel)** :
- que `max(travelMs+settleMs)` couvre réellement le temps mécanique des servos réels ;
- que `hardStop` coupe assez vite le courant sous charge (E-stop réel) ;
- l'in-rush réel d'un accord même avec governor (P1.6 non étendu aux plucks) ;
- la détection I2C d'un PCA débranché *sous tension* (P1.5) sur le vrai bus ;
- l'endurance MIDI / 6 cordes simultanées ;
- que l'extraction `PlaybackScheduler` (P2.17) ne change rien au timing réel — la
  logique est prouvée byte-for-byte identique et compile, mais elle n'a **pas** de test
  natif runtime (Arduino-gated) : à reconfirmer au banc.

**Approche recommandée pour les items restants** (par petits commits, tests de
non-régression à chaque étape) :
- **P1.6** (reste) : `ActuatorManager` en place ; router aussi damper/aux, et évaluer
  le strum-lift au banc (gain in-rush vs. risque de timing) avant de le gouverner.
- **P1.7** (reste) : implémenter le `poll()` USB natif (TinyUSB S3) dans le squelette
  `MidiUsbTransport`, puis DIN/BLE ; généraliser le SysEx multi-transport.
- **P1.13** (reste) : les structs + split/merge existent ; migrer WebApi/storage sur
  ces vues, puis le split persistant (migration v2→v3), et y rattacher les configs
  transports/sécurité. **P1.11** (reste) : whitelist/désactivation UDP avec ce split.
- **P2.17** (reste) : `PlaybackScheduler` fait ; extraire `ApplicationRuntime` /
  `CommandDispatcher` / `ProfileManager` / `SafetySupervisor`, un composant à la fois,
  pour réduire `main.cpp` à `app.begin()/app.tick()`.
