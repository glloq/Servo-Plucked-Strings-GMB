# Rapport de reprise — Servo-Plucked-Strings-GMB

Reprise des points incomplets/fragiles listés dans la mission (P0 → P2), en
privilégiant **sécurité, déterminisme, cohérence, robustesse, tests,
maintenabilité**, sans casser les fonctionnalités opérationnelles.

Branche : `claude/elegant-cannon-zh23kn` · ~23 commits d'audit (petits, indépendants),
**CI verte à chaque push** (une faille de flake CI corrigée, cf. P1.16 §4).

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
| P1.6 | Étendre le PowerGovernor à tous les mouvements / ActuatorManager | **DONE** | (voir historique) |
| P1.7 | Abstraction des transports MIDI (UDP+DIN fonctionnels ; USB/BLE restants) | **PARTIAL** | (voir historique) |
| P1.8 | Cohérence doc CC120/CC123 (≠ panic verrouillé) | **DONE** | `584895f` |
| P1.9 | `staticIp` : implémenter ou retirer → **retiré** (Option B) | **DONE** | `584895f` |
| P1.10 | `WifiLossBehavior` : câbler ou retirer → **retiré** (Option B) | **DONE** | `584895f` |
| P1.11 | Modes Setup/Performance + sécurité réseau (postures + gate UDP host-testé ; câblage runtime différé) | **PARTIAL** | (voir historique) |
| P1.12 | Vraie migration de profils (v1→v2) + fixtures | **DONE** | `9675cc8` |
| P1.13 | Séparer `DeviceConfig`/`InstrumentProfile` (structs + split disque faits ; web/comportement différés) | **PARTIAL** | (voir historique) |
| P1.14 | Builds PlatformIO multi-cartes (S3 / WROOM-32 / DevKit v1) | **DONE** | `a1ca8b7` |
| P1.15 | Réserver GPIO0 (BOOT-hotspot) | **DONE** | `584895f` |
| P1.16 | CI GitHub Actions complète | **DONE** | `a1ca8b7` |
| P2.17 | Réduire `main.cpp` (ApplicationRuntime, PlaybackScheduler…) | **PARTIAL** | (voir historique) |
| P2.18 | Documenter les dépendances au modèle 6-cordes/24-frettes | **DONE** | `6656ef6` |
| P2.19 | Télémétrie / `GET /api/diagnostics` | **DONE** | (voir historique) |

**15 DONE · 4 PARTIAL · 0 NOT STARTED** — les 19 points ont tous reçu un increment réel
et testé. Les 4 PARTIAL (P1.7, P1.11, P1.13, P2.17) ont leur abstraction/boundary en
place et testée ; il ne reste que du câblage fonctionnel/persistant, des refactors que
la mission demande de faire *progressivement, par composants avec tests de
non-régression*. Voir §6 pour l'approche recommandée.

---

## 2. Résultats des tests & builds

Tous verts, en local **et** en CI (tous les runs `success` ; cf. la note flake P1.16 §4) :

| Vérification | Résultat |
| ------------ | -------- |
| Tests natifs cœur (`-Wall -Wextra -Werror`) | **294 tests, 4310 checks, 0 failures** |
| Idem sous **AddressSanitizer + UBSan** | **294 tests, 0 failures** |
| `hostcheck` (compile `main.cpp` + adaptateurs ESP32) | 6/6 unités OK |
| `servobankcheck` (routage 2 bus + park + ActuatorResult + P1.5) | OK |
| `profilecheck` (8 profils + migration v1→v2 + split slot device/instrument P1.13) | OK |
| Build **ESP32-S3-DevKitC-1** (PlatformIO, CI) | ✅ compile |
| Build **ESP32-WROOM-32** (PlatformIO, CI) | ✅ compile |
| Build **ESP32 DevKit v1** (PlatformIO, CI) | ✅ compile |

