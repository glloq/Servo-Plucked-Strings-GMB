// Device vs Instrument separation (audit P1.13) — progressive first step.
//
// Today a single Profile mixes what belongs to the physical MACHINE (which ESP32
// board, Wi-Fi, system pins) with what belongs to the INSTRUMENT (strings, servos,
// MIDI mapping, plucking). This header introduces the two target structs and a
// LOSSLESS split/merge against the existing Profile, WITHOUT changing persistence —
// so the boundary is defined and proven clean, and consumers (WebApi, storage) can
// migrate onto it incrementally before the on-disk split (a future v2->v3 migration,
// see ProfileStorage::migrate). Old profiles keep loading unchanged.
//
//   DeviceConfig      : board type, network, system pins — independent of the tune.
//   InstrumentProfile : instrument identity, MIDI, selector, power, pluck, strings,
//                       servos — portable across devices.
//
// Passwords already live outside the Profile (in Preferences), never exported.
// MidiTransportConfig / SafetyConfig will join DeviceConfig as those features gain a
// persisted shape (P1.7 / P1.10 groundwork).
#pragma once

#include <string>
#include <vector>

#include "../board/PinManager.h"
#include "Profile.h"

namespace gmb {

// Belongs to the physical device, independent of which instrument is loaded.
struct DeviceConfig {
    std::string boardIdentifier = "esp32-s3-devkitc-1";
    bool reserveUsb = true;
    bool automaticPinAssignment = true;
    std::vector<PinAssignment> pins;
    NetworkConfig network;
};

// Belongs to the instrument, portable from one device to another.
struct InstrumentProfile {
    InstrumentInfo instrument;
    MidiConfig midi;
    SelectorConfig selector;
    PowerConfig power;
    PluckConfig pluck;
    std::vector<StringConfig> strings;
    std::vector<ServoConfig> servos;
};

// Split a combined Profile into its device and instrument halves (pure copies).
inline DeviceConfig deviceConfigOf(const Profile& p) {
    DeviceConfig d;
    d.boardIdentifier = p.boardIdentifier;
    d.reserveUsb = p.reserveUsb;
    d.automaticPinAssignment = p.automaticPinAssignment;
    d.pins = p.pins;
    d.network = p.network;
    return d;
}

inline InstrumentProfile instrumentProfileOf(const Profile& p) {
    InstrumentProfile i;
    i.instrument = p.instrument;
    i.midi = p.midi;
    i.selector = p.selector;
    i.power = p.power;
    i.pluck = p.pluck;
    i.strings = p.strings;
    i.servos = p.servos;
    return i;
}

// Recombine the two halves into a Profile (the persisted/runtime form for now).
// Profile-level metadata (project / versions / capabilitiesRevision) is carried on
// `base` so a round trip preserves it.
inline Profile mergeProfile(const DeviceConfig& d, const InstrumentProfile& i,
                            const Profile& base = Profile{}) {
    Profile p = base;
    p.boardIdentifier = d.boardIdentifier;
    p.reserveUsb = d.reserveUsb;
    p.automaticPinAssignment = d.automaticPinAssignment;
    p.pins = d.pins;
    p.network = d.network;
    p.instrument = i.instrument;
    p.midi = i.midi;
    p.selector = i.selector;
    p.power = i.power;
    p.pluck = i.pluck;
    p.strings = i.strings;
    p.servos = i.servos;
    return p;
}

}  // namespace gmb
