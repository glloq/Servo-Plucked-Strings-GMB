# Configuration des broches — Servo-Plucked-Strings-GMB (servo-par-frette)

> Cette version n'utilise **aucune broche de moteur pas-à-pas** (pas de STEP / DIR /
> HOME / LIMIT / ENABLE driver). Les servos sont pilotés par **PCA9685 (I2C)** et/ou
> par **GPIO direct**. Voir [`CALIBRATION.md`](CALIBRATION.md) et
> [`SAFETY.md`](SAFETY.md).

---

## Broches au niveau carte

Seules trois broches « système » sont nécessaires quand au moins un servo passe par
un PCA9685 :

| Signal | Rôle | Recommandé (ESP32-S3-DevKitC-1) |
|--------|------|---------------------------------|
| `SDA` | Bus I2C des PCA9685 | GPIO 40 |
| `SCL` | Bus I2C des PCA9685 | GPIO 41 |
| `SERVO_OE` | /OE des PCA9685 (sécurité, actif bas) | GPIO 47 |

Une broche `ESTOP` (entrée, active bas, `INPUT_PULLUP`) est lue si elle est présente
dans le profil (arrêt d'urgence matériel).

## Servos

Chaque servo (`ServoConfig`) choisit sa source indépendamment :

- **PCA9685** — `pcaBoard` 0..7 (adresses **0x40–0x47**, soit jusqu'à **8 cartes /
  128 canaux**) et `channel` 0..15. Idéal quand le nombre de servos dépasse les
  sorties PWM libres.
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
