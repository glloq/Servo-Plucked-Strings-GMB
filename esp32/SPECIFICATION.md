# Specification — Servo-Plucked-Strings-GMB

**Version:** 1.0
**Status:** initial specification
**Target platform:** ESP32-S3
**Number of strings:** 1 to 6
**Initial communication:** Wi-Fi
**Configuration:** local Web interface
**Instrument type:** plucked or strummed string instruments

---

# 1. Project purpose

Servo-Plucked-Strings-GMB is a modular MIDI controller for plucked or strummed string instruments.

To select a note the system does not move a finger along the string: **each fret position on a string has its own dedicated finger servo**. Pressing the servo of the target fret stops the string at that fret; fret 0 is the open string and has no servo.

For each string:

```text
one finger servo per equipped fret   (fret 0 = open, no servo)
one pluck servo (individual plectrum)   OR   one strum servo
optional strum lift, optional damper
```

Fret positions need not be contiguous — a string may carry fingers only on the frets actually equipped (for example 1, 3, 5, 12). A single actuator may drive two frets of the same string through a gear (a *geared finger*). Only one finger is ever pressed on a string at a time.

Note pitch is purely electrical:

```text
note = openNote + fret + capo + transpose
```

There is no carriage, no homing and no millimetre positioning.

---

# 2. Position within the GMB family

The project stays specialized to avoid an overly complex universal firmware. The note-selection technologies are split across separate projects:

```text
Stepper-Plucked-Strings-GMB
└── a stepper motor moves a single finger along each string

Servo-Plucked-Strings-GMB
└── one dedicated finger servo per fret position

Solenoid-Plucked-Strings-GMB
└── one fixed solenoid per fret position
```

This specification concerns only:

```text
Servo-Plucked-Strings-GMB
```

A common base may later be extracted for:

* MIDI processing;
* communication;
* Web configuration;
* profile management;
* diagnostics.

The mechanical logic of each project nonetheless remains independent.

---

# 3. Target instruments

The system must be adaptable to:

* ukulele;
* guitar;
* bass;
* mandolin;
* banjo;
* tenor guitar;
* zither;
* experimental plucked string instruments;
* instruments using an individual pick;
* instruments using a per-string strum.

The project must not impose:

* a specific tuning;
* a fixed number of strings;
* a fixed number of frets;
* a single type of servomotor;
* a fixed GPIO wiring.

---

# 4. Excluded functions

This project must not handle:

* bowed string instruments;
* linear bows and bow wheels;
* DC friction or BLDC bowing motors;
* bow speed regulation;
* note selection by a finger moved along the string on a carriage (that is the **Stepper-Plucked-Strings-GMB** project);
* note selection by a matrix of fixed solenoids (that is the **Solenoid-Plucked-Strings-GMB** project).

A matrix of fixed servomotor-driven fingers is exactly what this project *is*, so it is not an exclusion.

---

# 5. Reference mechanical architecture

## 5.1 String channel

Each string is an independent channel: an array of fixed finger servos, one per equipped fret, plus one plucker (or strummer).

```text
                    one string
   nut  [finger f1][finger f2] … [finger fN]  bridge
    ╞═════●═════════●═════════════●════════════╡  ← the string
    0     1         2             N   (fret positions, gaps allowed)
    └────── pluck / strum servo sets it in vibration ──────┘
```

Pressing the finger of fret F stops the string at fret F; releasing every finger leaves the open string (fret 0). At most one finger presses a given string at a time.

## 5.2 Finger pressing

Each equipped fret has a dedicated finger servo that can:

* press the string onto the fret (active pulse);
* lift clear of the string (rest pulse);
* stay lifted for the open string and while idle.

To play a new fret the firmware releases the currently pressed finger, then presses the target finger — never two fingers of one string at once. An idle finger cuts its PWM (`disableAtRest`) so it draws almost no current.

A **geared finger** lets one servo drive two frets of the same string: two antagonistic fingers on a gear, neutral = both lifted, so only one ever touches the string. Wide (low) frets can be geared to halve the servo count; narrow (high) frets keep a plain single finger. The two mix per servo. See [`docs/GEARED_FINGERS.md`](docs/GEARED_FINGERS.md).

