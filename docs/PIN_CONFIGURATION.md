# Configuration des broches — Servo-Plucked-Strings-GMB (servo-par-frette)

> Cette version n'utilise **aucune broche de moteur pas-à-pas** (pas de STEP / DIR /
> HOME / LIMIT / ENABLE driver). Les servos sont pilotés par **PCA9685 (I2C)** et/ou
> par **GPIO direct**. Voir [`CALIBRATION.md`](CALIBRATION.md) et
> [`SAFETY.md`](SAFETY.md).

---

## Broches au niveau carte

Seules trois broches « système » sont nécessaires quand au moins un servo passe par
un PCA9685, plus l'entrée d'arrêt d'urgence optionnelle :

| Signal | Rôle | Recommandé (ESP32-S3-DevKitC-1) |
|--------|------|---------------------------------|
| `SDA` / `SCL` | Bus I2C 0 des PCA9685 | GPIO 40 / 41 |
| `SDA2` / `SCL2` | Bus I2C 1 (optionnel) | GPIO 38 / 39 (**v1.0**) · GPIO 39 / 42 (**v1.1**, LED sur 38) |
| `SERVO_OE` (+ `SERVO_OE2`) | /OE des PCA9685 (sécurité, actif bas) | GPIO 47 (GPIO 21 pour OE2) |
| `ESTOP` | Entrée arrêt d'urgence matériel (`SafetyInput`) | GPIO 2 |

`ESTOP` est une **entrée de sécurité** (`SignalKind::SafetyInput`) : broche
lisible, avec interruption, jamais une broche de strapping. Elle est lue en
`INPUT_PULLUP` si elle est présente dans le profil, se déclare dans l'interface
(*Wiring & GPIO → Emergency stop input*) et supporte deux câblages
(`board.estopNormallyClosed`) : boucle **NC recommandée** (boucle fermée =
marche ; appui, fil coupé ou connecteur débranché = STOP, fail-safe) ou bouton
NO hérité (actif bas). Circuit de référence :
[`../hardware/POWER_AND_SAFETY.md`](../hardware/POWER_AND_SAFETY.md).

> Deux révisions de DevKitC-1 existent : la **v1.0** a sa LED RGB sur GPIO48,
> la **v1.1** sur GPIO38 — chaque révision a son profil de carte
> (`esp32-s3-devkitc-1`, `esp32-s3-devkitc-1-v1.1`) et les broches recommandées
> du second bus suivent.

## Servos

Chaque servo (`ServoConfig`) choisit sa source indépendamment :

- **PCA9685** — `pcaBoard` 0..7 (adresses **0x40–0x47** *par bus I2C*) +
  `i2cBus` 0..1 + `channel` 0..15 — une carte physique est identifiée par
  **(bus, adresse)**, soit jusqu'à **16 cartes / 256 canaux** sur les deux bus
  (table de capacité : [`../hardware/README.md`](../hardware/README.md)). Idéal
  quand le nombre de servos dépasse les sorties PWM libres.
- **GPIO direct** — le servo est piloté par une broche libre de l'ESP32-S3
  (LEDC 50 Hz, 14 bits). Jusqu'à **8 servos directs** (8 canaux LEDC).

Les deux modes se mélangent sur le même instrument. Le validateur refuse : une paire
`(pcaBoard, channel)` utilisée deux fois, un GPIO direct réservé ou en conflit, un
rôle par-corde pointant une corde inexistante, une frette dupliquée
`(stringIndex, fret)`, ou plus de 8 servos directs.

### Convention « 1 PCA par corde »

Les doigts de frettes d'une corde + son grattage tiennent sur ≤ 16 canaux, donc sur
**une seule carte PCA9685** (`pcaBoard = index de corde`). Cela répartit l'appel de
courant sur plusieurs cartes et simplifie le câblage. Le mapping reste néanmoins
libre : on peut placer n'importe quel servo sur n'importe quel `(pcaBoard, channel)`
ou GPIO.

## Assignation automatique

`PinManager::autoAssign` ne place que `SDA`, `SCL` et `SERVO_OE`. Les broches des
servos directs vivent dans les entrées `servos[]` (pas dans `pins[]`) et sont validées
contre la capacité `Generic` de la carte.

## Alimentation

Les servos sont alimentés séparément en **5–6 V** (courant suffisant pour le nombre
de servos simultanés). Le /OE des PCA permet de neutraliser instantanément toutes les
sorties (voir [`SAFETY.md`](SAFETY.md)).
