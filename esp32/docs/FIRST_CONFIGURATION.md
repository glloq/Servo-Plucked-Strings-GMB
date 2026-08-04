# First configuration — Servo-Plucked-Strings-GMB (servo-per-fret)

> Version **servo-par-frette** : un servo par position de frette, aucun moteur
> pas-à-pas, aucun homing. Réglages : [`CALIBRATION.md`](CALIBRATION.md),
> [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md), [`../README.md`](../README.md).

This guide walks a first-time setup from an unconfigured board to a playing
instrument, entirely from the web interface.

## 1. Connect

On first boot the ESP32 creates a Wi-Fi access point:

```
Default SSID: Servo-Plucked-Strings-GMB
```

Connect to it and open the device's address (e.g. `http://192.168.4.1`) in a
browser. Everything below happens in the **Setup Wizard** tab.

## 2. Wizard (8 steps)

1. **Instrument** — name and **type**. Picking a type (ukulele/guitar/bass/
   mandolin/banjo) loads a tuning **and** a full servo-per-fret wiring you can then
   tweak. Set the string count and capo; below, the board and Wi-Fi settings.
2. **Strings** — for each string, the **open note** and the **max fret**. Use
   *Auto-wire fingers* to generate one finger servo per fret on that string's PCA.
3. **Servos & frets** — the heart of the setup. For the selected string, a row per
   fret lets you **add/remove** a finger servo, choose its **source** (a PCA9685
   `board+channel`, or a direct GPIO), set its **contact angle** and **rotation
   direction**, and **test** it. Frets need not be contiguous — equip only the ones
   you built. The plucker (grattage) is edited in the same step.
4. **Install helper** — the guided calibration. Pick a string, then step through
   its frets: *Press* the finger, drag the **contact-angle** slider until it frets
   cleanly, *Play the note* to check the pitch, *Save & next fret*.
5. **MIDI** — channel / omni / velocity curve, and a link to the full CC
   string/fret selection editor (MIDI tab).
6. **Power** — the current governor: how many servos may start moving together
   (`maxConcurrentMoves`) and their spacing (`staggerMs`), plus note timing.
7. **Test** — play open and fretted notes on each string.
8. **Validation** — a client-side check; then **Finish & save**.

## 3. Pins

Servo-per-fret only needs the PCA9685 I²C bus and its `/OE` safety line:

```
SDA = 40, SCL = 41, SERVO_OE = 47   (ESP32-S3-DevKitC-1 defaults)
```

Direct-GPIO servos (if any) carry their own pin, chosen in the servo editor. There
are no STEP/DIR/HOME/ENABLE signals. See [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md).

## 4. Wiring convention

One **PCA9685 per string** (its fret fingers + its plucker on one board, ≤ 16
channels), up to **8 boards** (0x40–0x47). This spreads the current draw; combined
with `disableAtRest` and the governor it keeps the 5–6 V rail happy. See
[`SAFETY.md`](SAFETY.md).

## 5. Arm & play

From the **Dashboard**, use *Reset & re-arm* to arm the instrument (there is no
homing — it just parks the fingers at rest and goes ready). Then send MIDI over
Wi-Fi (UDP 5006), or use the per-string test buttons. To force an exact
string/fret from a controller, send `CC20 = string`, `CC21 = fret`, then the
Note On (see [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md)).

## 6. Save / export

*Finish & save* publishes the working profile. On the **Profiles** tab you can save
it to a device slot, set the startup slot, and export/import JSON.