## 5.3 Setting the string in vibration

Two modes are provided, mixable across strings on the same instrument.

### Individual pluck

Each string has its own pluck (plectrum) servo:

```text
1 pluck servo per string
```

This allows simultaneous chords, repeated notes, per-string tremolo, per-string velocity and precise triggering.

### Per-string strum

A string may instead use a strum servo:

* up-stroke and down-stroke;
* adjustable stroke;
* return to rest;
* synchronization with the fingers.

An optional per-string **strum lift** lowers the strummer onto the string for a stroke and raises it afterwards (rest = raised).

The same instrument may combine strings that pluck with strings that strum.

---

# 6. Target capacity

| Resource                            |     Minimum |               Maximum |
| ----------------------------------- | ----------: | --------------------: |
| Strings                             |           1 |                     6 |
| Finger servos per string            | 0 (open only) | 1 per equipped fret (to fret 24) |
| Pluck **or** strum servo            |           0 |          1 per string |
| Strum-lift / damper                 |           0 |     1 per string each |
| PCA9685 boards (I²C 0x40–0x47)      |           0 |                     8 |
| Channels per PCA9685                |           — |                    16 |
| Direct-GPIO servos (LEDC)           |           0 |                     8 |
| Shared damper / auxiliary servos    |           0 |                 8 aux |
| Saved profiles                      | 8 (minimum) |                     — |

The system must guarantee at all times:

```text
at most one finger pressed per string
```

Releasing the old finger before pressing the new one keeps the peak current bounded and never frets a string in two places at once.

Recommended wiring: **one PCA9685 per string** — its per-fret fingers and its plucker fit within the 16 channels; more strings simply add boards. The mapping stays free per servo, and any servo may run on a direct GPIO instead.

---

# 7. Electronic architecture

```text
                        Wi-Fi
                          │
             MIDI (UDP 5006) + Web configuration
                          │
                          ▼
                      ESP32-S3
             ┌────────────┴─────────────┐
             │                          │
          I²C bus                 direct GPIO (LEDC)
             │                          │
   PCA9685 ×1..8 (0x40–0x47)     up to 8 servos
   16 channels each                     │
             └────────────┬─────────────┘
                          ▼
        servos (finger per fret + pluck / strum / damper)
        /OE (PCA) + detach (direct) = hardware safety
```

## 7.1 Main controller

The reference platform is an ESP32-S3. The controller handles:

* reception of MIDI commands over Wi-Fi;
* hosting of the Web interface;
* note allocation;
* per-string state machines and the servo scheduler;
* control of the PCA9685 and the direct-GPIO servos;
* the current-draw governor;
* profile storage;
* diagnostics;
* safety.

The ESP32-S3 GPIO matrix allows routing peripheral signals to different GPIOs, which makes board profiles and a configurable pin assignment possible.

## 7.3 Servomotors

A servo's PWM signal comes from a **PCA9685 channel** or a **direct ESP32 GPIO** (LEDC), mixable per servo, so the instrument works with or without a PCA9685.

* Up to **8 PCA9685** on the I²C bus (addresses 0x40–0x47), 16 channels each.
* Up to **8 direct-GPIO** servos (the ESP32-S3 has 8 LEDC channels).

Recommended allocation on a per-string PCA9685:

| Channels          | Use                                    |
| ----------------- | -------------------------------------- |
| finger per fret   | one channel per equipped fret          |
| pluck / strum     | one channel for the string's plucker   |
| remaining         | optional strum lift / damper           |

The PCA9685 `OE` line is tied to a safety pin (active-low) so every PCA servo is neutralised instantly (§21). Direct-GPIO servos are detached on stop.

---

# 8. Communication

## 8.1 Initial version: Wi-Fi

The first version operates exclusively over Wi-Fi for external communications. Two network modes are offered.

### Access point mode

The ESP32 creates its own Wi-Fi network.

```text
Default SSID:
Servo-Plucked-Strings-GMB

Configuration address:
displayed local address or captive portal
```

This mode allows an initial configuration without a router.

### Wi-Fi client mode

The ESP32 joins the user's local network. The system stores:

