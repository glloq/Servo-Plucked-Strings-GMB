# Architecture — Servo-Plucked-Strings-GMB

> Reference document: [`SPECIFICATION.md`](../SPECIFICATION.md) §23, §24.
> Related documents: [`PIN_CONFIGURATION.md`](PIN_CONFIGURATION.md) · [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md) · [`WEB_INTERFACE.md`](WEB_INTERFACE.md) · [`CALIBRATION.md`](CALIBRATION.md) · [`SAFETY.md`](SAFETY.md)

This document describes the software organization of the firmware, how the
modules from the specification (§23) map to the code actually implemented
in `firmware/src/`, the end-to-end data flow, the generation of the
capabilities snapshot, the "pure core + platform adapters + native tests"
strategy, and the development phases (§24).

---

## 1. Strategy: pure core, platform adapters, native tests

The algorithmic core of the firmware is written in **pure C++17**, without any
Arduino or ESP-IDF dependency. This constraint is explicit in the code:

```cpp
// Types.h — This header is pure C++17 with no Arduino / ESP-IDF dependency so
// that the whole algorithmic core can be unit-tested natively on a host with g++.
```

Consequences:

* **Pure core** (`firmware/src/core/`) — business logic testable on a PC: board
  profiles, pin management, string/fret selection, note allocation, per-string
  state machine, servo/stroke shaping, current governor, GMB capabilities/SysEx,
  safety. No direct hardware access.
* **Platform adapters** (`firmware/src/platform/esp32/`) — concrete
  implementations that connect the core to the ESP32-S3 hardware: `ServoBank`
  drives every actuator directly — **PCA9685** channels and/or **direct ESP32
  GPIO** (14-bit LEDC), mixable per servo; **there is no stepper engine**. `Net`
  (non-blocking Wi-Fi AP/station), `WebApi` (REST configuration API), `MidiWifi`
  (MIDI over Wi-Fi UDP), `ProfileStorage` (LittleFS + NVS for secrets). These
  layers consume the core without modifying it.
* **Native tests** (`firmware/test/`) — **146 `TEST()` cases across 14 test
  files**, compiled and run with `g++ -std=c++17` via `firmware/test/Makefile`
  and driven by the `test_main` runner: `test_board`, `test_selector`,
  `test_allocator`, `test_profile`, `test_sysex`, `test_geared`, `test_fretservo`,
  `test_governor`, `test_servos`, `test_audit`, `test_debounce`, `test_midiparser`,
  `test_integration`, `test_string_fsm`.

```bash
cd firmware/test && make        # compile the core + the tests, then run them
```

This separation guarantees that a new MIDI transport or a new board does not
affect the string controller, the allocator, the servo control, or the
instrument/servo profiles (specification §8.3).

---

## 2. Target tree (§23) and correspondence with the code

Specification §23 describes the complete **target** tree. The firmware
implements it as a **pure `core/`** (host-tested) plus **ESP32
`platform/esp32/`** adapters:

```text
firmware/src/
├── main.cpp                    hardware integration + servo-per-fret scheduler
├── core/                       pure C++17, host-tested (no Arduino / ESP-IDF)
│   ├── Types.{h,cpp}           shared enums / structs
│   ├── midi/                   MidiEvent, MidiParser, StringFretSelector
│   │                           (CC20/CC21 tablature), Velocity
│   ├── instrument/             StringController (per-string FSM), NoteAllocator,
│   │                           InstrumentController, ServoActivationGovernor
│   ├── configuration/          Profile (source of truth), ProfileValidator,
│   │                           StringConfig, ServoStroke, FingerTarget
│   ├── gmb/                    Capabilities snapshot, GmbSysEx (+ Service)
│   ├── board/                  BoardProfile, PinManager (assignment + validation)
│   ├── safety/                 SafetyManager (safe states / panic / faults)
│   └── util/                   Debounce
└── platform/esp32/             hardware adapters
    ├── MidiWifi                MIDI over Wi-Fi (UDP transport)
    ├── ServoBank               PCA9685 channels + direct-GPIO servos (14-bit LEDC)
    ├── WebApi                  REST configuration / wizard backend
    ├── ProfileStorage          LittleFS + NVS persistence (secrets in NVS)
    └── Net                     non-blocking Wi-Fi (AP / station)
```

