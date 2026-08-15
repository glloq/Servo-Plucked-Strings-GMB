# Sécurité — Servo-Plucked-Strings-GMB (servo-par-frette)

> Cette version n'a **ni moteur pas-à-pas ni homing** : pas de phase de recherche
> d'origine, pas de fin de course. La sécurité porte sur l'arrêt d'urgence,
> la neutralisation des servos, et la maîtrise du courant. Voir aussi
> [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) et [`CALIBRATION.md`](CALIBRATION.md).

---

## 1. Séquence de démarrage

```
power-on safe
 └─ charger le profil de démarrage
     ├─ absent / invalide → CONFIG_SAFE  (voir §1.1)
     └─ valide → Parking → Armed → Ready (voir §1.2)
```

Aucun homing : les servos ont des positions connues.

### 1.1 CONFIG_SAFE — aucun profil valide

Si aucun profil valide ne se charge au démarrage, le firmware **n'invente jamais** un
profil par défaut et **ne l'arme pas** : conduire une vraie machine avec une
configuration qui ne correspond pas à son câblage est dangereux. Il reste en
**CONFIG_SAFE** :

- profil actif **vide** → aucun servo, aucune broche d'actionneur configurée ;
- `/OE` des PCA désactivé, PWM GPIO coupé ;
- **aucun MIDI** ne peut commander les actionneurs (`actuatorsAllowed()` = faux) ;
- réseau + interface web **disponibles** pour construire ou charger un profil.

Le modèle *Ukulele* reste proposé comme **template** dans l'interface, mais n'est
jamais appliqué automatiquement à une machine. On sort de CONFIG_SAFE en chargeant un
profil valide et en l'**activant explicitement**.

### 1.2 Parking / Arming — profil valide

L'armement n'est **pas** instantané : après validation, on passe par une vraie phase
**Parking** avant `Ready` :

```
PowerOnSafe → Parking :
              1. tous les canaux PCA forcés OFF (aucune impulsion mémorisée)
              2. /OE activé sur des sorties muettes (rien ne démarre)
              3. mise au repos PROGRESSIVE sous le governor de courant
                 (maxConcurrentMoves / maxConcurrentPerBoard / staggerMs)
            → attente mécanique (planning étalé + max(travelMs + settleMs))
            → Armed → Ready
```

Le pire cas électrique de l'armement est ainsi le même que celui du jeu normal :
activer `/OE` ne relâche jamais une consigne préchargée sur tous les canaux à la
fois, et les départs vers le repos sont étalés comme des appuis de doigts.