* SSID;
* password;
* instrument network name;
* optional fixed address;
* mDNS name;
* reconnection parameters.

If the connection fails several times, the system automatically falls back to access point mode.

## 8.2 Initial MIDI transport

The transport layer is separated from the internal MIDI engine. The first version receives MIDI as raw MIDI byte packets over **Wi-Fi UDP on port 5006**: notes, the CC string/fret selectors (`CC20` = string, `CC21` = fret), and GMB SysEx (header `F0 7D 00`). `CC120` (All Sound Off) and `CC123` (All Notes Off) trigger a panic (§21).

Every transport produces the same internal event:

```cpp
struct MidiEvent {
    uint32_t timestampUs;
    uint8_t source;
    uint8_t type;
    uint8_t channel;
    uint8_t data1;
    uint8_t data2;
};
```

## 8.3 Future extensions

The architecture makes it possible to add later:

```text
BLE MIDI
USB MIDI
MIDI DIN
serial link
CAN or RS485
```

Adding a new transport must not modify:

* the string controller;
* the note allocator;
* the servo scheduler;
* mechanical profiles.

GPIO19 and GPIO20 remain reserved by default to preserve the ability to later use the native USB of the ESP32-S3 (its USB-JTAG / USB interface).

---

# 9. Web interface

## 9.1 Objective

The interface must let a beginner configure the instrument without modifying the source code. It must work from a computer, tablet or phone, with no dedicated application.

## 9.2 Two interface levels

### Simplified mode

Intended for beginners. It offers:

* step-by-step wizard;
* recommended values;
* automatic pin assignment;
* wiring diagrams;
* test buttons;
* automatic validation;
* understandable error messages.

### Advanced mode

Intended for fine-tuning. It allows:

* manual GPIO assignment;
* servo timing adjustment (travel / settle / delays);
* modification of velocity curves;
* access to diagnostics;
* editing of detailed servo parameters;
* JSON import and export.

---

# 10. First-configuration wizard

The web wizard guides the user through **eight steps**, in Simplified or Advanced mode.

## Step 1 — Instrument

Instrument name and description, type, number of strings (1–6), tuning preset, maximum frets, capo/transpose, network mode. The board is fixed to ESP32-S3-DevKitC-1; the board-level servo pins (SDA/SCL/SERVO_OE) are assigned automatically when a PCA9685 is used.

## Step 2 — Strings & tuning

Per string: enabled, open MIDI note, highest reachable fret (`maxFret`).

## Step 3 — Servos & frets

Per string, place the actuators:

* one **finger servo per fret** to equip (frets may be non-contiguous);
* one **pluck** or **strum** servo; optional **strum lift** and **damper**;
* optional **geared finger** — one servo for two frets (`fretB` / `activeBUs`);
* per servo: **source** (a PCA9685 channel on board 0–7, or a direct GPIO), rest/active pulses, inversion.

## Step 4 — Install helper

A guided, fret-by-fret assistant to set each finger's contact angle: select the fret → press the finger → adjust the active pulse until the note frets cleanly → test the note → next.

## Step 5 — MIDI

Global channel / Omni, transpose, chord-grouping window, velocity curve, saturation strategy, sustain, and the CC string/fret selectors (`CC20` / `CC21`).

## Step 6 — Power

Servo-rail sizing and current management: `maxConcurrentMoves`, `staggerMs`, and per-servo `disableAtRest`.

## Step 7 — Test

Exercise each finger, each pluck/strum, each note, each string, a chord, and the general stop (`/OE`).

## Step 8 — Validation

The interface shows:

```text
Valid configuration
```

or a precise list of the problems. No actuator is armed while critical errors remain.

---

# 11. Configurable GPIO management

## 11.1 Principle

The firmware must not use a single global list identical for all boards. Each board has a profile:

```cpp
struct BoardProfile {
    const char* identifier;
    const char* displayName;
    PinCapability pins[MAX_BOARD_PINS];
};
```

Each GPIO is described by capabilities:

