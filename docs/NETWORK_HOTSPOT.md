# Hotspot & portail captif

> Comment atteindre la page de configuration quel que soit l'état du Wi-Fi, sans
> jamais rester « verrouillé dehors » : **portail captif** (la page s'ouvre toute
> seule quand on rejoint le Wi-Fi de l'ESP32) et **hotspot au bouton BOOT** (repli
> matériel). Inspiré de [Servo-Flute-GMB](https://github.com/glloq/Servo-Flute-GMB).
>
> Liés : [`WEB_INTERFACE.md`](WEB_INTERFACE.md) ·
> [`SAFETY.md`](SAFETY.md) · [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md).

---

## 1. Deux façons d'atteindre la config

| Mode | Comment | Adresse |
|------|---------|---------|
| **Client (station)** | l'ESP32 rejoint votre box Wi-Fi | `http://<hostname>.local` (mDNS) ou l'IP attribuée |
| **Point d'accès (hotspot)** | l'ESP32 crée son propre Wi-Fi | rejoindre le réseau → **la page s'ouvre seule** (portail captif), sinon `http://192.168.4.1/` |

Le hotspot est le mode de **première configuration** et le **repli** si la station échoue (3 tentatives) — voir `Net.cpp`.

## 2. Portail captif (ouverture automatique de la page)

Quand le point d'accès est actif, rejoindre le Wi-Fi de l'instrument **ouvre
directement** la page de config, comme un portail Wi-Fi d'hôtel. Trois pièces
coopèrent :

1. **DNS wildcard** (`DNSServer` sur le port 53) : *toute* requête DNS résout vers
   l'IP de l'AP (`192.168.4.1`). Démarré à la montée de l'AP
   (`Net::startCaptivePortal`) et pompé à chaque tick (`Net::tick` →
   `dns_.processNextRequest()`), **uniquement en mode AP**.
2. **Redirections des sondes OS** : les URL que téléphones/PC testent pour détecter
   un accès Internet (`/generate_204`, `/gen_204`, `/hotspot-detect.html`,
   `/library/test/success.html`, `/connecttest.txt`, `/ncsi.txt`, `/redirect`,
   `/canonical.html`) renvoient une **redirection 302** vers `http://192.168.4.1/`
   au lieu du 204/succès attendu → l'OS affiche « se connecter au réseau » et ouvre
   la page (`WebApi::begin`).
3. **`onNotFound`** : en mode AP, toute autre URL est aussi redirigée vers le portail
   (attrape les sondes non listées) ; en mode station, un 404 normal.

En mode station, l'ESP32 n'est ni passerelle ni DNS : ces routes ne sont donc jamais
sollicitées et l'accès Internet du client reste normal.

## 3. Hotspot au bouton BOOT (repli matériel)

Si la config station est fausse (mauvais SSID / mot de passe), on pourrait se
retrouver sans aucun accès. Le **bouton BOOT** évite ça :

```
Maintenir BOOT (GPIO0) ~2 s  →  bascule immédiate en point d'accès + portail captif
```

- **Broche** : `GPIO0` (le bouton BOOT universel des cartes de dev ESP32),
  `INPUT_PULLUP`, actif à l'état bas.
- **Durée** : maintien ~2 s (`kBootHoldMs`) pour éviter les déclenchements
  accidentels.
- **Effet** : `Net::forceAccessPoint()` — coupe la station, monte l'AP et le portail
  **à chaud, sans redémarrer**. L'AP forcé **ne retente pas** la station (jusqu'au
  prochain reboot).
- Câblage : voir [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md). `GPIO0` est une
  broche *strapping* — ne pas la maintenir **au démarrage** (cela entre en mode
  flash) ; l'appui se fait **après** le démarrage.

## 4. Depuis l'interface web

Le **modal de réglages** (bouton ⚙ de la barre du haut) → section *Hotspot* →
**« Start hotspot now »** appelle `POST /api/hotspot`, équivalent logiciel du bouton
BOOT (utile pour basculer en AP avant de changer les réglages réseau, sans risque de
se verrouiller). La station étant coupée, le client web est déconnecté : on rejoint
alors le réseau de l'instrument (la page se rouvre via le portail captif).

## 5. SSID / IP / sécurité

- **SSID de l'AP** : `network.apSsid` du profil (défaut `Servo-Plucked-Strings-GMB`).
- **IP de l'AP** : `192.168.4.1` (adresse softAP par défaut de l'ESP32 ; aucune
  `softAPConfig` n'est posée). Si vous changez ce sous-réseau, mettez à jour les
  redirections du portail.
- **Mot de passe AP** : réglable dans le modal (write-only). Sans mot de passe (ou
  < 8 caractères), l'AP est **ouvert** — pratique pour la première config, mais
  pensez à définir un mot de passe WPA2 pour un usage durable (voir
  [`SAFETY.md`](SAFETY.md)).

## 6. Où c'est dans le code

| Élément | Fichier |
|---------|---------|
| DNS captif (start/stop/pompe) + `forceAccessPoint` | `firmware/src/platform/esp32/Net.{h,cpp}` |
| Redirections des sondes + `onNotFound` + `POST /api/hotspot` | `firmware/src/platform/esp32/WebApi.cpp` |
| Bouton BOOT (GPIO0) + service hotspot | `firmware/src/main.cpp` (`serviceHotspotRequests`) |
| Bouton « Start hotspot » + modal | `web-interface/js/settings.js`, `web-interface/js/api.js` |
