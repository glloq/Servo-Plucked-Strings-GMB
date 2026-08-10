# Doigts à engrenage (servo-doigt double / *geared fingers*)

> **Étude + mode d'emploi** d'un mécanisme qui **divise par deux** le nombre de
> servos-doigts sur le bas du manche : **un seul servo** entraîne **deux doigts
> antagonistes** par un engrenage (ou un balancier), donc **un servo couvre deux
> frettes**. Les frettes trop étroites (haut du manche) gardent le mécanisme simple
> **un servo par frette** — les deux types se **mélangent librement**, y compris sur
> la même corde.
>
> Documents liés : [`CALIBRATION.md`](CALIBRATION.md) ·
> [`../mechanics/README.md`](../mechanics/README.md) ·
> [`WEB_INTERFACE.md`](WEB_INTERFACE.md) · [`SAFETY.md`](SAFETY.md).

---

## 1. Le problème

Dans la version servo-par-frette, chaque frette équipée porte **son** servo-doigt
(`function="finger"`, avec `restUs` = doigt levé, `activeUs` = doigt pressé). Une
corde de 12 frettes = 12 servos-doigts. Sur 6 cordes cela fait beaucoup de servos,
de canaux PCA9685 et de courant.

## 2. L'idée : un servo, deux doigts antagonistes

On monte un **engrenage** (pignon + crémaillères, ou un balancier/rocker) sur l'axe
du servo. En tournant dans un sens, le servo **descend le doigt A** pendant que le
**doigt B remonte** ; dans l'autre sens, **B descend et A remonte**. Une position
**centrale = neutre** relève **les deux** doigts.

```text
                 ┌───────── un servo à engrenage ─────────┐
   doigt A (frette N)                              doigt B (frette N+1)
        │                                                   │
        ▼                                                   ▼
     ╲  corde ══════════════════════════════════════════════  corde  ╱
       ╲                        ┌───┐                        ╱
        ╲──────── crémaillère ──┤ ⚙ ├── crémaillère ────────╱
                                └───┘
                              pignon = axe du servo

   3 positions calibrées du servo :
     • NEUTRE   (restUs)    : A levé   + B levé     ← repos / corde à vide
     • PRESS A  (activeUs)  : A pressé + B levé     ← on joue la frette N
     • PRESS B  (activeBUs) : A levé   + B pressé   ← on joue la frette N+1
```

Un seul actionneur remplace donc deux servos-doigts.

## 3. Pourquoi c'est « gratuit » côté logique

**Sur une corde, on ne presse jamais qu'une seule frette à la fois** (on frette une
note par corde). Le firmware garantit déjà cet invariant : *un seul doigt actif par
corde*, avec **relâche-avant-appui** (`releaseCurrentFinger` → `press`).

Donc **appairer deux frettes d'une même corde** sur un servo antagoniste
**n'introduit aucun nouveau conflit** : les deux doigts couplés ne sont, de toute
façon, jamais demandés en même temps. Passer de la frette A à la frette B du même
servo, c'est simplement : **relâcher vers le neutre** (les deux doigts remontent)
puis **presser le côté B** — exactement la séquence relâche→appui existante, en un
seul servo au lieu de deux.

> ⚠️ **Contrainte** : les deux frettes d'un servo à engrenage doivent être **sur la
> même corde**. Appairer des frettes de deux cordes différentes casserait
> l'invariant (deux cordes peuvent sonner ensemble dans un accord). Le validateur
> l'impose (les deux frettes viennent forcément du même `ServoConfig`, donc du même
> `stringIndex`).

## 4. Quelles frettes appairer ? (et lesquelles laisser simples)

L'écartement des frettes est **large en bas du manche** (près du sillet) et se
**resserre vers le corps**. L'engrenage + deux doigts a besoin de place :

- **Bas du manche (frettes larges)** → **engrenage** : appairer des frettes
  **adjacentes** (1–2, 3–4, 5–6…), le servo se logeant entre les deux doigts.
- **Haut du manche (frettes étroites)** → **doigt simple** : garder un servo par
  frette (`fretB = -1`), là où deux doigts + un pignon ne rentrent pas.

Le mélange est libre **par servo** : rien n'oblige à tout gérer pareil.

### Économie