```cpp
struct PinCapability {
    int8_t gpio;
    bool exposed;
    bool input;
    bool output;
    bool interrupt;
    bool highSpeedOutput;
    bool internalPullUp;
    bool internalPullDown;
    bool adc;
    bool reserved;
    bool strapping;
    bool usb;
    bool onboardPeripheral;
    PinPreference preference;
};
```

## 11.2 Displayed categories

In the interface:

```text
Green   → recommended
Yellow  → usable with caution
Red     → reserved or incompatible
Gray    → already in use
```

By default a beginner sees only the recommended GPIOs. Yellow GPIOs are accessible only in advanced mode, with an explanation. Red GPIOs are not selectable.

## 11.3 List filtered according to use

Servo-per-fret needs only a few board-level signals; every finger and plucker rides the PCA9685 bus or a direct GPIO.

For `SDA` and `SCL`, the list offers only I²C-capable GPIOs (a recommended default pair 40 / 41), none already in use.

For `SERVO_OE` (the PCA safety line) and a **direct-GPIO servo**, the list offers usable output GPIOs that are not reserved and not already assigned.

For a future USB interface, GPIO19 and GPIO20 are automatically reserved.

## 11.4 ESP32-S3 restrictions

The pin manager must be aware of at least the following restrictions:

* GPIO0, GPIO3, GPIO45 and GPIO46 are strapping pins;
* GPIO19 and GPIO20 are used by the native USB-JTAG / USB;
* GPIO26 to GPIO32 are tied to the on-chip Flash / PSRAM;
* GPIO33 to GPIO37 may also be used by the memory on some variants;
* GPIO48 drives the RGB LED on the DevKitC-1;
* GPIO43 and GPIO44 are tied to the main UART port of the DevKitC-1.

These pins are classified according to the exact board profile.

## 11.5 Recommended profile for ESP32-S3-DevKitC-1

Automatic assignment places only the board-level servo signals:

| Function             | Proposed GPIO |
| -------------------- | ------------- |
| I²C SDA (PCA9685)    | 40            |
| I²C SCL (PCA9685)    | 41            |
| PCA9685 /OE (safety) | 47            |

Direct-GPIO servos, when used, are picked from a suggested free-pin list:

```text
SERVO: 4, 5, 6, 7, 15, 16, 17, 18
```

Pins kept reserved by default:

| GPIO            | Reservation                       |
| --------------- | --------------------------------- |
| 19, 20          | future native USB                 |
| 43, 44          | programming / diagnostic UART     |
| 0               | BOOT / strapping                  |
| 3, 45, 46       | strapping                         |
| 48              | on-board RGB LED                  |
| 26–32, 35–37    | on-chip Flash / PSRAM             |

GPIO33 and GPIO34 are usable with caution (memory-dependent on some variants). This is an initial software profile, replaceable from the interface.

## 11.6 Conflict detection

The validator prevents:

* two signals using the same GPIO;
* a signal on a pin that cannot support it (e.g. I²C on a non-I²C pin);
* the use of a reserved / strapping / Flash-PSRAM / on-board-LED GPIO;
* the use of GPIO19 or GPIO20 when USB is reserved;
* the unintentional loss of the diagnostic UART.

Each error explains:

```text
why the pin is incompatible
which pin to choose instead
which function already uses the pin
```

---

# 14. Note configuration

## 14.1 Tuning

Each string has an open MIDI note and a highest reachable fret. **Which** frets actually carry a finger servo is derived from the servo list and need not be contiguous. The system offers predefined tunings — guitar, bass, ukulele, mandolin, banjo, custom — that remain fully modifiable. A fretted note is:

```text
note = openNote + fret + capo + transpose
```

## 14.2 Optional mechanical spacing aid

For laying out the fingers physically, the equal-tempered position of a fret along the string is:

```text
position = scaleLengthMm × (1 − 2^(−fret / 12))
```

This is only a mechanical construction aid (`fretPositionMm`). It is **not** used at runtime: note selection is which fret's servo is pressed, and pitch is `openNote + fret + capo + transpose`.

## 14.3 Finger contact-angle calibration

Each finger servo is calibrated for the pulse at which it frets its note cleanly, via the guided Install helper (§10, step 4):

