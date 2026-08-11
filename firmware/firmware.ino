/*
 * Servo-Plucked-Strings-GMB (servo-per-fret) — Arduino IDE entry point.
 *
 * This sketch is intentionally almost empty: setup() and loop() live in
 * src/main.cpp, and the whole firmware (pure core + ESP32 adapters) sits under
 * the src/ subfolder, which the Arduino build compiles recursively. The same
 * tree also builds with PlatformIO (see platformio.ini).
 *
 * ── Open in the Arduino IDE ────────────────────────────────────────────────
 *   1. File ▸ Open… ▸ select this file (firmware/firmware.ino).
 *   2. Install the ESP32 board package and the required libraries, then pick
 *      the board and settings — see docs/ARDUINO_IDE_BUILD.md for the exact list.
 *   3. PARTITION SCHEME: this firmware (async web server + JSON + servo control)
 *      is large and does NOT use OTA, so choose a No-OTA "Huge APP" scheme that
 *      still keeps a filesystem partition for the web UI:
 *        • 4 MB flash (e.g. ESP32-WROOM-32 / DevKit v1):
 *            Tools ▸ Partition Scheme ▸ "Huge APP (3MB No OTA/1MB SPIFFS)"
 *        • 8 MB flash (ESP32-S3-DevKitC-1):
 *            "8M with spiffs (3MB APP/1.5MB SPIFFS)"
 *      An OTA scheme on a 4 MB board leaves too little app space — the sketch
 *      won't fit ("Sketch too big").
 *   4. Upload the sketch, then upload the web UI to LittleFS (data/www) — the
 *      guide explains both steps.
 *
 * Do not add setup()/loop() here: they are defined once in src/main.cpp.
 */