| Manche | Sans engrenage | Avec engrenage bas (paires 1‑2, 3‑4, 5‑6) |
|--------|---------------:|------------------------------------------:|
| 12 frettes / corde | 12 servos | 3 (engrenage) + 6 (simples 7‑12) = **9** |
| Ukulélé 4 cordes (voir le profil d'exemple) | 52 servos | **40 servos** (−12) |

Voir le profil prêt à l'emploi
[`../instrument-profiles/ukulele-gcea-geared.json`](../instrument-profiles/ukulele-gcea-geared.json).

## 5. Modèle de configuration (`ServoConfig`)

Deux champs, **rétrocompatibles** (absents ⇒ doigt simple, comportement inchangé) :

| Champ | Rôle |
|-------|------|
| `fret` | frette pressée **côté A** (à `activeUs`) — comme avant |
| `fretB` | frette pressée **côté B** (à `activeBUs`) ; **-1 = doigt simple** |
| `restUs` | position **NEUTRE** : les **deux** doigts levés (repos / corde à vide) |
| `activeUs` | impulsion qui presse **le côté A** (`fret`) |
| `activeBUs` | impulsion qui presse **le côté B** (`fretB`) — utilisé si `fretB ≥ 1` |
| `inverted` | miroir dans la fenêtre d'impulsion (s'applique aux 3 positions) |

Toutes les autres colonnes (`pulseMinUs/MaxUs`, `travelMs`, `settleMs`,
`disableAtRest`, `source`/`pcaBoard`/`channel`/`gpio`) sont inchangées.

Exemple JSON d'un doigt à engrenage frettes 1 & 2, neutre centré à 1500 µs :

```json
{
  "function": "finger", "stringIndex": 0,
  "fret": 1, "fretB": 2,
  "restUs": 1500, "activeUs": 1900, "activeBUs": 1100,
  "pulseMinUs": 500, "pulseMaxUs": 2500,
  "source": "pca", "pcaBoard": 0, "channel": 0
}
```

## 6. Calibration (trois positions)

Un doigt à engrenage se règle en **trois** points au lieu de deux :

1. **Neutre** (`restUs`) : régler pour que **les deux** doigts soient franchement
   décollés de la corde.
2. **Press A** (`activeUs`) : le doigt A plaque nettement la frette `fret`.
3. **Press B** (`activeBUs`) : le doigt B plaque nettement la frette `fretB`.

Depuis l'interface web (**Setup Wizard**) :

- **Étape Frets** : sur la ligne de la frette côté A, cocher **« gear »** ; ouvrir
  **Calibrate** pour choisir la **2e frette** et régler **Press A / Press B /
  Neutral** en degrés. La frette côté B affiche « *side B of the geared servo on
  fret N* » (une seule surface d'édition, pas de doublon).
- **Calibration inline (étape Frets)** : pour une frette portée par un servo à
  engrenage, les curseurs règlent les trois positions (Press A / Press B /
  Neutral), avec les boutons **Neutral / Press A / Press B** qui pilotent le servo à
  l'**angle exact du brouillon** (aperçu live), plus **Play A / Play B**.

> L'aperçu live utilise l'extension `POST /api/test/servo` avec un champ optionnel
> `us` : quand il est présent, le firmware amène le servo à **cette impulsion exacte**
> et l'y maintient — indispensable pour voir le côté B (que `active:true/false` ne
> pouvait pas atteindre).

## 7. Comportement au jeu (rappel firmware)

- `fingerIndexForFret(corde, frette)` renvoie le servo dont **le côté A OU le côté
  B** frette cette position.
- `pressFret(index, frette)` appuie du **bon côté** : `activeUs` pour le côté A,
  `activeBUs` pour le côté B (identique à `press()` pour un doigt simple).
- `release()` ramène au **neutre** (`restUs`) : les deux doigts remontent — c'est la
  position « ne touche pas la corde » universelle (repos, corde à vide, ou frette
  gérée par un autre servo).