Pendant **Parking**, aucune note MIDI ne peut être jouée et aucun test mécanique ne
peut démarrer (l'état est visible dans le statut web/API : `parking`). Un profil
invalide ou un PCA absent laisse le système non armé, sans rien piloter.

## 2. Arrêt d'urgence & panique

On distingue **strictement** deux opérations (jamais l'une déguisée en l'autre) :

- **`hardStop` — arrêt dur immédiat** (E-stop, panique, faute matérielle majeure) :
  `/OE` PCA coupé et PWM GPIO coupé **tout de suite**, commandes annulées, état
  verrouillé, **sans aucune attente mécanique**. Un vrai E-stop ne dépend jamais de
  l'achèvement d'un mouvement.
  - **E-stop matériel** (broche `ESTOP`, entrée `SafetyInput` déclarée dans
    l'interface, *⚙ → Matériel avancé → GPIO pins → Emergency stop input*) : `hardStop` + état
    `EmergencyStop`, testé en tête de boucle sur le niveau brut, avant toute
    commande. Deux câblages du contact (`board.estopNormallyClosed`) :
    - **NC recommandé** : boucle *normalement fermée* vers GND — la boucle fermée
      autorise la marche ; un appui, un fil coupé ou un connecteur débranché
      lisent STOP (fail-safe) ;
    - **NO hérité** (actif bas) : conservé pour les machines déjà câblées — une
      rupture de fil y désactive silencieusement l'E-stop.
  - **Panique logicielle** : `POST /api/panic` → `hardStop` + état `Panic`. Il faut
    ensuite un **reset** explicite (`POST /api/reset`) pour ré-armer.
- **`controlledPark` — parking contrôlé** (changement de profil, arrêt normal,
  reconfiguration) : on commande les servos au repos, on **attend** `travel + settle`,
  puis on coupe les sorties. C'est un arrêt *propre*, pas un E-stop.

### 2.1 CC120 / CC123 ne sont pas une panique

`CC120` (All Sound Off) et `CC123` (All Notes Off) appliquent la sémantique **MIDI
standard** et **ne verrouillent pas** l'instrument :

- **CC120** coupe immédiatement toutes les notes en cours (ignore le sustain) ;
- **CC123** relâche les notes comme si l'on levait les touches (le sustain est honoré).

Dans les deux cas l'instrument **reste armé (`Ready`)** et rejoue la note suivante
sans reset. Ce ne sont **pas** des équivalents d'un E-stop/panique verrouillé — une
vraie panique reste une commande distincte (`POST /api/panic` ou la broche `ESTOP`).

- **Perte du Wi-Fi** : les commandes en attente sont annulées et les notes relâchées
  (l'instrument reste armé).

> ⚠️ L'E-stop **logiciel** est une commodité, **pas** un substitut à une coupure
> **matérielle**. L'ARU de référence est un **sous-système**
> ([`../hardware/POWER_AND_SAFETY.md`](../hardware/POWER_AND_SAFETY.md)) : bouton
> coup-de-poing **NC à verrouillage** dont un contact fait retomber le
> **contacteur du rail servo 5–6 V** (seule coupure qui protège aussi les servos
> GPIO directs), un contact informe l'entrée `ESTOP`, et — recommandé — un
> contact inhibe l'étage d'activation du `/OE`. Le `/OE` lui-même doit être
> **fail-safe** : pull-up externe vers 3,3 V (le PCA9685 a un pull-down interne :
> un `/OE` flottant = sorties **actives**), et jamais de forçage direct à 3,3 V
> contre le GPIO (contention). Câblez ce circuit avant de mettre l'instrument
> sous tension avec les cordes montées.

## 3. Neutralisation des servos

- `hardStop` : le `/OE` des PCA9685 (actif bas) coupe **toutes** les sorties PCA d'un
  coup ; les servos sur GPIO direct sont détachés (PWM coupé) — sans attente.
- Santé I2C — **dégradation locale** (P1.5) : si un PCA cesse de répondre après
  l'armement (débranché, brown-out), le firmware **identifie la carte** (bus + adresse)
  et met en faute **uniquement les cordes qu'elle pilote**, puis reconstruit les
  capacités (`readyDegraded`) — le MIDI ré-alloue sur les cordes restantes. Le panic
  **global** n'intervient que si plus aucune corde opérationnelle ne reste, ou si la
  carte perdue ne porte aucune corde (ressource commune : on ne peut pas isoler sans
  risque → fail-safe).
- Une écriture servo qui échoue (retour `ActuatorResult` ≠ `Ok`) met la corde concernée
  en faute (retirée de l'allocation, raison journalisée) sans perturber les autres.

## 4. Maîtrise du courant (voir [`CALIBRATION.md`](CALIBRATION.md) §7)

Un servo consomme le plus au démarrage d'un mouvement. Trois mesures bornent le pic :

1. **`disableAtRest`** — un doigt au repos coupe son PWM (~0 A).
2. **Un doigt par corde** — on relâche l'ancien doigt avant de presser le nouveau.
3. **Governor d'étalement** — `power.maxConcurrentMoves` limite le nombre de servos
   qui démarrent ensemble, espacés de `power.staggerMs`, pour qu'un accord ne cumule
   pas les appels de courant. Câbler **1 PCA par corde** répartit encore la charge.

## 5. État et limites

Le firmware **n'a pas été validé sur un instrument physique** : timing des servos,
6 cordes simultanées, endurance MIDI et comportement sous charge restent à valider au
banc. À considérer comme **prêt pour un banc de mise au point**, pas pour un instrument
entièrement corde sous tension sans surveillance.
