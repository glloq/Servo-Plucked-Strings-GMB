#include "Capabilities.h"

#include <algorithm>
#include <set>

#include "../Types.h"
#include "../configuration/Profile.h"

namespace gmb {

CapabilitySnapshot buildSnapshot(const Profile& p, int polyphonyOverride) {
    CapabilitySnapshot snap;
    snap.revision = p.capabilitiesRevision;
    snap.valid = true;

    const uint8_t channel = p.midi.omni ? 0 : p.midi.globalChannel;
    const int capo = p.instrument.capo;
    const int transpose = p.instrument.transpose + p.midi.transpose;
    // The string/fret selection CCs are only consumed when selection is enabled AND
    // not in pure Automatic mode — announcing them otherwise advertises CCs the
    // firmware ignores (spec §7: "a disabled CC must not be announced") — audit SX-7.
    const bool selectionActive =
        p.selector.enabled && p.selector.mode != SelectionMode::Automatic;

    // ---- Identity ----
    snap.identity.deviceName = p.instrument.name;
    snap.identity.model = p.project;
    snap.identity.features = 0x38;  // descriptor + capabilities + string config
    snap.identity.firmware[0] = 1;
    snap.identity.firmware[1] = 0;
    snap.identity.firmware[2] = 0;

    // ---- Descriptor ----
    snap.descriptor.channel = channel;
    snap.descriptor.gmProgram = p.instrument.gmProgram;
    snap.descriptor.typeId = p.instrument.typeId;
    snap.descriptor.type = p.instrument.type;

    // ---- Playable range, tuning and per-string frets (spec §5 / §8) ----
    // Playability follows the ACTUAL wired frets, not a contiguous assumption: a
    // servo-per-fret string may equip only frets {1,3,5,12}, so the range, the
    // discrete-note list and the per-string data are all built from
    // availableFretMask() — the single source of truth for which frets exist
    // (audit SX-1). Fret 0 (open string) is always playable. Tuning and
    // fretsPerString are collected in PHYSICAL STRING ORDER and stay index-aligned
    // (audit SX-2): tuning[i] and fretsPerString[i] must describe the same string.
    // The announced open pitch folds in the global transpose so the announced
    // tuning + capo reproduce the announced range (audit SX-3); capo stays a
    // separate announced field.
    std::set<int> playable;
    int minNote = 128, maxNote = -1;
    uint8_t activeStrings = 0;
    uint8_t maxFretGlobal = 0;
    std::vector<uint8_t> tuning;          // effective open pitch, physical order
    std::vector<uint8_t> fretsPerString;  // declared reach, same order
    for (size_t i = 0; i < p.strings.size(); ++i) {
        const auto& s = p.strings[i];
        if (!s.enabled) continue;
        ++activeStrings;
        maxFretGlobal = std::max(maxFretGlobal, s.maxFret);
        const int openEff = s.openNote + transpose;  // pitch as addressed by MIDI
        tuning.push_back(static_cast<uint8_t>(std::max(0, std::min(127, openEff))));
        fretsPerString.push_back(s.maxFret);
        const uint32_t mask = p.availableFretMask(i);
        auto addFret = [&](int fret) {
            const int n = openEff + capo + fret;
            if (n < 0 || n > 127) return;
            playable.insert(n);
            minNote = std::min(minNote, n);
            maxNote = std::max(maxNote, n);
        };
        addFret(0);  // open string always playable
        const int top = std::min<int>(s.maxFret, kMaxFret);
        for (int f = 1; f <= top; ++f)
            if ((mask >> f) & 1u) addFret(f);
    }
    if (maxNote < 0) {
        // No enabled/working string: the snapshot is NOT a playable instrument.
        // Mark it invalid instead of announcing a bogus 0..0 range so a host can
        // tell "silent, degraded to nothing" from "can play MIDI note 0".
        minNote = 0;
        maxNote = 0;
        snap.valid = false;
    }

    InstrumentCapabilities& caps = snap.capabilities;
    caps.channel = channel;
    caps.gmProgram = p.instrument.gmProgram;
    caps.typeId = p.instrument.typeId;
    caps.name = p.instrument.name;
    caps.noteMin = static_cast<uint8_t>(minNote);
    caps.noteMax = static_cast<uint8_t>(maxNote);

    // Continuous only if every note in [min,max] is playable somewhere.
    bool continuous = true;
    for (int n = minNote; n <= maxNote; ++n) {
        if (playable.find(n) == playable.end()) {
            continuous = false;
            break;
        }
    }
    if (continuous) {
        caps.noteMode = 0;
    } else {
        caps.noteMode = 1;
        for (int n : playable) caps.discreteNotes.push_back(static_cast<uint8_t>(n));
    }

    // ---- Polyphony (spec section 6) ----
    // Automatic = number of active strings. A profile-configured cap
    // (instrument.polyphonyMax > 0) or an explicit runtime override lowers it, but
    // it is never announced above the physical string count (audit SX-4).
    if (polyphonyOverride >= 0)
        caps.polyphony = static_cast<uint8_t>(std::min<int>(polyphonyOverride, activeStrings));
    else if (p.instrument.polyphonyMax > 0)
        caps.polyphony = std::min<uint8_t>(p.instrument.polyphonyMax, activeStrings);
    else
        caps.polyphony = activeStrings;

    // ---- Announced CCs (spec section 7): only activated ones ----
    caps.supportedCc.push_back(7);    // volume
    caps.supportedCc.push_back(11);   // expression
    if (selectionActive) {            // only when actually consumed (audit SX-7)
        caps.supportedCc.push_back(p.selector.string.ccNumber);
        caps.supportedCc.push_back(p.selector.fret.ccNumber);
    }
    if (p.midi.sustainPedal) caps.supportedCc.push_back(p.midi.sustainCc);
    caps.supportedCc.push_back(120);  // all sound off
    caps.supportedCc.push_back(123);  // all notes off
    std::sort(caps.supportedCc.begin(), caps.supportedCc.end());

    // ---- String configuration (spec section 8 / 10) ----
    // Announce only the strings that are actually available (enabled). In a
    // degraded run the faulted axes are disabled in the runtime profile copy, so
    // the whole string config shrinks consistently. stringCount / tuning /
    // fretsPerString all come from the single physical-order pass above so they
    // stay index-aligned (audit SX-2).
    StringInstrumentConfig& sc = snap.stringConfig;
    sc.channel = channel;
    sc.stringCount = activeStrings;
    sc.fretCount = maxFretGlobal;
    sc.isFretless = 0;
    sc.capo = static_cast<uint8_t>(capo);
    sc.ccActive = selectionActive ? 1 : 0;  // audit SX-7
    sc.ccString = p.selector.string.ccNumber;
    sc.ccFret = p.selector.fret.ccNumber;
    sc.tuning = tuning;                  // physical order, transpose folded in
    sc.fretsPerString = fretsPerString;  // physical order, aligned with tuning

    // A degraded run announces only the enabled strings (renumbered 1..N), so the
    // CC bounds and the custom mapping must be made consistent with that reduced
    // set — otherwise a client sees, say, 3 strings but a CC range / mapping still
    // referencing the original 4 axes (audit P1-6).
    const bool degraded = activeStrings < p.strings.size();

    // v2 extras.
    sc.ccStringMin = p.selector.string.minimum;
    sc.ccStringMax = p.selector.string.maximum;
    sc.ccStringOffset = p.selector.string.offset;
    sc.ccFretMin = p.selector.fret.minimum;
    sc.ccFretMax = p.selector.fret.maximum;
    sc.ccFretOffset = p.selector.fret.offset;
    sc.selectionMode = static_cast<uint8_t>(p.selector.mode);
    sc.stringOrder = p.selector.string.reverseOrder ? 1 : 0;
    if (degraded) {
        // Reduced set (some strings disabled/faulted): clamp the CC range to what is
        // actually announced and drop the custom mapping. A mapping is a permutation
        // over the FULL configured axis set, so it is genuinely inapplicable to the
        // renumbered reduced set — announcing an incoherent mapping would be worse
        // than announcing none. This is intentional for both user-disabled and
        // runtime-faulted strings (audit SX-8: reviewed, behaviour retained).
        if (sc.ccStringMax > activeStrings) sc.ccStringMax = activeStrings;
        if (sc.ccStringMin > sc.ccStringMax) sc.ccStringMin = sc.ccStringMax;
    } else {
        if (!p.selector.string.mapping.empty()) sc.stringOrder = 2;
        for (int8_t m : p.selector.string.mapping)
            sc.mapping.push_back(static_cast<uint8_t>(m));
    }

    snap.identity.deviceName = p.instrument.name;
    return snap;
}

}  // namespace gmb
