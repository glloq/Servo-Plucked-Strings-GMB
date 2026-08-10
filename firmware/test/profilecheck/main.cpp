// Round-trip check: every shipped instrument-profiles/*.json must load through
// the REAL firmware parser (ProfileStorage::fromJson), the enum string values
// must be honoured (not silently defaulted), and re-serialising then re-parsing
// must reproduce the same enums. Guards the firmware<->web JSON contract (P0-1).
#include <ArduinoJson.h>

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../../src/core/configuration/Profile.h"
#include "../../src/core/configuration/ProfileValidator.h"
#include "../../src/platform/esp32/ProfileStorage.h"

using namespace gmb;

static int g_fail = 0;
#define CHECK(cond, msg)                                                   \
    do {                                                                   \
        if (!(cond)) { std::printf("  [FAIL] %s\n", msg); ++g_fail; }      \
    } while (0)

static std::string slurp(const std::string& path) {
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static bool parse(const std::string& json, Profile& out) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
    return ProfileStorage::fromJson(doc.as<JsonVariantConst>(), out);
}

int main(int argc, char** argv) {
    const char* files[] = {
        "instrument-profiles/ukulele-gcea.json",
        "instrument-profiles/ukulele-gcea-geared.json",
        "instrument-profiles/guitar-standard.json",
        "instrument-profiles/bass-4string.json",
        "instrument-profiles/mandolin-gdae.json",
        "instrument-profiles/banjo-5string.json",
        "instrument-profiles/plectrum-mute-demo.json",
        "instrument-profiles/lift-raise-demo.json",
    };
    std::string root = argc > 1 ? argv[1] : ".";
    int gearedFingersSeen = 0;  // geared (paired) fingers that survived a round trip
    int plectrumMuteSeen = 0;   // strikers with a plectrum-mute angle that survived
    int raiseToPlaySeen = 0;    // profiles with a raise-to-play lift that survived
    for (const char* rel : files) {
        std::string path = root + "/" + rel;
        std::printf("%s\n", rel);
        std::string json = slurp(path);
        CHECK(!json.empty(), "file is readable");
        Profile p;
        CHECK(parse(json, p), "loads through the firmware parser");
        // A shipped profile must not just parse — it must be a valid, activatable
        // instrument (pins, servo channels, finger frets incl. geared side B, …).
        CHECK(ProfileValidator::isActivatable(p), "profile is activatable");

        // Re-serialise and re-parse: the enums must survive a full round trip.
        JsonDocument out;
        ProfileStorage::toJson(p, out);
        std::string reser;
        serializeJson(out, reser);
        Profile p2;
        CHECK(parse(reser, p2), "re-serialised profile re-parses");
        CHECK(p2.midi.velocityCurve == p.midi.velocityCurve, "velocityCurve round-trips");
        CHECK(p2.selector.notePositionPolicy == p.selector.notePositionPolicy,
              "notePositionPolicy round-trips");
        CHECK(p2.selector.missingSelectionPolicy == p.selector.missingSelectionPolicy,
              "missingSelectionPolicy round-trips");
        CHECK(p2.selector.fret.invalidValuePolicy == p.selector.fret.invalidValuePolicy,
              "fret.invalidValuePolicy round-trips");
        CHECK(p2.strings.size() == p.strings.size(), "string count round-trips");
        CHECK(p2.power.maxConcurrentMoves == p.power.maxConcurrentMoves &&
                  p2.power.staggerMs == p.power.staggerMs,
              "power config round-trips");
        // Global plucking config: the gesture, the fret->pluck delay and the mute
        // source (an enum string) must all survive a full round trip.
        CHECK(p2.pluck.muteSource == p.pluck.muteSource, "pluck.muteSource round-trips");
        CHECK(p2.pluck.liftEngage == p.pluck.liftEngage, "pluck.liftEngage round-trips");
        if (p2.pluck.liftEngage == LiftEngage::RaiseToPlay) ++raiseToPlaySeen;
        CHECK(p2.pluck.strokeMs == p.pluck.strokeMs &&
                  p2.pluck.minStrikePct == p.pluck.minStrikePct &&
                  p2.pluck.fretToPluckMs == p.pluck.fretToPluckMs &&
                  p2.pluck.muteHoldMs == p.pluck.muteHoldMs,
              "pluck timings round-trip");
        // Per-plucker mute angle round-trips (index-aligned, since p2 comes from p).
        CHECK(p2.servos.size() == p.servos.size(), "servo count round-trips");
        for (size_t k = 0; k < p2.servos.size() && k < p.servos.size(); ++k) {
            CHECK(p2.servos[k].muteUs == p.servos[k].muteUs, "servo muteUs round-trips");
            if (p2.servos[k].enabled && p2.servos[k].muteUs != 0 &&
                (p2.servos[k].function == "pluck" || p2.servos[k].function == "strum"))
                ++plectrumMuteSeen;
        }
        // Servo-per-fret: at least one finger servo carrying a real fret survives.
        int fingersWithFret = 0;
        for (const auto& sv : p2.servos) {
            if (sv.enabled && sv.function == "finger" && sv.fret >= 1) ++fingersWithFret;
            // Geared finger: its second fret AND its side-B pulse must round-trip,
            // with the pulse still inside the servo's mechanical window.
            if (sv.enabled && sv.function == "finger" && sv.fretB >= 1) {
                ++gearedFingersSeen;
                CHECK(sv.fretB != sv.fret, "geared finger keeps two distinct frets");
                CHECK(sv.activeBUs >= sv.pulseMinUs && sv.activeBUs <= sv.pulseMaxUs,
                      "geared finger side-B pulse round-trips in window");
            }
        }
        CHECK(fingersWithFret > 0, "finger servos with a fret round-trip");
    }
    // The geared sample profile must actually exercise the paired-finger path.
    CHECK(gearedFingersSeen > 0, "geared (paired) fingers round-trip through the parser");
    // The plectrum-mute demo must actually exercise the plectrum-as-mute path.
    CHECK(plectrumMuteSeen > 0, "plectrum-mute angle round-trips through the parser");
    // The raise-to-play demo must actually exercise the raiseToPlay enum string.
    CHECK(raiseToPlaySeen > 0, "raise-to-play lift round-trips through the parser");

    // An unknown enum string must be REJECTED, not silently defaulted.
    {
        std::printf("unknown-enum rejection\n");
        std::string base = slurp(root + "/instrument-profiles/ukulele-gcea.json");
        JsonDocument doc;
        deserializeJson(doc, base);
        doc["midi"]["velocityCurve"] = "banana";
        std::string bad;
        serializeJson(doc, bad);
        Profile p;
        CHECK(!parse(bad, p), "unknown velocityCurve is rejected");
    }

    std::printf(g_fail ? "\nPROFILECHECK FAILED (%d)\n" : "\nprofilecheck OK\n", g_fail);
    return g_fail ? 1 : 0;
}