Correspondence notes:

* `PinValidator` (§23) is merged into `PinManager::validate()` — validation
  and assignment share the same `BoardProfile`.
* `FaultManager` (§23) is merged into `SafetyManager` (`recordFault()` /
  `faults()`).
* The `gmb/` module realizes the
  [`SYSEX_CAPABILITIES.md`](../SYSEX_CAPABILITIES.md) specification.
* `main.cpp` integrates the core with the platform adapters and runs the
  non-blocking servo-per-fret scheduler (release the current finger → press the
  target-fret finger → settle → pluck).

---

## 3. Main data flow

A MIDI transport produces a single internal `MidiEvent` (specification §8.2),
and everything else in the firmware never depends on how the bytes arrived.

```text
Transport (Wi-Fi UDP / Web test / future BLE / USB / DIN)
        │  decoding
        ▼
MidiEvent { timestampUs, source, type, channel, data1, data2 }
        │
        ├──► SysEx (F0 …) ─────────────► GmbSysEx  ──► CapabilitySnapshot ──► response
        │
        ▼
MidiRouter (routing by channel / Omni)
        │
        ▼
StringFretSelector          (explicit string/fret selection CC20/CC21, FIFO)
   ├─ onControlChange()      queues pending string/fret selections
   ├─ onNoteOn() ──► NoteResolution { play, source, stringIndex, fret, instanceId }
   └─ onNoteOff() ──► ActiveNote (releases the string actually used)
        │
        │  (Automatic / Hybrid mode without a valid CC)
        ▼
NoteAllocator               (chooses the best string, groups chords,
                             applies the saturation strategy)
        │  Allocation { stringIndex, fret }
        ▼
StringController[c]          (non-blocking state machine, 1 per string)
   DISABLED → IDLE → RELEASING_FINGER → MOVING →
   PRESSING_FINGER → SETTLING → READY_TO_PLUCK → PLUCKING →
   SUSTAINING → DAMPING (→ IDLE)     |  CANCELLING  |  FAULT
        │
        ▼
ServoBank                   (release the current finger → press the target-fret
   finger → settle → pluck; finger / pluck / damper on PCA9685 channels or
   direct GPIO, one finger per string at a time)
```

Key points of the flow:

* **No carriage, no homing.** Each fret has its own finger servo, so there is no
  origin search: the `MOVING` state is retained only as the (now instantaneous)
  step where the scheduler selects the target fret's finger before pressing it,
  which keeps the note lifecycle and command-id guards identical to the stepper
  design.
* **Common event.** `MidiEvent` (see [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md))
  handles the MIDI subtleties (`isNoteOff()` treats a Note On with velocity 0 as
  a Note Off in running status).
* **Selection before allocation.** In `Explicit`/`Hybrid` mode,
  `StringFretSelector` enforces the string/fret; in `Automatic` mode or as a
  fallback, `NoteAllocator` decides. Details in
  [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md).
* **Command identifier.** Each `noteOn(fret)` returns a fresh `commandId`;
  any deferred action tagged with an old id is ignored. This prevents a
  pluck after a Note Off, a delayed press, the execution of a stale target,
  or an attack after a panic (specification §16).
* **Reliable Note Off.** The actual assignment of a Note On is memorized
  (`ActiveNote`) to release the correct string, even in a chord or with repeated
  notes.

---

## 4. Capabilities snapshot flow (GMB SysEx)

The active profile is **the single source of truth**. The capabilities
announced to General-Midi-Boop are reconstructed from this profile, never
hard-coded.

