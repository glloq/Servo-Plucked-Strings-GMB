# Version ESP32 — À venir

> 🚧 **Placeholder** — l'implémentation ESP32 n'est pas encore développée.
> Ce dossier réserve la place de la future version ESP32 du projet, à côté
> de la version [`arduino/`](../arduino/) actuellement fonctionnelle.

## Pourquoi une version ESP32 ?

L'ESP32 apporte des possibilités que la cible Arduino/Teensy actuelle n'a
pas nativement :

- **Sans fil** : Wi-Fi et Bluetooth intégrés → **BLE-MIDI** (MIDI sans fil)
  ou MIDI over Wi-Fi (RTP-MIDI / AppleMIDI).
- **Double cœur** : possibilité de séparer le traitement MIDI du pilotage
  des servos pour réduire la latence liée aux délais bloquants (voir les
  limites de rapidité dans [`../arduino/docs/LIMITES.md`](../arduino/docs/LIMITES.md)).
- **RAM confortable** : ~520 Ko → configuration et buffers à l'aise.
- **I2C matériel** : pilotage des PCA9685 identique à la version Arduino.

## Réutilisation prévue depuis `arduino/`

La logique métier est déjà découpée en modules indépendants du transport
MIDI ; une grande partie devrait se réutiliser telle quelle :

| Module | Réutilisable sur ESP32 ? |
|--------|--------------------------|
| `core/PCA9685Manager` | ✅ (I2C standard) |
| `core/InstrumentManager` | ✅ |
| `string/*` (Fret, Pluck, StringInstrument) | ✅ |
| `midi/NoteMapper` | ✅ |
| `midi/MIDIHandler` | ♻️ à réécrire (MIDIUSB → BLE-MIDI / Serial-MIDI) |
| `config/*` | ✅ (revoir les broches I2C/OE) |
| `utils/Debug` | ✅ |

## Structure envisagée (à créer)

```
esp32/
├── README.md                 # ce fichier
├── platformio.ini            # environnement ESP32 (à venir)
└── Servo-Plucked-String/     # sketch/projet ESP32 (à venir)
    └── src/
        ├── config/
        ├── core/
        ├── midi/             # MIDIHandler adapté (BLE-MIDI, etc.)
        ├── string/
        └── utils/
```

## Points d'attention pour le portage

- **MIDI** : remplacer `MIDIUSB` par une pile BLE-MIDI (ex. `ESP32-BLE-MIDI`)
  ou un pont série-MIDI.
- **Broches** : `PIN_OE` et le bus I2C (SDA/SCL) diffèrent de la cible
  Arduino — à redéfinir dans `config/settings.h`.
- **Tension logique** : l'ESP32 est en **3,3 V**. Vérifier la compatibilité
  I2C avec les PCA9685 (généralement OK) et les niveaux de la broche OE.
- **Alimentation** : les servos restent alimentés séparément en 5–6 V.

Voir la version de référence : [`../arduino/`](../arduino/).