1. select the fret;
2. press its finger servo;
3. adjust the active pulse (`activeUs`, or `activeBUs` for a geared side B);
4. test the note;
5. save the calibrated pulse.

For a geared finger both sides (`activeUs` / `activeBUs`) are calibrated around the neutral rest (`restUs`).

---

# 15. Servo configuration

Each servo is calibrated in microsecond pulses. Parameters (see `ServoConfig`):

```text
enabled
function                 finger / pluck / strum / strumLift / damper / sharedDamper / aux
stringIndex              owning string, or -1 for a shared/global servo
fret                     finger role: the fret this finger presses (-1 otherwise)
fretB, activeBUs         geared finger: second fret and its press pulse
source                   pca | gpio
pcaBoard (0–7), channel (0–15)   source = pca
gpio                     source = gpio
pulseMinUs, pulseMaxUs
restUs                   rest / neutral position
activeUs                 pressed / stroke position
inverted
travelMs, settleMs
disableAtRest
alternateDirection, activeAltUs   alternating down/up strokes
strokeMs                 time the stroke stays engaged
minStrikeUs              guaranteed minimum strike depth
engageDelayMs            strum-lift pause before the stroke fires
```

## 15.1 Finger

Raised = `restUs`, pressed = `activeUs`; `travelMs` / `settleMs` time the motion; `disableAtRest` cuts PWM when lifted. A geared finger adds a second fret at `activeBUs` (`fretB`), with `restUs` as the both-lifted neutral.

## 15.2 Pluck / strum

`restUs` ↔ `activeUs` define the stroke; `strokeMs` sets how long it stays engaged (independent of the return timing); `alternateDirection` / `activeAltUs` alternate down- and up-strokes; `minStrikeUs` guarantees a minimum strike so a low-velocity note still catches the string; a strum lift uses `engageDelayMs` to pause once lowered, before the stroke fires.

## 15.3 Open string

For the open string (fret 0) there is no finger servo: every finger stays lifted and the string is plucked directly. An advanced option may fit a fret-0 finger for a specific mechanism.

---

# 16. State machines

Each string runs an independent, non-blocking state machine (`StringState`):

```text
Disabled
Idle
ReleasingFinger
Moving            re-fretting: select the target fret's finger (not a carriage)
PressingFinger
Settling
ReadyToPluck
Plucking
Sustaining
Damping
Cancelling
Fault
```

There is **no** homing state. No blocking `delay()` is used during play. The play sequence for a note is: release the current finger → press the target-fret finger → settle → pluck.

Every command carries an identifier. If a command is cancelled or replaced, all deferred actions tagged with the old identifier are ignored. This prevents:

* a pluck after a Note Off;
* a delayed press;
* the execution of a stale position;
* an attack after a panic.

---

# 17. Note allocation

## 17.1 Principle

A note is assigned to a string that is:

* capable of playing the note;
* enabled;
* fault-free;
* available;
* requiring the shortest preparation time.

## 17.2 Chords

Notes received within a configurable window are grouped. Initial value:

```text
3 ms
```

The allocator looks for a global assignment. Order of priorities:

1. play as many notes as possible;
2. respect the mechanical limits;
3. minimize the time before plucking;
4. minimize movements;
5. keep fingers already well positioned;
6. limit direction changes.

## 17.3 Saturation strategies

When too many notes are requested:

```text
ignore extra notes
priority to low notes
priority to high notes
priority to the first note received
replace the oldest note
monophonic mode
```

The choice is accessible in the Web interface.

---

# 18. MIDI parameters

The interface allows:

* global MIDI channel;
* Omni mode;
* channel per string;
* general transposition;
* per-string transposition;
* note range;
* velocity curve;
* Note Off behavior;
* sustain pedal;
* chord grouping delay;
* saturation strategy.

## 18.1 Velocity

Velocity may act on:

* strike depth (`minStrikeUs` … `activeUs`);
* stroke duration (`strokeMs`);
* attack delay;
* pluck profile.

Curves offered:

```text
linear
soft
hard
exponential
custom
```

---

# 19. Web dashboard

The main page displays:

```text
general status
Wi-Fi connection
MIDI source
active profile
number of ready strings
notes currently playing
active faults
available temperatures
available voltages
STOP button
```