```text
Web interface edits a draft
        │
        ▼
ProfileValidator (full validation)
        │  valid
        ▼
Atomic save + capabilitiesRevision increment
        │
        ▼
buildSnapshot(Profile) ──► CapabilitySnapshot (immutable)
        │   { revision, identity, descriptor, capabilities, stringConfig, valid }
        ▼
GmbSysEx::respond(request, snapshot)   (one response = a single snapshot)
        │
        ▼
MIDI transport ──► General-Midi-Boop updates the instrument
        ▲
        └── Block 8 (notification) prompts GMB to restart discovery
```

`buildSnapshot()` (`core/gmb/Capabilities.cpp`) automatically computes the
playable range (union of the notes of all active strings), continuous or
discrete-notes mode, polyphony (number of active strings or overload), and the
list of CC actually enabled. A snapshot is **immutable**: a config change
during sending cannot mix two versions of the profile. See the full protocol
in [`MIDI_PROTOCOL.md`](MIDI_PROTOCOL.md#3-protocole-sysex-gmb).

---

## 5. The profile, backbone of the configuration

`core/configuration/Profile.h` aggregates the entire configuration:

| Field | Type | Role |
| ----- | ---- | ---- |
| `instrument` | `InstrumentInfo` | name, type, GM program, string count, capo, transpose |
| `boardIdentifier` / `reserveUsb` / `automaticPinAssignment` / `pins` | — | board id, USB reservation, auto-assign flag, GPIO assignment |
| `network` | `NetworkConfig` | AP/station mode, SSID, hostname, `apSsid`, static IP |
| `midi` | `MidiConfig` | channel, Omni, transpose, chord window, velocity curve, sustain pedal, timing leads |
| `selector` | `SelectorConfig` | string/fret selection (CC20/CC21, mode, timeout, FIFO…) |
| `power` | `PowerConfig` | current governor (`maxConcurrentMoves`, `staggerMs`) |
| `strings` | `vector<StringConfig>` | per string: `{ enabled, openNote, maxFret }` |
| `servos` | `vector<ServoConfig>` | finger / pluck / strumLift / damper / aux servos (PCA channel or direct GPIO) |
| `capabilitiesRevision` | `uint32_t` | revision counter (Block 8 notification) |

`Profile::instrumentView()` derives from it an `InstrumentView` shared by the
string/fret selector and the capabilities generator; `availableFretMask()`
reports which frets carry a finger servo (the servo list is the source of truth
for which frets exist).

---

## 6. Development phases (§24)

| Phase | Objective | Key deliverables |
| ----- | ----- | -------------- |
| **1 — Single-string prototype** | ESP32-S3, Wi-Fi, minimal UI, one string wired **servo-per-fret** (finger servos + a plucker), Wi-Fi MIDI test, complete state machine, panic | state machine, servo control, panic |
| **2 — Intuitive configuration** | wizard, board profile, automatic GPIO assignment, conflict validation, servo calibration, JSON import/export | `BoardProfile`, `PinManager`, `Profile`, wizard |
| **3 — Multi-string** | 4 then 6 strings, PCA9685, note allocation, chords, current governor, per-string diagnostics | `NoteAllocator`, `ServoActivationGovernor` |
| **4 — Advanced playing** | tremolo, damping, sustain pedal, velocity curves, saturation strategies | curves |
| **5 — Dedicated hardware** | schematic, PCB, protections, connectors, hardware shutdown, electrical validation, wiring documentation | `hardware/` |
| **6 — Future communications** | BLE MIDI, USB MIDI, MIDI DIN, wired links | new transports reusing `MidiEvent` |

The current state of the repository covers the algorithmic **core** of phases 1
to 3 (`core/*` modules + 146 native tests) together with the ESP32 platform
adapters (`platform/esp32/*`) and the Web interface.

---

## 7. Transport independence

Adding a transport (BLE, USB, DIN, serial, CAN/RS485) must modify neither the
string controller, nor the allocator, nor the servo control, nor the
instrument/servo profiles (§8.3). All transports:

1. decode the bytes into `MidiEvent`;
2. forward complete MIDI bytes to the router;
3. reuse exactly the same blocks, encoder, decoder, snapshot, and tests
   for the GMB SysEx (SysEx spec §21).

GPIO19/GPIO20 remain reserved by default for the ESP32-S3 native USB.