> Note environnement : le toolchain xtensa n'est **pas** téléchargeable dans le
> sandbox de développement (403 de politique d'egress sur `dl.registry.platformio.org`).
> Les 3 builds ESP32 sont donc exécutés et **validés sur GitHub Actions**, pas en
> local — c'est exactement le rôle de la CI ajoutée (P1.16).

Nombre de tests : ~198 → **239** (+41), plus les assertions ajoutées à
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

### P1.6 — PowerGovernor étendu (DONE, hors validation banc)
Couche **`ActuatorManager`** (core, testable) réalisant l'archi
`PlaybackScheduler → ActuatorManager → PowerGovernor → ServoBank`, avec la distinction
**étalable** vs **échéance sonore**. **Les DEUX événements d'in-rush simultané sont
désormais gouvernés** : l'attaque d'accord (**presses de doigts**) *et* la relâche
d'accord (**strikes de dampers**), tous deux via `requestMove(Staggerable)` — la press
de doigt dans la phase `PressingFinger`, et le damper de Note-Off via une **infra de
retry** (`pendingDamper` : la frappe est différée jusqu'au permis du governor, et la
déclaration `idle` attend que le damper différé ait physiquement voyagé — un mute
retardé de quelques ms ne fait que laisser la corde sonner un cheveu plus longtemps).
Les pluck/strum strikes (le son) restent **Deadline** (jamais throttlés). Le manager
compte la **répartition** (`moveMix` dans `GET /api/diagnostics`). Le governor garde
limite globale + **par PCA** + `staggerMs` + désactivation à 0. *Tests* :
`test_actuator_manager.cpp` (deadline toujours passant, staggerable gouverné, comptage).
*Exclusions volontaires* : le strum-lift reste non gouverné (chemin d'anticipation,
sensible au timing — la mission recommande de ne pas dégrader la synchro musicale) ; les
aux sont configurables plus tard. *Réserve* : la logique `pendingDamper` est **compile-
vérifiée** (FSM Arduino-gated) — à reconfirmer au banc, comme le reste de la FSM.
*Fichiers* : `core/instrument/ActuatorManager.h`, `platform/esp32/PlaybackScheduler.h`,
`core/diagnostics/Diagnostics.h`, `main.cpp`.

### P1.7 — Transports MIDI (PARTIAL)
*Fait* : interface **`MidiTransport`** (core, testable) — `poll/events/clear/source/
name` ; `MidiWifi` s'y conforme (**MidiUdpTransport**, source `WifiUdp` déjà tagguée,
**fonctionnel**) ; **`MidiDinTransport`** (DIN-5/TRS sur UART) est **fonctionnel** — la
logique octet→événement est complète : il lit un `Stream*` à 31250 baud (lecture bornée
par tick pour ne pas retarder la boucle de contrôle / l'E-stop) et alimente le
`MidiParser` (source `Din`), exactement comme l'UDP ; il ne lui manque qu'un `Stream`
(pin RX DIN) passé à `begin()` — câblé **inerte** (`begin(nullptr)`) en attendant qu'une
config de pin l'expose ; squelette **`MidiUsbTransport`** (S3, poll no-op documenté,
attend TinyUSB) ; `main.cpp` alimente le **même** `InstrumentController` depuis une
**liste de transports** (`g_transports = {UDP, USB, DIN}`), et `MidiEvent.source`
identifie l'entrée. *Test* : `test_transport.cpp` prouve que plusieurs transports
alimentent un seul contrôleur avec les bons tags ; la branche `ARDUINO` de
`MidiDinTransport` (lecture `Stream`) est compilée par hostcheck (`-DARDUINO=300`).
*Reste* : implémentation fonctionnelle USB natif (TinyUSB S3), BLE, la liaison d'un
UART réel au DIN (pin RX dans la future `DeviceConfig`), et le SysEx multi-transport
(la réponse UDP est adressée par IP, donc encore sur le transport concret). *Non validé
physiquement* : la réception DIN réelle (opto-coupleur 6N138 + UART) reste à valider au
banc — seule la logique de décodage est testée en hôte.
*Fichiers* : `core/midi/MidiTransport.h` (nouveau), `MidiDinTransport.h` (nouveau),
`MidiUsbTransport.h` (nouveau), `MidiWifi.*`, `main.cpp`.

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
*Fait (postures)* : les deux **postures** cohérentes sont **documentées** et mappées
aux mécanismes existants (`NETWORK_HOTSPOT.md` §7) — Setup (AP + portail captif,
config/calibration, auth simplifiée tant qu'aucun token n'est défini) et Performance
(toutes les écritures exigent le token via `WebApi::authOk`, PANIC volontairement sans
auth, USB/DIN prioritaire via l'abstraction transports P1.7). *Fait (durcissement UDP)* :
le **kernel de filtrage est implémenté et host-testé** — **`UdpSourceGate`**
(`core/net`) avec 3 postures : `Open` (défaut, inchangé), `LockToFirst` (**session
reconnue** : verrou sur le premier expéditeur → un pirate du réseau ne peut plus injecter
une fois qu'un contrôleur parle) et `Disabled` (**UDP coupé** en Performance). Chaque refus
est compté (`MidiWifi::rejectedPackets()`). `MidiWifi` le consulte dans `poll()` avant de
parser, mais **inerte** (`Open`) jusqu'à ce qu'un runtime/`DeviceConfig` appelle
`setSourcePolicy()` — même patron que le transport DIN (logique complète et testée,
activation + validation socket réel différées au banc). *Test* : `test_udp_source_gate.cpp`
(3 postures, cycle lock/unlock, port dans l'identité, compteur, session fraîche au
changement de politique). *Reste* : câbler la posture au mode Performance via le
`DeviceConfig` runtime (P1.13) ; whitelist multi-IP explicite en extension ; validation
réseau réelle. *Fichiers* : `core/net/UdpSourceGate.h`, `platform/esp32/MidiWifi.{h,cpp}`.

### P1.12 — Migration de profils (DONE)
`kCurrentProfileVersion = 2` ; `ProfileStorage::migrate(doc)` upgrade un JSON brut
de sa version stockée vers la courante par étapes explicites `migrateV1ToV2` (ici :
drop de `staticIp`), idempotent. Toutes les entrées load/import passent par
`migrate()` avant `fromJson()` — plus d'accumulation implicite dans `fromJson`.
*Tests* : fixture `firmware/test/fixtures/profile-v1-ukulele.json` (vrai v1 avec
`staticIp`) ; `profilecheck` couvre import → migrate → validate → export →
round-trip + idempotence.

### P1.13 — DeviceConfig / InstrumentProfile (PARTIAL, gros avancement)
*Fait (structs)* : les deux structs cibles **`DeviceConfig`** (carte, réseau, broches
système) et **`InstrumentProfile`** (instrument, MIDI, sélecteur, power, pluck, cordes,
servos) sont définis, avec un **split/merge sans perte** (`test_device_instrument.cpp`).
*Fait (persistance)* : **les slots sur disque sont désormais persistés en deux sections
`device`/`instrument`** (marqueur `storageFormat: gmb-split-v1`) — le split est réel là
où c'est stocké. Choix de risque contenu : le **format d'échange** (web `GET/PUT
/api/profile`, import/export) **reste plat et inchangé**, donc l'UI navigateur (qui
consomme le plat sur ~100 sites et ne peut pas être validée fonctionnellement en phase
logicielle) n'est pas touchée. `toSlotJson`/`fromSlotJson` sont de **fins wrappers de
re-parenting** autour de `toJson`/`fromJson` → une seule source de logique de champs, zéro
duplication. `fromSlotJson` lit aussi un **slot plat hérité** (y compris v1, qu'il migre)
→ aucun profil orphelin ; un slot hérité est réécrit en split au prochain save (migration
paresseuse, non-destructive ; le chemin atomique temp+`.bak` est inchangé). `storageFormat`
est **orthogonal à `profileVersion`** (disposition vs schéma de champs). *Test* :
`profilecheck` « device/instrument split slot storage » (forme split asservie, round-trip
lossless, slot plat hérité **et** slot v1 hérité se chargent) — **vert sous ASan/UBSan**.
*Reste (assumé, différé)* : la **portabilité comportementale** (charger *seulement* la
moitié instrument sur un appareil en préservant sa config device — le vrai swap
inter-appareils) n'est pas câblée ; et le split du **format d'échange/web** est différé à
la phase banc/navigateur (il toucherait l'UI non-testable ici). Y rattacher ensuite
MidiTransportConfig / SafetyConfig. *Fichiers* : `core/configuration/DeviceInstrument.h`,
`platform/esp32/ProfileStorage.{h,cpp}`, `test/profilecheck/main.cpp`,
`docs/DEVICE_INSTRUMENT.md` (nouveau).

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

**Correctif flake (observé puis corrigé)** : un run a échoué `profilecheck` avec des
types ArduinoJson « non déclarés » alors que le même arbre compile en local et que le
commit suivant passait, intact. Cause : `hostcheck`/`profilecheck` téléchargeaient
l'en-tête ArduinoJson avec `curl -sSL` (sans `--fail`) — un aléa réseau/redirection
sauvegardait une page d'erreur **à la place** de l'en-tête et `curl` sortait quand même
0, donc la compilation tournait contre un en-tête cassé. Les deux scripts utilisent
maintenant `curl -fsSL --retry 3 --retry-delay 2` avec un fichier `.tmp` déplacé
seulement en cas de succès : une erreur HTTP est un échec (jamais mise en cache), un
aléa transitoire est réessayé, un téléchargement partiel n'empoisonne pas le run
suivant. Vérifié en vidant le cache puis en relançant les deux harnais (verts).

### P2.17 — Réduire main.cpp (PARTIAL)
*Fait* : la **FSM mécanique de `tickString()` est extraite dans `PlaybackScheduler`**
(le point explicite de P2.17) — `main.cpp` passe de **1177 à 692 lignes (−41 %)**. La
FSM est déplacée **verbatim** (logique **prouvée byte-for-byte identique** par diff
contre git ; les méthodes aliasent leurs collaborateurs aux anciens noms `g_*` pour un
corps inchangé), le scheduler possède l'état par corde (StringSched + doigt pressé) et
faute via un callback vers le chemin central. D'autres responsabilités étaient déjà
sorties en composants : le **`CommandDispatcher`** (queue web→loop + dispatch, les
handlers restant injectés depuis `main.cpp`), l'**`ActuatorManager`** (P1.6), le
**`MidiTransport`**/liste (P1.7), le **`Diagnostics`** (P2.19), les utilitaires
host-testés **`CommandResultRing`**, **`HoldButton`** (bouton BOOT) et
**`ProfileActivation`** (bascule de profil en deux phases, RAII + timing). Deux
kernels supplémentaires ont été sortis **dans `core/app/`, host-testés** : **`AppPhase`**
+ `appPhaseName()` (la table phase→label que l'UI et `/api/diagnostics` consomment,
pinnée) et **`Readiness`** + `applyRuntimeFaults()` (la règle *ready/degraded* de P1.5 —
une corde n'est prête que si activée **et** non-faultée ; l'instrument est *degraded* dès
qu'une corde activée disparaît), plus des fonctions de service nommées. Enfin, la
**`SafetySupervisor`** regroupe le cœur **stateful** de la séquence P0 (`arm`,
`serviceParking`, `reset`, `hardStop`, `panic`, `emergencyStop`, `faultAxis`,
`locked`) — corps **déplacés verbatim** (les grosses méthodes aliasent leurs
collaborateurs aux anciens noms `g_*`), les fonctions libres de `main.cpp` devenant de
simples délégués → **tous les sites d'appel inchangés**. Elle **ne possède aucun état** :
elle référence via `bind()` les mêmes `SafetyManager` / pile d'actionneurs / phase /
`degraded` / vecteur de faults / pin E-stop / profil que tous les autres lecteurs, et
3 étapes transverses (rebuild+notify capabilities, cleanup hard-stop = test-notes +
swap en attente) sont injectées en callbacks. **Non validé au banc** : comme la FSM,
c'est du code Arduino-gated **compile-vérifié seulement** (hostcheck) ; l'équivalence
est garantie *par construction* (verbatim + sites inchangés), pas prouvée sur matériel.
*Reste* : `ApplicationRuntime` / `ProfileManager` (pour que `main.cpp` devienne
`app.begin()/app.tick()`) — étape suivante, moins critique.
*Fichiers* : `platform/esp32/PlaybackScheduler.h`, `platform/esp32/CommandDispatcher.h`,
`platform/esp32/SafetySupervisor.h`, `core/util/CommandResultRing.h`,
`core/util/HoldButton.h`, `core/configuration/ProfileActivation.h`,
`core/app/AppPhase.h`, `core/app/Readiness.h` (nouveaux), `main.cpp`.

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
- que les extractions `PlaybackScheduler` **et `SafetySupervisor`** (P2.17) ne changent
  rien au comportement réel — corps déplacés verbatim, sites d'appel inchangés, aucun
  état déplacé, et ça compile ; mais c'est du code Arduino-gated **sans test natif
  runtime** : la séquence armement/parking/hardStop/panic/E-stop est à **reconfirmer au
  banc** (c'est du P0, l'équivalence est garantie par construction, pas prouvée) ;
- que l'étalement des dampers de relâche d'accord (P1.6, `pendingDamper`, compile-
  vérifié) reste musicalement transparent sous charge réelle.

**Approche recommandée pour les items restants** (par petits commits, tests de
non-régression à chaque étape) :
- **P1.6** : fait (attaque + relâche d'accord gouvernées). Au banc : confirmer que
  l'étalement des dampers ne crée pas d'artefact audible et évaluer si le strum-lift
  mérite d'être gouverné (gain in-rush vs. risque de timing).
- **P1.7** (reste) : UDP + DIN fonctionnels (logique complète) ; lier un vrai UART au
  DIN (pin RX dans `DeviceConfig`) et valider la réception au banc (opto 6N138) ;
  implémenter le `poll()` USB natif (TinyUSB S3) dans le squelette `MidiUsbTransport`,
  puis BLE ; généraliser le SysEx multi-transport.
- **P1.13** (reste) : structs + **split persistant sur disque faits** (avec migration
  paresseuse + tests). Restent la **portabilité comportementale** (opération « importer
  l'instrument seul » sans écraser la config device) et le split du **format d'échange/
  web** — ce dernier différé car il touche l'UI navigateur non-testable ici. Puis y
  rattacher les configs transports/sécurité. **P1.11** (reste) : le gate UDP
  (`UdpSourceGate`) est fait et host-testé ; reste à câbler sa posture au mode
  Performance via le `DeviceConfig` runtime, et à valider sur réseau réel.
- **P2.17** (reste) : `PlaybackScheduler`, `CommandDispatcher`, **`SafetySupervisor`**,
  `AppPhase`, `Readiness` et les utilitaires sont sortis (**main.cpp −41 %**). La
  `SafetySupervisor` (séquence armement/panic P0) a été extraite **verbatim, sites
  d'appel inchangés, sans déplacer d'état** — donc compile-vérifiée (Arduino-gated),
  **à revalider au banc**. Reste `ApplicationRuntime` / `ProfileManager` (pour aller
  vers `app.begin()/app.tick()`), moins critique.


---

## 7. Reprise audit firmware — ordre E-stop, erreurs PCA, état ServoBank, HIL

Second passage d'audit (branche `claude/audit-ux-ui-servo-rtmfq6`). Les trois
défauts P1/P2 signalés sont corrigés, chacun avec un test qui **échoue sur l'ancien
code**, et la campagne HIL manquante est livrée sous forme de harnais exécutable.

| Priorité | Point | Statut |
| -------- | ----- | ------ |
| P1 | E-stop exécuté après `g_net.tick()` | **DONE** |
| P1 | `delay(100)` dans le démarrage de l'AP | **DONE** (FSM horodatée) |
| P1 | Échec d'écriture PCA non détecté immédiatement | **DONE** (`setPWM()` vérifié) |
| P2 | État interne servo modifié avant confirmation d'écriture | **DONE** |
| P2 | Validation physique / HIL | **HARNAIS LIVRÉ, jamais exécuté sur matériel** |

### 7.1 — SAFETY FIRST devient vrai (P1)

`loop()` appelait `g_net.tick()` avant le sondage de l'E-stop, malgré le
commentaire. Le bloc E-stop est extrait en `serviceEstop(nowMs)` et exécuté en
**première** instruction utile de `loop()`, avec `servicePanic()` juste derrière ;
le réseau vient après. Rien entre le début de `loop()` et cette ligne ne doit
bloquer ni toucher la pile réseau.

### 7.2 — Plus aucun `delay()` sur un chemin appelé depuis `loop()` (P1)

`Net::startAccessPoint()` faisait `WiFi.mode(WIFI_AP); delay(100); WiFi.softAP(...)`,
et ce chemin est atteignable depuis `tick()` — donc depuis `loop()` : un fallback
réseau ou un hotspot forcé décalait le sondage de sécurité de 100 ms, précisément
sur les trames où le réseau allait déjà mal. Remplacé par une FSM à deux temps :

```text
startAccessPoint(now)   → WiFi.mode(WIFI_AP), apPending, horodatage
tick(now < +100 ms)     → rend la main immédiatement
tick(now >= +100 ms)    → finishAccessPoint() : softAP() + portail captif
```

`accessPointActive()` reste **faux** pendant la fenêtre : personne ne voit un AP
« connecté » qui n'existe pas encore. Un `begin()` annule un démarrage en cours.
`Net.cpp` entre dans le build natif ; `test_net_ap.cpp` (5 cas) vérifie la machine
à états **et chronomètre les appels** — un `delay(100)` ferait échouer le test.

### 7.3 — Les écritures PCA9685 remontent enfin leurs erreurs (P1)

`Adafruit_PWMServoDriver::writeMicroseconds()` appelle `setPWM()` et **jette son
code retour**. Une fois la carte détectée au boot, toute écriture ultérieure était
donc déclarée `Ok`, carte débranchée comprise : le firmware croyait le doigt
pressé et enchaînait le grattage — mauvaise note, corde à vide ou silence — et
seule la sonde `pcaHealthy()` périodique s'en apercevait, jusqu'à 500 ms plus tard.

`ServoBank::writePcaMicros()` convertit µs → ticks lui-même (relation §7.3.5 du
datasheet, prescale et oscillateur mis en cache au `begin()`) et **vérifie le
retour de `setPWM()`** : 0 = transaction I²C acceptée, sinon `BusFault`. Effets de
bord bienvenus : plus de `readPrescale()` — une **lecture I²C à chaque écriture de
servo** que faisait `writeMicroseconds()` — et un arrondi au tick le plus proche
au lieu d'une troncature (±2,4 µs au lieu de −4,9..0, soit ~0,2° de mieux).

Les stubs de `hostcheck` et `servobankcheck` déclaraient `setPWM()` `void` : ils ne
*pouvaient pas* révéler le défaut. Ils reproduisent maintenant les signatures
réelles, et `servobankcheck` sait injecter une erreur I²C (`g_pwmError`).

### 7.4 — Le modèle logiciel ne bouge qu'après acceptation (P2)

`rt_[index].lastUs` était écrit **avant** de savoir si l'écriture passerait, et
`press/pressFret/release/strike/mute/moveTo` changeaient `mode` (et la parité
d'alternance) quel que soit le résultat. Conséquences réelles : `sweepMsToFret()`
calculait le déplacement suivant depuis une position jamais atteinte, un `release()`
refusé annonçait « doigt levé » alors qu'il pressait toujours, et un `strike()`
refusé consommait la parité — le coup suivant partait dans le mauvais sens.

Règle appliquée partout : **l'état ne change qu'une fois la commande acceptée par
le driver**. Une exception documentée : la sortie automatique de `Striking` dans
`update()` a lieu même en échec, sinon `toRest()` serait réémis à chaque tick sur
un bus déjà mort ; la position physique, elle, vit dans `lastUs`, qui n'avance pas.

`test_servobank_writefail.cpp` (8 cas) verrouille tout ça — dont la parité
d'alternance et la non-régression de `sweepMsToFret()`. **Vérifié en réintroduisant
les deux défauts : 6 des 8 tests échouent**, plus un dans `servobankcheck`.

### 7.5 — Campagne HIL (P2)

`firmware/test/hil/` : un pilote Python (bibliothèque standard seule) qui conduit
un **vrai** appareil par son API REST, plus la procédure de banc.

14 scénarios, dont exactement ceux demandés : boot sans profil, armement, `/OE` au
scope, accord et Note On/Off rapides, latence de `loop()` pendant que la radio
travaille, E-stop (y compris **pendant du trafic réseau**), PCA débranché en cours
de jeu, SDA/SCL bloqué, chute d'alimentation servo, changement de profil pendant
une note, panic HTTP, perte Wi-Fi, reset ESP32.

Semi-automatisé : tout ce qui est observable par l'API est asserté par le script ;
tout ce qui demande une main sur un connecteur est demandé à l'opérateur, puis son
**effet** est asserté automatiquement. Un pas sauté est compté « skipped », jamais
« passed ». Rapport JSON à joindre au dossier de mise en service.

> ⚠️ Le harnais **n'a jamais tourné sur du matériel** — il n'y en avait pas. Il est
> écrit contre le contrat d'API, pas contre un appareil. Il a en revanche été
> exercé de bout en bout contre un appareil simulé (22 checks automatiques
> exécutés, échecs correctement détectés quand le faux appareil refuse de
> s'arrêter sur panic).

### 7.6 — Ce que ce passage ne prouve toujours pas

Rien de mécanique ni d'électrique. Les corrections 7.1 à 7.4 sont validées par
tests natifs + sanitizers + compilation ESP32 ; la 7.3 en particulier touche du
code `#if defined(ARDUINO)` dont seule la **contrat** est testable à l'hôte. Le
premier passage au banc doit donc valider le harnais autant que le firmware, et
`pca_loss` / `estop` / `oe` sont les trois scénarios qui ferment réellement les
points de cet audit.

Restent inchangés et hors périmètre de ce passage : DIN physique (UART non
raccordé), USB-MIDI (squelette TinyUSB), BLE.


---

## 8. Troisième passage — FULL OFF PCA9685, neutralisation transactionnelle, LEDC, HIL

| Priorité | Point | Statut |
| -------- | ----- | ------ |
| P1 | `FULL OFF` PCA9685 incorrect (`setPWM(ch,0,0)`) | **DONE** |
| P1 | Neutralisation avant `/OE` non vérifiée | **DONE** (transactionnelle) |
| P2 | Erreurs `ledcWrite()` / `ledcDetach()` ignorées | **DONE** |
| P2 | Harnais HIL incompatible avec l'API réelle | **DONE** (+ auto-testé en CI) |
| P2 | Véritable campagne matérielle | **toujours à effectuer** |

### 8.1 — Le vrai FULL OFF du PCA9685 (P1)

`writeOff()` émettait `setPWM(ch, 0, 0)`. Ce n'est pas la neutralisation définie
par le composant : le PCA9685 possède un bit dédié `LEDn_OFF_H[4]`, atteint avec
un compteur OFF de **4096**, et NXP déconseille explicitement de programmer les
compteurs ON et OFF à la même valeur — ce que `(0, 0)` fait. C'est d'ailleurs ce
`4096` qu'émet `setPin(num, 0)` d'Adafruit.

Corrigé en `setPWM(ch, 0, kPcaFullOff)`. Le point comptait : `writeOff()` sert à
`hardStop()`, à `neutralizePcaOutputs()` et à la coupure PWM au repos
(`disableAtRest`) — soit les trois chemins par lesquels une sortie est censée
devenir silencieuse.

Le stub `servobankcheck` n'enregistre `off` que pour 4096 : **la vérification
échoue sur l'ancien encodage** (constaté en le réintroduisant).

### 8.2 — La neutralisation devient transactionnelle (P1)

`neutralizePcaOutputs()` ne retournait rien et `writeOff()` jetait le statut I²C.
Le scénario restait donc ouvert : une écriture de neutralisation échoue en
silence → le canal garde son impulsion latchée → `/OE` passe à LOW → l'ancien
ordre servo est relâché au moment précis où les sorties s'animent. Exactement
l'inverse du principe documenté.

Désormais :

```cpp
ActuatorResult writeOff(int index);
ParkResult     neutralizePcaOutputs();   // première défaillance rapportée
```

et les deux appelants (`SafetySupervisor::arm()` et le swap de profil de
`main.cpp`) refusent d'abaisser `/OE` :

```cpp
ServoBank::ParkResult neutral = g_servos.neutralizePcaOutputs();
if (!neutral.ok) {
    g_servos.outputEnable(false);          // /OE reste HIGH
    g_safety.recordFault("neutralise", …);
    return false;                          // armement / swap refusé
}
g_servos.outputEnable(true);
```

Tous les canaux restent tentés (un appelant qui abandonne veut avoir fait taire
ce qu'il pouvait), mais la **première** défaillance est remontée avec son servo et
sa raison. 5 nouveaux cas natifs + 2 dans `servobankcheck`.

### 8.3 — Les servos GPIO directs rejoignent la règle (P2)

La garantie « le modèle logiciel ne bouge que si le driver a accepté » valait pour
le PCA9685 mais pas pour LEDC. Arduino-ESP32 3.x renvoie un `bool` sur
`ledcWrite()` et `ledcDetach()` ; les deux sont maintenant contrôlés, dans
`writeMicros()` comme dans `writeOff()`, et remontent `OutputFault`.

Là encore le stub était complice : `hostcheck/stubs/Arduino.h` déclarait ces
fonctions `void`, donc la compile-check *ne pouvait pas* voir le retour ignoré.
Signatures corrigées — même classe de défaut que le `setPWM()` `void` du passage
précédent, et la leçon est la même : **un stub qui ment sur une signature rend un
défaut invisible à la CI**.

### 8.4 — Le harnais HIL parle enfin l'API réelle (P2)

Trois défauts, tous confirmés dans le code :

1. **Mauvais en-tête d'authentification.** Le harnais envoyait `X-Admin-Token`,
   le firmware lit `X-GMB-Token` (`WebApi::authOk`) — `--token` n'authentifiait
   donc rien et chaque écriture revenait en 401.
2. **Sémantique du 202 ignorée.** `/api/reset`, `/api/test/note` et
   `PUT /api/profile` répondent **202 + `commandId`** ; la décision est prise plus
   tard, sur la boucle. Le harnais assertait `status == 200` (jamais vrai) et,
   pire, `status != 200` pour « prouver » qu'une note était refusée pendant
   l'E-stop — ce qui passe sur **tout** 202, quoi que fasse ensuite l'appareil.
   Chaque commande est maintenant suivie jusqu'à son état terminal
   (`succeeded` / `refused` / `failed` / `cancelled`).
3. **Timeout compté comme succès.** `outcome in ("succeeded", "timeout")` est
   devenu `outcome == "succeeded"` : un timeout est précisément ce qu'une session
   de banc doit faire remonter.

`urlopen` lève sur 4xx/5xx : les codes 401/409/422/503 sont maintenant récupérés
et raisonnés, au lieu de faire exploser le scénario.

### 8.5 — Un harnais non exécuté n'est pas un harnais : mock REST en CI

Le job CI ne vérifiait que la syntaxe Python et la table des scénarios — donc
aucune des trois erreurs ci-dessus. Ajouté :

* `firmware/test/hil/mock_device.py` — reproduit la **sémantique** de
  `WebApi.cpp` : contrat 202 + `commandId`, `X-GMB-Token`, 200 sur `/api/panic`,
  refus au niveau commande et non HTTP, 409 sur `/api/test/servo` non armé. Trois
  modes `--misbehave` (`never-stops`, `slow-command`, `wrong-token`).
* `firmware/test/hil/selfcheck.py` — exécute le **vrai** harnais contre ce mock et
  vérifie les deux moitiés du contrat : il passe sur un appareil correct **et il
  échoue, sur la bonne vérification, sur un appareil qui triche**.

Validé en réintroduisant les défauts d'origine : avec `X-Admin-Token` la session
authentifiée échoue sur 12 vérifications ; avec l'ancien `status != 200` le
harnais **cesse de détecter** un appareil qui continue de jouer après un panic.

Le job CI exécute maintenant `selfcheck.py` (~43 s). `--wait-scale` réduit les
budgets d'attente pour ce seul usage ; **à laisser à 1.0 sur matériel**.

### 8.6 — Ce qui reste

La campagne matérielle elle-même. Les corrections 8.1–8.3 touchent du code
`#if defined(ARDUINO)` : leur *contrat* est testé à l'hôte (hook d'injection,
stubs corrigés, `servobankcheck`), leur *effet électrique* ne l'est pas. Les trois
scénarios qui ferment réellement ce passage sont `oe` (le `/OE` au scope, canaux
silencieux avant la descente), `pca_loss` et `estop`.

Inchangés et hors périmètre : DIN physique (UART non raccordé), USB-MIDI
(squelette TinyUSB), BLE.