- **Balayage direct A↔B.** Quand la nouvelle frette est portée par **le même servo**
  que la frette actuellement pressée (l'autre côté d'un servo à engrenage, ou un
  re-jeu de la **même** frette), le firmware **ne relâche pas vers le neutre** : il
  balaie le doigt **directement** vers le nouveau côté, en le gardant **sous
  tension** (pas de neutre « mou », mouvement continu). L'attente est **proportionnelle
  à la distance réelle** d'impulsion (`sweepMsToFret` / `fingerSweepMs`), donc jamais
  d'appui incomplet.
  - **Re-jeu de la même frette** (note tenue redéclenchée) : distance nulle → le doigt
    **ne se lève plus** et on économise ~2×`travelMs` (gain net).
  - **A↔B** : comme le neutre est **sur le trajet** A→B (impulsion centrée), la durée
    *modélisée* reste ~identique à un passage par le neutre ; le gain est la
    **continuité** (pas d'arrêt au neutre, doigt toujours tenu), plus fluide et fiable.
  - Une nouvelle note **corde à vide** (frette 0) n'est jamais un balayage : on relâche
    bien vers le neutre pour lever les deux doigts.

## 8. Points d'attention mécaniques / courant

- **Stabilité du neutre.** Au neutre, si `disableAtRest` coupe le PWM, le servo n'est
  plus tenu. Concevoir le neutre comme une position **mécaniquement stable**
  (balancier équilibré, cran/détente, ressorts symétriques). Sinon, mettre
  `disableAtRest = false` pour **ce** servo (il tient le neutre sous couple).
- **Courant.** Un servo à engrenage ne tient qu'**un** appui à la fois (jamais deux
  couples de calage), et fait le travail de deux servos : le pic de courant global
  baisse. Le `ServoActivationGovernor` et l'étalement des démarrages restent
  valables tels quels.
- **Jeu (backlash).** L'engrenage ajoute du jeu : la calibration `activeUs`/`activeBUs`
  l'absorbe (on règle l'angle réel où chaque doigt plaque).

## 9. Règles de validation (imposées par `ProfileValidator`)

Pour un doigt à engrenage (`fretB ≥ 0`) :

- `fret` **et** `fretB` doivent être des frettes réelles (1..`kMaxFret`), **distinctes** ;
- chaque frette doit rester **unique** parmi tous les doigts (aucune frette réclamée
  deux fois, que ce soit via `fret` ou `fretB`) ;
- `activeBUs` doit être **dans la fenêtre** `pulseMinUs..pulseMaxUs` ;
- (implicite) les deux frettes sont sur la même corde, puisqu'elles partagent le
  `ServoConfig`.

## 10. Limites & évolutions possibles

- Le **balayage direct A↔B** (§7) supprime l'arrêt au neutre et le doigt reste tenu,
  mais comme le neutre est sur le trajet, la latence *modélisée* d'un A↔B reste
  proche de celle d'un passage par le neutre : le gain concret de temps est surtout
  sur le **re-jeu de la même frette** (doigt déjà en place). Le reste est de la
  fluidité/fiabilité (mouvement continu, jamais de neutre non tenu).
- Un servo à engrenage ne peut pas presser **ses deux** frettes en même temps — ce
  qui est sans effet, une corde ne frettant qu'une note à la fois.
- Pas adapté aux frettes trop étroites : y garder le doigt simple.
- Extension envisageable : engrenages à **plus de deux** doigts (multi-cames) — non
  couvert ici.
- **Re-frappe plus rapide que le déplacement.** Le temps de balayage est estimé
  depuis la **dernière impulsion commandée** (`lastUs`), pas la position physique
  réelle du doigt. Si une nouvelle note re-fretté le **même** servo à engrenage en
  **moins de `travelMs`** (avant l'arrivée du doigt), l'estimation peut être trop
  courte et le grattage partir un peu tôt (note brièvement étouffée). En pratique
  masqué par l'étouffoir + `settleMs`, et le servo ne peut de toute façon pas suivre
  une trille plus rapide que sa course. Sans conséquence hors de ce cas limite.

## 11. Où c'est dans le code

| Élément | Fichier |
|---------|---------|
| Champs `fretB` / `activeBUs` | `firmware/src/core/configuration/Profile.h` |
| Résolution pure du côté + temps de balayage (`fingerSweepMs`, testés natif) | `firmware/src/core/configuration/FingerTarget.h` |
| Masque des frettes jouables (les deux côtés) | `firmware/src/core/configuration/Profile.cpp` |
| Mapping frette→servo + `pressFret` + `sweepMsToFret` | `firmware/src/platform/esp32/ServoBank.{h,cpp}` |
| Séquence de jeu (appui du bon côté, balayage direct A↔B) | `firmware/src/main.cpp` (`tickString`) |
| Règles de validation | `firmware/src/core/configuration/ProfileValidator.cpp` |
| Round-trip JSON | `firmware/src/platform/esp32/ProfileStorage.cpp` |
| Interface web (config + calibration) | `web-interface/js/wizard.js`, `web-interface/js/api.js` |
| Tests natifs | `firmware/test/test_geared.cpp` |
| Profil d'exemple | `instrument-profiles/ukulele-gcea-geared.json` |
