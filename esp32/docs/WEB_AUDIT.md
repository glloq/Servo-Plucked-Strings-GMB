# Audit — interface web de réglages & calibration

> Revue de l'interface web (`web-interface/`) et du firmware web/réseau
> (`firmware/src/platform/esp32/`) côté **réglages** et **calibration**, avec les
> corrections apportées dans le même lot. Statuts : ✅ corrigé · 🟡 partiel /
> optionnel · ℹ️ noté (hors lot).

Liés : [`WEB_INTERFACE.md`](WEB_INTERFACE.md) · [`CALIBRATION.md`](CALIBRATION.md) ·
[`GEARED_FINGERS.md`](GEARED_FINGERS.md) · [`NETWORK_HOTSPOT.md`](NETWORK_HOTSPOT.md).

---

## 1. Réglages (network / Wi-Fi / profil)

| # | Constat | Sévérité | Statut |
|---|---------|----------|--------|
| A1 | **Réglages éparpillés, pas de point unique.** Le réseau (mode / AP SSID / SSID station / hostname) est dans le *Setup Wizard* (étape 2), les mots de passe Wi-Fi sur la page *Profiles*, le MIDI sur la page *MIDI*, la puissance dans le wizard. Rien pour « ouvrir les réglages » rapidement. | UX | ✅ **Modal de réglages** (bouton ⚙ de la barre du haut) regroupant réseau + Wi-Fi + hotspot, accessible partout. |
| A2 | **Pas de portail captif.** En mode point d'accès, rejoindre le Wi-Fi de l'ESP32 n'ouvre pas la page de config : il faut connaître/saisir l'IP. | Ergonomie majeure | ✅ **DNS captif** (wildcard → IP de l'AP) + redirections des sondes OS → ouverture auto de la page. |
| A3 | **Aucun repli matériel.** Si la config station est fausse (mauvais SSID/mot de passe), on peut se retrouver **verrouillé dehors** sans moyen simple de forcer l'AP. | Robustesse | ✅ **Bouton BOOT (GPIO0)** : un appui long force le hotspot (AP) + portail captif, sans reflasher. |
| A4 | **Libellé Wi-Fi au 1er rendu du dashboard.** `sampleFromProfile()` affiche toujours `network.apSsid` comme SSID, même en mode station (devrait montrer `network.ssid`). Cosmétique (le WebSocket corrige ensuite). | Mineur | ✅ Corrigé (SSID selon le mode). |
| A5 | **Crash du wizard (étape 1) : `p.selector` inexistant.** `applyType` / `setStringCount` écrivaient `p.selector.string.maximum` alors que la clé du profil est `stringFretSelection` → `TypeError`. Choisir un type d'instrument ou changer le nombre de cordes plantait le gestionnaire (servos non reconstruits, UI figée). *Pré-existant*, trouvé en revue adverse. | **Élevé** | ✅ Corrigé (`p.selector` → `p.stringFretSelection`, 6 occurrences) ; vérifié au navigateur. |

## 2. Calibration (assistant d'installation & doigts)

| # | Constat | Sévérité | Statut |
|---|---------|----------|--------|
| B1 | **Le test doigt de l'étape *Servos & frettes* pilote le profil ENREGISTRÉ, pas le brouillon.** `testServoBtn('Test contact', …)` envoyait `{index, active}` sans `us` : le servo allait à l'`activeUs` **actif**, pas à l'angle qu'on vient d'éditer. Impossible de prévisualiser un nouvel angle sans sauver+activer. (L'assistant d'installation avait déjà été corrigé pour envoyer `us`.) | Fonctionnel | ✅ Les tests de doigt envoient l'impulsion **du brouillon** (`us`) → aperçu live correct. |
| B2 | **Champ « 2e frette » (engrenage) peut devenir `null`.** Vider le champ met `sv.fretB = null` (coercition number → null), que `isGeared` lit comme « non engrené » alors qu'`activeBUs` subsiste. Incohérence mineure. | Mineur | ✅ `fretB` coercé en entier (repli -1) ; case décochée si vidé. |
| B3 | **Calibration exige l'instrument armé, sans commande d'armement à proximité.** Les tests sont refusés tant que non armé ; il faut aller au *Dashboard → Reset & re-arm*. L'assistant le dit mais oblige à quitter la page. | UX | ✅ Bouton **« Arm for calibration »** ajouté dans l'assistant d'installation. |
| B4 | **Pas d'aperçu pendant le glissement du curseur.** Le curseur ne pilote le servo qu'au relâché (`change`), pas pendant le glissé (`input`). Acceptable (évite d'inonder le firmware), améliorable avec l'API `us` throttlée. | Mineur | ℹ️ Noté (hors lot). |
| B5 | **Doigt à engrenage : taper `0` dans « 2e frette » créait un état semi-engrené non réparable.** `fretB=0` : `isGeared` (≥1) masquait l'UI engrenage, mais la validation (≥0) signalait « fret must be 1..24 » sans contrôle visible pour corriger. | Faible | ✅ Coercition : `0` et négatifs → `-1` (dé-engrené). |
| B6 | **Dé-cocher « Geared » ne restituait pas le doigt voisin.** Activer l'engrenage supprime le servo de la frette voisine ; le désactiver laissait cette frette sans doigt (injouable). | Faible | ✅ Le dé-engrènement recrée un doigt simple sur l'ancienne frette côté B. |

## 3. Cohérence / code mort

| # | Constat | Statut |
|---|---------|--------|
| C1 | `dashboard.js` : helpers `fmt` / `dot` inutilisés (hérités de la version stepper). | ✅ Retirés. |
| C2 | `WEB_INTERFACE.md` décrivait encore des étapes **stepper** (moteur, homing, jog, capture position) qui ne s'appliquent pas au servo-par-frette. | ✅ Corrigé (réécrit servo-par-frette). |

## 4. Points vérifiés OK

- Sauvegarde atomique du profil (`PUT /api/profile`), remontée des erreurs de validation (422 → toasts).
- Mots de passe Wi-Fi **jamais exportés** (export JSON filtré) et écrits en write-only via `POST /api/wifi`.
- Portes d'accès : les routes d'écriture passent par `authOk` (token admin) ; tests actionneurs refusés si non armé.
- Round-trip JSON des profils (dont doigts à engrenage) couvert par `profilecheck`.

---

## 5. Ce que ce lot ajoute

1. **Portail captif + hotspot bouton BOOT** — voir [`NETWORK_HOTSPOT.md`](NETWORK_HOTSPOT.md).
2. **Modal de réglages** (inspiré de [Servo-Flute-GMB](https://github.com/glloq/Servo-Flute-GMB)) : réseau, Wi-Fi, hostname, et « Démarrer le hotspot ».
3. Corrections A4, B1, B2, C1 et l'armement B3.