For each string:

```text
state
current fret
finger (up / down)
plectrum (rest / strike)
last fault
```

---

# 20. Saving configurations

The system stores at least eight profiles. Functions:

* create;
* copy;
* rename;
* delete;
* export;
* import;
* restore;
* set the startup profile.

The exchange format is JSON. Simplified example:

```json
{
  "project": "Servo-Plucked-Strings-GMB",
  "profileVersion": 1,
  "instrument": { "name": "Ukulele GCEA", "stringCount": 4, "type": "ukulele" },
  "board": {
    "profile": "esp32-s3-devkitc-1",
    "reserveUsb": true,
    "automaticPinAssignment": true
  },
  "network": { "mode": "accessPoint", "apSsid": "Servo-Plucked-Strings-GMB" },
  "strings": [
    { "enabled": true, "openNote": 67, "maxFret": 12 }
  ],
  "servos": [
    { "enabled": true, "function": "finger", "stringIndex": 0, "fret": 1,
      "source": "pca", "pcaBoard": 0, "channel": 0, "restUs": 1000, "activeUs": 1800 },
    { "enabled": true, "function": "pluck", "stringIndex": 0,
      "source": "gpio", "gpio": 4, "restUs": 1500, "activeUs": 1900 }
  ]
}
```

The Wi-Fi password must not appear in ordinary exports, except with an explicit option.

---

# 21. Safety

## 21.1 State at startup

At power-on:

```text
/OE held high — all PCA servos off
direct-GPIO servos detached
auxiliary outputs cut
MIDI queues empty
profile checked
GPIOs validated
```

The `/OE` line is pulled low (servos live) only once the instrument is armed.

## 21.2 Emergency stop

A hardware stop (optional debounced E-stop input) must be able to:

* pull the PCA9685 `/OE` high (all PCA servos off);
* detach the direct-GPIO servos;
* neutralize the auxiliary outputs;
* keep the ESP32 powered.

## 21.3 Software panic

A panic — raised by `CC120` / `CC123`, the E-stop, or an internal fault — must:

* flush the MIDI queue;
* cancel all pending moves and plucks;
* release (lift) the fingers;
* pull `/OE` high and detach the direct servos;
* record the cause.

## 21.4 Loss of Wi-Fi

Configurable behavior:

```text
finish active notes then stop
stop immediately
continue commands already queued
return to standby without disarming
```

Default behavior:

```text
cancellation of pending commands
controlled release of the fingers
stay armed and return to the READY state
```

---

# 22. Power supply

Recommended rails:

```text
5–6 V   servo rail (separate, sized to the servo count)
3.3 V   ESP32-S3 logic
```

Requirements:

* a **separate** servo supply sized for the peak servo current;
* servo-rail fuse;
* reverse-polarity protection;
* a reserve capacitor near each PCA9685;
* a structured common ground;
* lockable connectors;
* **no servo powered by the ESP32 regulator**.

There is no 24 V motor rail.

---

# 23. Software architecture

```text
firmware/
├── src/
│   ├── main.cpp                 hardware integration + servo-per-fret scheduler
│   ├── core/                    pure C++17 (host-testable, no Arduino/ESP-IDF)
│   │   ├── midi/                MidiParser, MidiEvent, StringFretSelector, Velocity
│   │   ├── instrument/          InstrumentController, StringController,
│   │   │                        NoteAllocator, ServoActivationGovernor
│   │   ├── configuration/       Profile (with ServoConfig), StringConfig,
│   │   │                        ProfileValidator, FingerTarget, ServoStroke
│   │   ├── gmb/                 GmbSysEx, Capabilities (SysEx service)
│   │   ├── safety/              SafetyManager
│   │   ├── board/               BoardProfile, PinManager
│   │   └── util/                Debounce
│   └── platform/esp32/          MidiWifi, ServoBank, WebApi, ProfileStorage, Net
└── test/                        native tests (14 files, 146 TEST() cases)
```

There is no `core/motion/` and no stepper subsystem (no StepperAxis / MotionPlanner / HomingController): the only servo driver is `platform/esp32/ServoBank`, which drives both PCA9685 and direct-GPIO servos.

