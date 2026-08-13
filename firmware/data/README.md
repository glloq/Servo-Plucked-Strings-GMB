# `data/` — LittleFS image (optional)

**Uploading LittleFS is optional**: the web interface is embedded in the
firmware binary (`src/platform/esp32/WebAssets.cpp`, generated from
[`../../web-interface/`](../../web-interface/)), so a plain firmware upload
already serves the full UI. Files uploaded to LittleFS `/www` merely
**override** their embedded copy — useful to iterate on the UI without
recompiling.

`data/www/` is **generated** from `web-interface/` (the single source of
truth) and is git-ignored. Regenerate it before uploading the filesystem
(this also regenerates the embedded `WebAssets.cpp` — commit that one):

```bash
cd firmware
./sync_web_data.sh
```

Then upload the filesystem:

- **Arduino IDE 2.x** — install the *arduino-littlefs-upload* plugin, then run
  `Ctrl/Cmd+Shift+P ▸ Upload LittleFS to Pico/ESP8266/ESP32`.
- **PlatformIO** — `pio run -t uploadfs`.

See [`../../docs/ARDUINO_IDE_BUILD.md`](../../docs/ARDUINO_IDE_BUILD.md) for the full
walkthrough.
