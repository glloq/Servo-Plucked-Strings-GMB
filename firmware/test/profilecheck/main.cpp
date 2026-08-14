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

// The on-disk slot path (split device/instrument form, P1.13).
static bool parseSlot(const std::string& json, Profile& out) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
    return ProfileStorage::fromSlotJson(doc.as<JsonVariantConst>(), out);
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

    // A PCA profile imported with an empty pin list + automaticPinAssignment must be
    // auto-wired on load, not rejected for missing SDA/SCL/OE (audit P-B4).
    {
        std::printf("auto-pin-assignment on import\n");
        std::string base = slurp(root + "/instrument-profiles/ukulele-gcea.json");
        JsonDocument doc;
        deserializeJson(doc, base);
        doc.remove("pins");                               // ship no pins
        doc["board"]["automaticPinAssignment"] = true;
        std::string body;
        serializeJson(doc, body);
        Profile p;
        CHECK(parse(body, p), "PCA profile with empty pins parses");
        CHECK(!p.pins.empty(), "pins were auto-assigned on import");
        CHECK(ProfileValidator::isActivatable(p), "auto-wired profile is activatable");
    }

    // Second I2C bus: a board moved to i2cBus=1 must round-trip and, with its
    // SDA2/SCL2 pins, stay activatable — and be rejected without them.
    {
        std::printf("second-i2c-bus round-trip\n");
        std::string base = slurp(root + "/instrument-profiles/ukulele-gcea.json");
        JsonDocument doc;
        deserializeJson(doc, base);
        for (JsonObject s : doc["servos"].as<JsonArray>())
            if (static_cast<int>(s["pcaBoard"] | 0) == 0) s["i2cBus"] = 1;  // board 0 -> bus 1
        JsonArray pins = doc["pins"].as<JsonArray>();
        { JsonObject o = pins.add<JsonObject>(); o["signal"] = "SDA2"; o["gpio"] = 38; }
        { JsonObject o = pins.add<JsonObject>(); o["signal"] = "SCL2"; o["gpio"] = 39; }
        std::string body;
        serializeJson(doc, body);
        Profile p;
        CHECK(parse(body, p), "second-bus profile parses");
        int bus1 = 0;
        for (auto& sv : p.servos) if (sv.enabled && sv.i2cBus == 1) ++bus1;
        CHECK(bus1 > 0, "i2cBus=1 survives the parse");
        CHECK(ProfileValidator::isActivatable(p), "second-bus profile is activatable");

        JsonDocument out;  // round-trip: i2cBus survives re-serialisation
        ProfileStorage::toJson(p, out);
        std::string reser;
        serializeJson(out, reser);
        Profile p3;
        CHECK(parse(reser, p3), "second-bus profile re-parses");
        int bus1b = 0;
        for (auto& sv : p3.servos) if (sv.enabled && sv.i2cBus == 1) ++bus1b;
        CHECK(bus1b == bus1, "i2cBus round-trips through toJson");

        // Without SDA2/SCL2 the same second-bus profile must be rejected.
        JsonDocument doc2;
        deserializeJson(doc2, base);
        for (JsonObject s : doc2["servos"].as<JsonArray>())
            if (static_cast<int>(s["pcaBoard"] | 0) == 0) s["i2cBus"] = 1;
        std::string body2;
        serializeJson(doc2, body2);
        Profile p2;
        CHECK(parse(body2, p2), "second-bus profile (no SDA2) parses");
        CHECK(!ProfileValidator::isActivatable(p2),
              "second bus without SDA2/SCL2 is rejected");
    }

    // Physical power/safety declarations (HardwareNotes): documentation-only, but
    // they must survive the flat interchange round-trip AND the split slot form,
    // and default to "not declared" on a profile that predates the block.
    {
        std::printf("hardware notes round-trip\n");
        std::string base = slurp(root + "/instrument-profiles/ukulele-gcea.json");
        Profile p;
        CHECK(parse(base, p), "base profile parses");
        CHECK(!p.hardware.oePullup && !p.hardware.estopCutsPower &&
                  p.hardware.pcaPullups.empty(),
              "absent hardware block defaults to not-declared");
        p.hardware.oePullup = true;
        p.hardware.oeGate = true;
        p.hardware.estopCutsPower = true;
        p.hardware.mainSwitch = true;
        p.hardware.mainFuse = true;
        p.hardware.branchFuses = true;
        p.hardware.servoStallMa = 1200;
        p.hardware.extPullupOhm0 = 4700;
        p.hardware.pcaPullups.push_back({0, 0, 10000});
        p.hardware.pcaPullups.push_back({0, 1, 0});  // pull-ups removed on board 1

        JsonDocument out;
        ProfileStorage::toJson(p, out);
        std::string reser;
        serializeJson(out, reser);
        Profile rt;
        CHECK(parse(reser, rt), "hardware-notes profile re-parses");
        CHECK(rt.hardware.oePullup && rt.hardware.oeGate && rt.hardware.estopCutsPower &&
                  rt.hardware.mainSwitch && rt.hardware.mainFuse && rt.hardware.branchFuses,
              "declaration flags round-trip");
        CHECK(rt.hardware.servoStallMa == 1200 && rt.hardware.extPullupOhm0 == 4700,
              "estimator numbers round-trip");
        CHECK(rt.hardware.pcaPullups.size() == 2 && rt.hardware.pcaPullups[1].ohm == 0,
              "per-board pull-up notes round-trip");

        JsonDocument slot;  // split on-disk form must carry the block too
        ProfileStorage::toSlotJson(p, slot);
        CHECK(slot["device"]["hardware"]["oePullup"].as<bool>(),
              "hardware notes live in the device section of a slot");
        Profile sp;
        CHECK(ProfileStorage::fromSlotJson(slot.as<JsonVariantConst>(), sp),
              "split slot re-parses");
        CHECK(sp.hardware.branchFuses && sp.hardware.pcaPullups.size() == 2,
              "hardware notes survive the slot round-trip");
    }

    // P1.12: an old (v1) profile fixture must import → migrate → validate → export →
    // round-trip cleanly. The v1 fixture carries the legacy network.staticIp key that
    // v2 dropped; migrate() must remove it and stamp the current version, and the
    // migrated profile must still be activatable and survive a full round trip.
    {
        std::printf("profile v1 -> v2 migration\n");
        std::string raw = slurp(root + "/firmware/test/fixtures/profile-v1-ukulele.json");
        CHECK(!raw.empty(), "v1 fixture is readable");
        JsonDocument doc;
        CHECK(deserializeJson(doc, raw) == DeserializationError::Ok, "v1 fixture parses");
        // Pre-migration: it really is an old profile with the legacy key.
        CHECK((doc["profileVersion"] | 1) == 1, "fixture is stored as v1");
        CHECK(doc["network"]["staticIp"].is<bool>(), "fixture carries the legacy staticIp");

        ProfileStorage::migrate(doc);  // the upgrade step every load/import runs
        CHECK((doc["profileVersion"] | 0) == kCurrentProfileVersion,
              "migrate stamps the current version");
        CHECK(doc["network"]["staticIp"].isNull(), "migrate drops the legacy staticIp");

        Profile mig;
        CHECK(ProfileStorage::fromJson(doc.as<JsonVariantConst>(), mig),
              "migrated profile parses");
        CHECK(mig.profileVersion == kCurrentProfileVersion, "in-memory version is current");
        CHECK(ProfileValidator::isActivatable(mig), "migrated profile is activatable");

        // Export → re-parse: a migrated profile round-trips at the current version.
        JsonDocument out;
        ProfileStorage::toJson(mig, out);
        std::string reser;
        serializeJson(out, reser);
        Profile rt;
        CHECK(parse(reser, rt), "migrated profile re-parses");
        CHECK(rt.profileVersion == kCurrentProfileVersion, "exported version is current");
        CHECK(rt.strings.size() == mig.strings.size(), "strings survive the migration round-trip");

        // migrate() is idempotent: a profile already at the current version is untouched.
        JsonDocument cur;
        deserializeJson(cur, reser);
        ProfileStorage::migrate(cur);
        CHECK((cur["profileVersion"] | 0) == kCurrentProfileVersion,
              "re-migrating a current profile leaves the version unchanged");
    }

    // P1.13: the on-disk SLOT format splits the profile into device/instrument
    // sections. It must (a) actually be split on disk, (b) round-trip a profile
    // losslessly through the split, and (c) still read a LEGACY flat slot (the
    // pre-split on-disk form, incl. an old v1 one) so no stored profile is orphaned.
    {
        std::printf("device/instrument split slot storage\n");
        std::string base = slurp(root + "/instrument-profiles/guitar-standard.json");
        Profile p;
        CHECK(parse(base, p), "base profile loads (interchange form)");

        // (a) toSlotJson produces the SPLIT on-disk shape, not the flat one.
        JsonDocument slot;
        ProfileStorage::toSlotJson(p, slot);
        CHECK(std::string(slot["storageFormat"] | "") == "gmb-split-v1",
              "slot carries the split storage marker");
        CHECK(slot["device"]["board"].is<JsonObjectConst>(), "device.board present");
        CHECK(slot["device"]["network"].is<JsonObjectConst>(), "device.network present");
        CHECK(slot["device"]["pins"].is<JsonArrayConst>(), "device.pins present");
        CHECK(slot["instrument"]["info"]["name"].is<const char*>(),
              "instrument.info.name present");
        CHECK(slot["instrument"]["servos"].is<JsonArrayConst>(), "instrument.servos present");
        // The flat top-level keys must be GONE — proof it is genuinely re-parented,
        // not merely additive (which would double the file and desync).
        CHECK(slot["board"].isNull() && slot["servos"].isNull() && slot["network"].isNull(),
              "no flat top-level device/instrument keys remain");

        // (b) Serialise as a file would, then read back through the slot path: lossless.
        std::string ondisk;
        serializeJson(slot, ondisk);
        Profile p2;
        CHECK(parseSlot(ondisk, p2), "split slot re-parses through fromSlotJson");
        CHECK(p2.instrument.name == p.instrument.name, "instrument name survives the split");
        CHECK(p2.strings.size() == p.strings.size(), "string count survives the split");
        CHECK(p2.servos.size() == p.servos.size(), "servo count survives the split");
        CHECK(p2.boardIdentifier == p.boardIdentifier, "device board survives the split");
        CHECK(p2.network.ssid == p.network.ssid, "device network survives the split");
        CHECK(p2.pins.size() == p.pins.size(), "device pins survive the split");
        bool servoOk = p2.servos.size() == p.servos.size();
        for (size_t k = 0; servoOk && k < p.servos.size(); ++k)
            servoOk = p2.servos[k].channel == p.servos[k].channel &&
                      p2.servos[k].function == p.servos[k].function;
        CHECK(servoOk, "per-servo channel/function survive the split");

        // (c1) A LEGACY flat slot (the interchange form written to disk before the
        // split existed) must still load through the slot path unchanged.
        Profile p3;
        CHECK(parseSlot(base, p3), "legacy flat slot still loads via fromSlotJson");
        CHECK(p3.servos.size() == p.servos.size(), "legacy flat slot yields the same profile");

        // (c2) An even older v1 flat slot must load AND migrate through the slot path
        // (the staticIp cleanup runs inside fromSlotJson's legacy branch).
        std::string v1 = slurp(root + "/firmware/test/fixtures/profile-v1-ukulele.json");
        if (!v1.empty()) {
            Profile p4;
            CHECK(parseSlot(v1, p4), "legacy v1 flat slot loads+migrates via fromSlotJson");
            CHECK(ProfileValidator::isActivatable(p4), "migrated legacy slot is activatable");
        }
    }

    std::printf(g_fail ? "\nPROFILECHECK FAILED (%d)\n" : "\nprofilecheck OK\n", g_fail);
    return g_fail ? 1 : 0;
}