---

# 24. Development phases

## Phase 1 — Single-string prototype

* ESP32-S3;
* Wi-Fi;
* minimal Web interface;
* one finger servo (one fret) plus one pluck servo;
* Wi-Fi MIDI test;
* complete per-string state machine;
* panic.

## Phase 2 — Intuitive configuration

* configuration wizard;
* board profile;
* automatic SDA/SCL/OE assignment;
* conflict validation;
* servo / finger calibration (install helper);
* JSON import/export.

## Phase 3 — Multi-string

* four then six strings;
* several PCA9685 (and/or direct-GPIO servos);
* current governor;
* note allocation;
* chords;
* per-string diagnostics.

## Phase 4 — Advanced play

* tremolo;
* damping;
* sustain pedal;
* velocity curves;
* saturation strategies;
* geared fingers.

## Phase 5 — Dedicated hardware

* electronic schematic;
* PCB;
* protections;
* connectors;
* hardware `/OE` stop;
* electrical validation;
* wiring documentation.

## Phase 6 — Future communications

* BLE MIDI;
* USB MIDI;
* MIDI DIN;
* additional wired links.

---

# 25. Acceptance criteria

The project is considered functional when:

1. one to six strings can be configured;
2. each string selects notes by pressing a dedicated finger servo per fret, with at most one finger pressed at a time;
3. servos can be driven on a PCA9685 and/or a direct GPIO, mixably;
4. the board-level pins (SDA/SCL/OE) can be assigned automatically and the interface offers only GPIOs compatible with the function;
5. pin conflicts are blocked;
6. a beginner can complete the configuration with the wizard and the install helper;
7. the system works in access point mode without a router;
8. the system can join an existing Wi-Fi network;
9. MIDI commands are received over Wi-Fi (UDP 5006), including CC20/CC21 string/fret selection;
10. open strings are played with every finger lifted;
11. a Note Off cancels an attack being prepared;
12. no delayed pluck is executed after a cancellation;
13. six strings can be played simultaneously (chords);
14. profiles can be saved, exported and restored;
15. a panic or E-stop neutralizes all servos (`/OE` high + direct servos detached);
16. loss of Wi-Fi produces a controlled release while the instrument stays armed;
17. the architecture allows the future addition of BLE MIDI and wired MIDI.

---

# 26. Deliverables

The project must provide:

```text
ESP32-S3 firmware
Web interface
profile format
ESP32 board profiles
GPIO assignment manager
electronic schematic
PCB
bill of materials
wiring documentation
first-configuration guide
calibration procedure
test procedure
Wi-Fi MIDI protocol documentation
automated tests
example instrument profiles
```

---

# 27. Recommended repository organization

```text
Servo-Plucked-Strings-GMB/
├── firmware/
├── web-interface/
├── hardware/
│   ├── schematics/
│   ├── pcb/
│   └── wiring/
├── board-profiles/
├── instrument-profiles/
├── mechanics/
├── docs/
│   ├── SPEC_INDEX.md
│   ├── ARCHITECTURE.md
│   ├── PIN_CONFIGURATION.md
│   ├── WEB_INTERFACE.md
│   ├── MIDI_PROTOCOL.md
│   ├── CALIBRATION.md
│   └── SAFETY.md
└── README.md
```

---

# 28. Initial decisions adopted

```text
Name: Servo-Plucked-Strings-GMB

Plucked or strummed string instruments only

1 to 6 strings

One dedicated finger servo per equipped fret (fret 0 = open, no servo)

One pluck or strum servo per string; optional strum lift / damper

Optional geared finger (one servo → two frets)

At most one finger pressed per string at a time

ESP32-S3-DevKitC-1

Servos on PCA9685 (up to 8, 0x40–0x47) and/or direct GPIO (LEDC, up to 8)

No stepper motor, no TMC2209, no homing

Wi-Fi in the first version (MIDI over UDP 5006)

Mandatory local Web interface

Configuration accessible to beginners

Automatic or manual GPIO assignment

Board profiles with pin filtering

GPIO19 and GPIO20 reserved for future USB

BLE MIDI and wired communications added later
```
