// Servo-Plucked-Strings-GMB — core shared types and constants.
//
// This header is pure C++17 with no Arduino / ESP-IDF dependency so that the
// whole algorithmic core can be unit-tested natively on a host with g++.
#pragma once

#include <cstdint>

namespace gmb {

// Hard capacity limits derived from the spec (section 6).
constexpr uint8_t kMaxStrings = 6;      // 1..6 strings, each with its own fingers
constexpr uint8_t kMaxServoOutputs = 16; // PCA9685 channels per board
constexpr uint8_t kMaxAuxPower = 8;
constexpr uint8_t kMinProfiles = 8;

// Highest fret index that can carry a dedicated finger servo. Bounds the 32-bit
// per-string "available fret" mask (bit F set = fret F has a servo; fret 0 is the
// open string and never needs one).
constexpr uint8_t kMaxFret = 24;

// Up to eight PCA9685 boards (I2C addresses 0x40..0x47). The "one PCA per string"
// wiring convention fits a string's fret fingers + its plucker on a single board
// (<=16 channels); more strings simply add boards.
constexpr uint8_t kMaxPca = 8;

// A MIDI CC number is 7-bit. 120..127 are Channel Mode messages and must not be
// offered as string/fret selectors.
constexpr uint8_t kMaxAssignableCc = 119;

// Sentinel used across the code base for "no GPIO / not assigned".
constexpr int8_t kNoPin = -1;

// Convert a fret index to the theoretical position along the vibrating string.
// position = scaleLengthMm * (1 - 2^(-fret/12))    (spec 14.2)
double fretPositionMm(double scaleLengthMm, int fret);

// Equal-tempered MIDI note produced by an open string at a given fret.
// note = openNote + fret + capo + transpose
inline int frettedNote(int openNote, int fret, int capo = 0, int transpose = 0) {
    return openNote + fret + capo + transpose;
}

// Clamp helper (std::clamp needs <algorithm>; keep this header light).
template <typename T>
inline T clampValue(T v, T lo, T hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

}  // namespace gmb
