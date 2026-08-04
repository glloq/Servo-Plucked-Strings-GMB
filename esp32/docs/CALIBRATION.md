# Calibration — Servo-Plucked-Strings-GMB (servo-par-frette)

> Cette version ESP32 n'a **ni moteur pas-à-pas ni homing** : chaque position de
> frette possède son propre servo-doigt. La calibration consiste donc à régler,
> pour chaque doigt, sa **position de contact** et son **sens de rotation**, puis
> le geste de **grattage**. Tout se fait depuis l'interface web (onglet *Setup
> Wizard*), y compris un **assistant d'installation** guidé.
>
> Documents liés : [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) ·
> [`SAFETY.md`](SAFETY.md) · [`WEB_INTERFACE.md`](WEB_INTERFACE.md) ·
> [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md).

---

## 1. Modèle servo-par-frette

Chaque corde est décrite par :

- `openNote` — note MIDI de la corde à vide (frette 0) ;
- `maxFret` — plus haute frette atteignable.

Les frettes réellement jouables ne sont **pas** un intervalle continu : ce sont
exactement les frettes qui portent un **servo-doigt** (`function="finger"`, avec un
`stringIndex` et un numéro de `fret`). La frette 0 (corde à vide) ne porte jamais de
servo. On peut donc équiper des frettes **non consécutives** (ex. 1, 3, 5, 12) ; une
frette non équipée est signalée comme « non disponible » et n'est jamais choisie par
l'allocation automatique (une sélection CC explicite bascule alors en repli
automatique).

## 2. Paramètres d'un servo (`ServoConfig`)

| Champ | Rôle |
|-------|------|
| `function` | `finger` / `pluck` / `strum` / `strumLift` / `damper` |
| `stringIndex` | corde propriétaire |
| `fret` | (doigt) numéro de frette pressée (1..24) |
| `source` | `pca` (PCA9685) **ou** `gpio` (GPIO direct ESP32) |
| `pcaBoard` / `channel` | carte 0..7 (0x40–0x47) et canal 0..15 |
| `gpio` | broche ESP32 (source GPIO) |
| `restUs` / `activeUs` | **position de repos / de contact** (µs) |
| `inverted` | **sens de rotation** (miroir dans la fenêtre d'impulsion) |
| `pulseMinUs` / `pulseMaxUs` | fenêtre mécanique du servo |
| `travelMs` / `settleMs` | temps de course / stabilisation |
| `disableAtRest` | coupe le PWM au repos (réduit le courant) |

Pour le grattage (`pluck`/`strum`), des champs supplémentaires façonnent le geste :
`alternateDirection`, `activeAltUs`, `strokeMs`, `minStrikeUs`, et pour un
`strumLift` : `engageDelayMs`. La vélocité MIDI module la profondeur d'attaque entre
`restUs` et `activeUs`.

> L'interface web présente les positions en **degrés** (0–180°) et les convertit en
> µs via `pulseMinUs`/`pulseMaxUs` ; le firmware, lui, travaille en microsecondes.

## 3. Calibration d'un doigt de frette (réglage manuel)

Pour chaque frette équipée :

1. **Repos** : régler `restUs` pour que le doigt soit franchement décollé de la corde
   (bouton *Test rest*).
2. **Contact** : régler `activeUs` pour que le doigt plaque nettement la corde sur la
   frette, sans forcer (bouton *Test contact*). C'est la **position de contact
   corde/frette**.
3. **Sens** : si le servo est monté à l'envers, cocher `inverted`.
4. **Vérifier la note** : jouer la note (`openNote + fret`) et écouter la justesse.
5. **Sauvegarder**.

## 4. Assistant d'installation (aide au réglage)

L'onglet *Setup Wizard → Install helper* enchaîne automatiquement ces étapes,
**frette par frette**, pour une corde choisie :

```
choisir la corde
        ↓
frette N : presser le doigt  →  ajuster l'angle de contact (curseur, test live)
        ↓                        tester la note
        ↓
sauvegarder → frette N+1 …
```

Il s'appuie sur `POST /api/test/servo` (presser/relâcher un servo précis) et
`POST /api/test/note` (jouer une note) — l'instrument doit être **armé**
(bouton *Reset & re-arm* du tableau de bord) pour que les tests pilotent le matériel.

## 5. Calibration du grattage (`pluck` / `strum`)

- `restUs` : plectre écarté de la corde ; `activeUs` : profondeur d'attaque max.
- `minStrikeUs` : profondeur minimale garantie (une note douce accroche quand même).
- `alternateDirection` (+ `activeAltUs`) : alterne aller/retour à chaque frappe.
- `strokeMs` : durée d'engagement du geste (indépendante de `travelMs`).
- Corde à vide : aucun doigt pressé, grattage direct.

## 6. Latence & anticipation (global, `MidiConfig`)

- `noteExecutionDelayMs` : délai fixe réception → son (latence constante).
- `strumLeadMs` : abaisse le `strumLift` en avance pour que le plectre soit engagé au
  moment de la frappe.

## 7. Gestion du courant (voir aussi [`SAFETY.md`](SAFETY.md))

- `disableAtRest` (par servo) : les doigts au repos ne consomment ~rien.
- Un seul doigt actif par corde (relâche avant appui).
- `power.maxConcurrentMoves` / `power.staggerMs` : étalent les démarrages de servos
  sur un accord pour ne pas cumuler les pics d'appel de courant.
- Convention : **1 PCA9685 par corde** pour répartir la charge sur plusieurs cartes.
