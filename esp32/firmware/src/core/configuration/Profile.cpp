#include "Profile.h"

#include "../Types.h"

namespace gmb {

uint32_t Profile::availableFretMask(size_t stringIndex) const {
    uint32_t mask = 0;
    for (const auto& s : servos) {
        if (!s.enabled || s.function != "finger") continue;
        if (s.stringIndex != static_cast<int8_t>(stringIndex)) continue;
        if (s.fret >= 1 && s.fret <= static_cast<int8_t>(kMaxFret))
            mask |= (1u << s.fret);
    }
    return mask;
}

InstrumentView Profile::instrumentView() const {
    InstrumentView v;
    v.stringCount = static_cast<uint8_t>(strings.size());
    v.capo = instrument.capo;
    v.transpose = instrument.transpose + midi.transpose;
    for (size_t i = 0; i < strings.size(); ++i) {
        v.openNotes.push_back(strings[i].openNote);
        v.maxFretPerString.push_back(strings[i].maxFret);
        v.availableFretMask.push_back(availableFretMask(i));
    }
    return v;
}

Profile Profile::makeDefault(const std::string& name, uint8_t stringCount,
                             const std::vector<uint8_t>& tuning, uint8_t maxFret) {
    Profile p;
    p.instrument.name = name;
    p.instrument.stringCount = stringCount;
    if (maxFret > kMaxFret) maxFret = kMaxFret;

    // Assign (PCA board, channel) with a running cursor: one finger servo per fret
    // + a plucker, each string starting on a fresh board. For the common case
    // (maxFret <= 15, i.e. <= 16 channels) this is exactly "one PCA9685 per string"
    // (board = string index); a string needing more than 16 channels simply spills
    // onto the next board, so a channel is NEVER out of the 0..15 range.
    uint8_t board = 0, channel = 0;
    auto place = [&](const std::string& fn, int8_t stringIndex, int8_t fret) {
        if (channel > 15) { ++board; channel = 0; }
        ServoConfig sv;
        sv.enabled = true;
        sv.function = fn;
        sv.stringIndex = stringIndex;
        sv.fret = fret;
        sv.source = ServoSource::Pca;
        sv.pcaBoard = board;
        sv.channel = channel++;
        sv.disableAtRest = true;  // idle servos draw ~0 A
        if (fn == "pluck") { sv.activeUs = 1700; sv.travelMs = 90; sv.settleMs = 20; }
        p.servos.push_back(sv);
    };
    for (uint8_t i = 0; i < stringCount; ++i) {
        StringConfig s;
        s.openNote = i < tuning.size() ? tuning[i] : 40;
        s.maxFret = maxFret;
        p.strings.push_back(s);

        for (uint8_t f = 1; f <= maxFret; ++f)
            place("finger", static_cast<int8_t>(i), static_cast<int8_t>(f));
        place("pluck", static_cast<int8_t>(i), -1);

        // Next string starts on a fresh board (one PCA per string).
        if (channel != 0) { ++board; channel = 0; }
    }

    // Default explicit selection follows the General-Midi-Boop preset.
    p.selector.string.maximum = stringCount;
    p.selector.fret.maximum = maxFret;

    // Automatic pin assignment for the reference board (I2C + servo /OE only).
    if (const BoardProfile* board = builtinBoardProfile(p.boardIdentifier)) {
        PinManager pm(*board);
        PinRequest req;
        req.stringCount = stringCount;
        pm.autoAssign(req);
        p.pins = pm.assignments();
    }
    return p;
}

}  // namespace gmb
