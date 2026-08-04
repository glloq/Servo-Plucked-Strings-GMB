# Sécurité — Servo-Plucked-Strings-GMB (servo-par-frette)

> Cette version n'a **ni moteur pas-à-pas ni homing** : pas de phase de recherche
> d'origine, pas de fin de course. La sécurité porte sur l'arrêt d'urgence,
> la neutralisation des servos, et la maîtrise du courant. Voir aussi
> [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) et [`CALIBRATION.md`](CALIBRATION.md).

---

## 1. Séquence de démarrage

```
power-on safe  →  valider le profil  →  parquer tous les doigts au repos  →  armé
```

Aucun homing. Au boot, tous les servos sont mis au repos (doigts levés) via le /OE et
`neutraliseAll()`, puis l'instrument est armé si le profil est valide et que tous les
canaux servo/PCA répondent. Un profil invalide ou un PCA absent laisse le système en
état **Boot** (non armé), sans rien piloter.

## 2. Arrêt d'urgence & panique

- **E-stop matériel** (broche `ESTOP`, actif bas) : neutralise tout immédiatement et
  verrouille l'état `EmergencyStop`. Il est testé en tête de boucle, sur le niveau
  brut, avant toute commande.
- **Panique logicielle** : `POST /api/panic`, ou les messages MIDI CC120 / CC123
  (all sound / all notes off), relâchent les notes, coupent les servos et repassent en
  Boot. Il faut ensuite un **reset** explicite (`POST /api/reset`) pour ré-armer.
- **Perte du Wi-Fi** : les commandes en attente sont annulées et les notes relâchées
  (l'instrument reste armé).

> ⚠️ L'E-stop **logiciel** est une commodité, **pas** un substitut à une coupure
> **matérielle** de l'alimentation des servos. Câblez le `/OE` des PCA9685 (et/ou
> l'alimentation 5–6 V) sur un vrai bouton d'arrêt avant de mettre l'instrument sous
> tension avec les cordes montées.

## 3. Neutralisation des servos

- Le `/OE` des PCA9685 (actif bas) coupe **toutes** les sorties PCA d'un coup.
- Les servos sur GPIO direct sont détachés (PWM coupé) à l'arrêt.
- Santé I2C : si un PCA cesse de répondre après l'armement (débranché, brown-out), le
  firmware déclenche une panique plutôt que de « jouer à l'aveugle ».
- Une écriture servo qui échoue met la corde concernée en faute (retirée de
  l'allocation) sans perturber les autres.

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
