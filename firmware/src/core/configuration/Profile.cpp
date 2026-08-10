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
        // A geared finger also makes its second fret (side B) playable.
        if (s.fretB >= 1 && s.fretB <= static_cast<int8_t>(kMaxFret))
            mask |= (1u << s.fretB);
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

    for (uint8_t i = 0; i < stringCount; ++i) {
        StringConfig s;
        s.openNote = i < tuning.size() ? tuning[i] : 40;
        s.maxFret = maxFret;
        p.strings.push_back(s);

        // One dedicated finger servo per fret. Wired one PCA9685 per string
        // (pcaBoard = i): frets 1..maxFret land on channels 0..maxFret-1, leaving
        // the plucker on the next channel — well within a 16-channel board and
        // spreading the current draw across boards (one PCA per string).
        for (uint8_t f = 1; f <= maxFret; ++f) {
            ServoConfig finger;
            finger.enabled = true;
            finger.function = "finger";
            finger.stringIndex = static_cast<int8_t>(i);
            finger.fret = static_cast<int8_t>(f);
            finger.source = ServoSource::Pca;
            finger.pcaBoard = i;                          // one PCA per string
            finger.channel = static_cast<uint8_t>(f - 1); // fret 1 -> channel 0
            finger.disableAtRest = true;                  // idle fingers draw ~0 A
            p.servos.push_back(finger);
        }

        ServoConfig pluck;
        pluck.enabled = true;
        pluck.function = "pluck";
        pluck.stringIndex = static_cast<int8_t>(i);
        pluck.source = ServoSource::Pca;
        pluck.pcaBoard = i;                               // same board as its frets
        pluck.channel = maxFret;                          // channel after the fingers
        pluck.disableAtRest = true;
        p.servos.push_back(pluck);
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
