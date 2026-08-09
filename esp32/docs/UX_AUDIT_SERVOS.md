# Audit UX — configuration & calibration des servos

> Revue **ergonomique** (distincte de l'audit correctness [`WEB_AUDIT.md`](WEB_AUDIT.md))
> de la partie qui **équipe, câble et calibre les servos-doigts** : l'étape *Servos &
> frettes* et l'*assistant d'installation* du Setup Wizard. Objectif : une interface
> accessible au débutant, pas seulement complète pour l'expert.
>
> Statuts : ✅ fait dans ce lot · 🟡 partiel · ℹ️ à faire (hors lot).

---

## 1. Verdict

- **Fonctionnellement : suffisant.** Tout paramètre est atteignable, la calibration
  fonctionne, l'engrenage 3 positions est géré, les tests pilotent le matériel, les
  modes simplifié/avancé existent. → adapté à un **monteur technique**.
- **« User-friendly au maximum » : pas encore** (état d'avant ce lot). Deux freins :
  1. L'étape **Servos & frettes** était un **formulaire répétitif géant** (une grande
     carte par frette, ~12/corde) exposant le **câblage (Source/PCA/Canal) même en
     mode simplifié** → surcharge, scroll interminable, pénible sur mobile.
  2. La **calibration** avançait **frette par frette à l'aveugle**, sans vue
     d'ensemble de ce qui est fait / reste à faire.

## 2. Déjà bien (conservé)

Assistant d'installation focalisé (curseur en degrés, **aperçu live matériel**,
boutons Neutral / Press A / Press B / Play, *Arm for calibration*, onglets par corde)
· abstraction en **degrés** (0–180°) plutôt qu'en µs · calibration engrenage
cohérente · frettes non contiguës · *Auto-wire* · bascule simplifié/avancé.

## 3. Points d'amélioration (priorisés)

### P0 — fort impact (fait dans ce lot)

| # | Amélioration | Statut |
|---|--------------|--------|
| 1 | **Mode simplifié réellement simple** : masquer Source/PCA/Canal par frette (auto-assignés) ; ne garder que équipée · engrenage · angle · test. Câblage → avancé. | ✅ |
| 2 | **Étape Servos en lignes compactes** : une **ligne** par frette (repliable pour le détail) au lieu d'une grande carte → scroll très réduit, lisible sur téléphone. | ✅ |
| 3 | **Curseur d'angle** (au lieu d'un champ numérique) dans l'étape Servos, avec aperçu live à la relâche. | ✅ |

### P1 — forte valeur (progression : fait ; reste partiel)

| # | Amélioration | Statut |
|---|--------------|--------|
| 4 | **Vue de progression de la calibration** : bandeau de frettes cliquable (équipée / engrenage / vue cette session / frette courante) → navigation directe + coup d'œil. | ✅ |
| 5 | **Actions groupées** : *Copier corde → toutes*, *Régler l'angle pour toutes*, *Ré-assigner les canaux*. | 🟡 *Copier corde → toutes* et *Auto-wire* présents ; réglages d'angle en masse : à faire. |
| 6 | **Clarifier étape 3 (équipement/câblage) vs étape 4 (calibration)** + lien direct « Calibrer » depuis une ligne. | ✅ lien « Calibrate » par ligne + intitulés clarifiés. |
| 7 | **État d'armement visible en permanence** près des tests. | ✅ badge armé/désarmé dans l'assistant. |
| 8 | **Masquer le câblage dans la vue de calibration** (on calibre, on ne câble pas) — en simplifié. | ✅ |

### P2 — finitions (à faire, hors lot)

| # | Amélioration | Statut |
|---|--------------|--------|
| 9 | Aperçu **pendant le glissé** du curseur (throttlé, via l'API `us`). | ℹ️ |
| 10 | **Aide à la justesse** : rappel de la note cible + *trop bas / ok / trop haut* ; ambition accordeur micro. | ℹ️ |
| 11 | **Test de balayage engrenage** (Neutral→A→B automatique). | ℹ️ |
| 12 | **Garde-fous** : angle contact == repos, neutre d'engrenage hors [A,B]. | ℹ️ |
| 13 | **Reset par frette / annuler**. | ℹ️ |

## 4. Recommandation

Garder l'assistant comme pièce maîtresse de la calibration. Ce lot applique les **P0**
(désencombrement + lignes compactes + curseur) et la **vue de progression** (P1‑4),
ce qui fait passer l'interface de « complète mais technique » à « accessible
débutant ». Les P2 (aide à la justesse, balayage engrenage, garde-fous) restent des
différenciateurs pour une prochaine itération.

## 5. Où c'est dans le code

| Élément | Fichier |
|---------|---------|
| Lignes compactes + expander + curseur + simplifié épuré | `web-interface/js/wizard.js` (`fingerRow`, `stepServos`) |
| Vue de progression (bandeau de frettes) + lien Calibrate | `web-interface/js/wizard.js` (`stepInstall`, `fretProgress`) |
| Badge d'armement | `web-interface/js/wizard.js` (`stepInstall`) |
