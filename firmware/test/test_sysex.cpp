#include "TestFramework.h"
#include "../src/core/configuration/Profile.h"
#include "../src/core/gmb/Capabilities.h"
#include "../src/core/gmb/GmbDescriptor.h"
#include "../src/core/gmb/GmbSysEx.h"
#include "../src/core/gmb/GmbSysExService.h"

using namespace gmb;

static Profile guitarProfile() {
    return Profile::makeDefault("Guitar", 6, {40, 45, 50, 55, 59, 64}, 12);
}

// Acceptance criteria 5, 6, 7 (SysEx spec 24): range, polyphony, CCs.
TEST(snapshot_range_polyphony_and_cc) {
    Profile p = guitarProfile();
    CapabilitySnapshot s = buildSnapshot(p);
    CHECK(s.valid);
    // Standard guitar has a continuous playable range 40..76.
    CHECK_EQ((int)s.capabilities.noteMode, 0);
    CHECK_EQ((int)s.capabilities.noteMin, 40);
    CHECK_EQ((int)s.capabilities.noteMax, 76);
    // Polyphony = active strings.
    CHECK_EQ((int)s.capabilities.polyphony, 6);
    // Announced CCs include the configured selectors (20/21) and standards.
    auto has = [&](uint8_t cc) {
        for (uint8_t x : s.capabilities.supportedCc)
            if (x == cc) return true;
        return false;
    };
    CHECK(has(7));
    CHECK(has(11));
    CHECK(has(20));
    CHECK(has(21));
    CHECK(has(64));
    CHECK(has(120));
    CHECK(has(123));
}

// Discrete-note mode when a gap exists (SysEx spec 5.2).
TEST(snapshot_discrete_notes_when_gap) {
    // Two strings far apart with 0 frets: only two isolated notes.
    Profile p = Profile::makeDefault("Sparse", 2, {40, 80}, 0);
    CapabilitySnapshot s = buildSnapshot(p);
    CHECK_EQ((int)s.capabilities.noteMode, 1);
    CHECK_EQ((int)s.capabilities.discreteNotes.size(), 2);
}

// Custom CCs are announced instead of the defaults (SysEx spec section 7).
TEST(snapshot_custom_cc_announced) {
    Profile p = guitarProfile();
    p.selector.string.ccNumber = 24;
    p.selector.fret.ccNumber = 25;
    CapabilitySnapshot s = buildSnapshot(p);
    auto has = [&](uint8_t cc) {
        for (uint8_t x : s.capabilities.supportedCc)
            if (x == cc) return true;
        return false;
    };
    CHECK(has(24));
    CHECK(has(25));
    CHECK(!has(20));
    CHECK(!has(21));
}

// Block 1 identity encoding shape (SysEx spec 4.1).
TEST(block1_identity_encoding) {
    Profile p = guitarProfile();
    CapabilitySnapshot s = buildSnapshot(p);
    auto m = GmbSysEx::encodeIdentity(s);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK_EQ((int)m[0], 0xF0);
    CHECK_EQ((int)m[1], 0x7D);
    CHECK_EQ((int)m[2], 0x00);
    CHECK_EQ((int)m[3], 0x01);  // block 1
    CHECK_EQ((int)m[4], 0x01);  // response
    CHECK_EQ((int)m.back(), 0xF7);
    // 5 header + version + 5 id + 32 name + 3 fw + 5 features + end = 52.
    CHECK_EQ((int)m.size(), 52);
}

// Block 6 request -> response round trip; all bytes 7-bit (SysEx spec 4.3).
TEST(block6_request_response) {
    Profile p = guitarProfile();
    CapabilitySnapshot s = buildSnapshot(p);
    uint8_t req[] = {0xF0, 0x7D, 0x00, 0x06, 0x00, 0x00, 0xF7};
    SysExRequest r = GmbSysEx::parseRequest(req, sizeof(req));
    CHECK(r.valid);
    CHECK_EQ((int)r.block, 6);
    CHECK(r.hasChannel);
    auto resp = GmbSysEx::respond(r, s);
    CHECK(GmbSysEx::isWellFormed(resp.data(), resp.size()));
    CHECK_EQ((int)resp[3], 0x06);
}

// Block 7 v1 tuning is announced in physical string order (this profile is
// already ascending, so positional == low->high here). Order is asserted more
// strictly by sx2_tuning_positional_not_sorted below.
TEST(block7_tuning_low_to_high) {
    Profile p = guitarProfile();
    CapabilitySnapshot s = buildSnapshot(p);
    auto m = GmbSysEx::encodeStringConfigV1(s);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    // Layout: F0 7D 00 07 01 | ver ch nStr nFret fretless capo ccAct ccStr ccFret | tuning...
    size_t tuningStart = 5 + 9;
    CHECK_EQ((int)m[tuningStart + 0], 40);
    CHECK_EQ((int)m[tuningStart + 5], 64);
    CHECK_EQ((int)m[5 + 2], 6);   // string count
    CHECK_EQ((int)m[5 + 7], 20);  // ccString
    CHECK_EQ((int)m[5 + 8], 21);  // ccFret
}

// Block 7 v2 encodes signed offsets as offset+64 (SysEx spec 10.4).
TEST(block7_v2_signed_offset) {
    Profile p = guitarProfile();
    p.selector.string.offset = -3;
    p.selector.fret.offset = 5;
    CapabilitySnapshot s = buildSnapshot(p);
    auto m = GmbSysEx::encodeStringConfigV2(s);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK_EQ((int)m[5], 0x02);  // version 2
    // ...channel,nStr,nFret,fretless,capo,ccAct,ccStr,ccFret (8) then
    // ccStrMin,ccStrMax,ccStrOff(+64)
    size_t base = 5 + 1 + 8;
    CHECK_EQ((int)m[base + 2], 64 - 3);  // string offset -3 -> 61
    CHECK_EQ((int)m[base + 5], 64 + 5);  // fret offset +5 -> 69
}

// Block 8 notification carries a decodable revision (SysEx spec section 11/13).
TEST(block8_notification_revision) {
    Profile p = guitarProfile();
    p.capabilitiesRevision = 300;  // > 127, needs multi-byte encoding
    CapabilitySnapshot s = buildSnapshot(p);
    auto m = GmbSysEx::encodeNotification(s, kStringConfigChanged | kCcMappingChanged);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK_EQ((int)m[3], 0x08);  // block 8
    CHECK_EQ((int)m[4], 0x02);  // spontaneous notification
    // Decode 5x7-bit revision (big-endian) starting after ver+channel.
    size_t revStart = 5 + 1 + 1;
    uint32_t rev = 0;
    for (int i = 0; i < 5; ++i) rev = (rev << 7) | m[revStart + i];
    CHECK_EQ((int)rev, 300);
}

// Robustness: malformed / non-7-bit messages are rejected (SysEx spec 20).
TEST(sysex_rejects_malformed) {
    uint8_t noStart[] = {0x00, 0x7D, 0x00, 0x06, 0x00, 0xF7};
    CHECK(!GmbSysEx::isWellFormed(noStart, sizeof(noStart)));
    uint8_t highBit[] = {0xF0, 0x7D, 0x00, 0x06, 0x00, 0x80, 0xF7};  // 0x80 invalid
    CHECK(!GmbSysEx::isWellFormed(highBit, sizeof(highBit)));
    uint8_t wrongMfr[] = {0xF0, 0x7E, 0x00, 0x06, 0x00, 0x00, 0xF7};
    CHECK(!GmbSysEx::isWellFormed(wrongMfr, sizeof(wrongMfr)));
    // Unknown block: parseRequest returns invalid.
    uint8_t unknown[] = {0xF0, 0x7D, 0x00, 0x63, 0x00, 0xF7};
    SysExRequest r = GmbSysEx::parseRequest(unknown, sizeof(unknown));
    auto resp = GmbSysEx::respond(r, buildSnapshot(guitarProfile()));
    CHECK(resp.empty());
}

// ============================ GMB v2 (descriptor) ============================

// A string with no finger servo on some frets is NOT contiguous: the range must
// switch to discrete and exclude the unwired frets (audit SX-1).
static Profile gappedString() {
    Profile p = Profile::makeDefault("Gapped", 1, {60}, 5);  // fingers on frets 1..5
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "finger" && (it->fret == 3 || it->fret == 4))
            it = p.servos.erase(it);
        else
            ++it;
    }
    return p;
}

TEST(sx1_discrete_excludes_unwired_frets) {
    CapabilitySnapshot s = buildSnapshot(gappedString());
    CHECK_EQ((int)s.capabilities.noteMode, 1);  // frets 3,4 missing -> discrete
    auto in = [&](int n) {
        for (uint8_t x : s.capabilities.discreteNotes)
            if (x == n) return true;
        return false;
    };
    CHECK(in(60));   // open
    CHECK(in(61));   // fret 1
    CHECK(in(62));   // fret 2
    CHECK(in(65));   // fret 5
    CHECK(!in(63));  // fret 3 has no servo
    CHECK(!in(64));  // fret 4 has no servo
}

// A string with maxFret > 0 but NO finger servos plays only its open note; the
// range must NOT advertise the whole span (the allocator's fretMask==0 sentinel
// bug does not leak into the announced capabilities).
TEST(sx1_no_finger_string_is_open_only) {
    Profile p = Profile::makeDefault("Open", 1, {60}, 5);
    for (auto it = p.servos.begin(); it != p.servos.end();) {
        if (it->function == "finger") it = p.servos.erase(it);
        else ++it;
    }
    CapabilitySnapshot s = buildSnapshot(p);
    CHECK_EQ((int)s.capabilities.noteMin, 60);
    CHECK_EQ((int)s.capabilities.noteMax, 60);  // open only, not 60..65
    CHECK_EQ((int)s.stringConfig.tuning.size(), 1);
}

// Tuning is announced in physical string order, aligned with fretsPerString — NOT
// sorted (audit SX-2), otherwise tuning[i] and fretsPerString[i] describe
// different strings.
TEST(sx2_tuning_positional_not_sorted) {
    Profile p = Profile::makeDefault("Desc", 3, {64, 60, 67}, 5);
    CapabilitySnapshot s = buildSnapshot(p);
    CHECK_EQ((int)s.stringConfig.tuning.size(), 3);
    CHECK_EQ((int)s.stringConfig.tuning[0], 64);
    CHECK_EQ((int)s.stringConfig.tuning[1], 60);
    CHECK_EQ((int)s.stringConfig.tuning[2], 67);
    CHECK_EQ((int)s.stringConfig.fretsPerString.size(), 3);
}

// The global transpose is folded into the announced open pitch, so tuning + capo
// reproduces the announced range (audit SX-3).
TEST(sx3_transpose_folded_into_tuning_and_range) {
    Profile p = Profile::makeDefault("Trans", 1, {60}, 5);
    p.instrument.transpose = 2;
    CapabilitySnapshot s = buildSnapshot(p);
    CHECK_EQ((int)s.stringConfig.tuning[0], 62);  // 60 + 2
    CHECK_EQ((int)s.capabilities.noteMin, 62);
    CHECK_EQ((int)s.capabilities.noteMax, 67);  // 62 + 5 frets, all wired
}

// Configurable polyphony: 0 = auto (= active strings); a positive cap lowers it
// and is clamped to the physical string count (audit SX-4).
TEST(sx4_polyphony_max) {
    Profile p = guitarProfile();
    p.instrument.polyphonyMax = 4;
    CHECK_EQ((int)buildSnapshot(p).capabilities.polyphony, 4);
    p.instrument.polyphonyMax = 10;  // clamp to 6 strings
    CHECK_EQ((int)buildSnapshot(p).capabilities.polyphony, 6);
    p.instrument.polyphonyMax = 0;  // auto
    CHECK_EQ((int)buildSnapshot(p).capabilities.polyphony, 6);
}

// The v2 handshake is exactly 24 bytes with proto_ver 0x02, a little-endian
// descriptor_size and revision (matching the GMB DeviceManager decoder).
TEST(v2_handshake_shape) {
    CapabilitySnapshot s = buildSnapshot(guitarProfile());
    s.revision = 300;
    auto m = GmbSysEx::encodeHandshakeV2(s, 512, 0x03);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK_EQ((int)m.size(), 24);
    CHECK_EQ((int)m[3], 0x01);  // block 1
    CHECK_EQ((int)m[4], 0x01);  // response
    CHECK_EQ((int)m[5], 0x02);  // proto_ver v2
    CHECK_EQ((int)m.back(), 0xF7);
    int descSize = m[14] | (m[15] << 7) | (m[16] << 14);
    CHECK_EQ(descSize, 512);
    uint32_t rev = m[17] | (m[18] << 7) | (m[19] << 14) | ((uint32_t)m[20] << 21) |
                   ((uint32_t)(m[21] & 0x0F) << 28);
    CHECK_EQ((int)rev, 300);
    CHECK_EQ((int)m[22], 0x03);  // flags
}

// The descriptor JSON carries the v2 core fields, is 7-bit clean, and reassembles
// from its 0x10 chunks byte-for-byte.
TEST(v2_descriptor_json_and_chunking) {
    CapabilitySnapshot s = buildSnapshot(guitarProfile());
    std::string j = GmbDescriptor::toJson(s);
    CHECK(j.find("\"gmb_descriptor\":2") != std::string::npos);
    CHECK(j.find("\"family\":\"strings\"") != std::string::npos);
    CHECK(j.find("\"string_count\":6") != std::string::npos);
    CHECK(j.find("\"polyphony\":{\"max\":6") != std::string::npos);
    for (char c : j) CHECK((static_cast<unsigned char>(c) & 0x80) == 0);  // 7-bit clean

    size_t total = (j.size() + 199) / 200;
    std::string re;
    for (uint16_t idx = 0; idx < total; ++idx) {
        auto ch = GmbSysEx::encodeDescriptorChunk(j, idx);
        CHECK(GmbSysEx::isWellFormed(ch.data(), ch.size()));
        int t = ch[5] | (ch[6] << 7);
        CHECK_EQ(t, (int)total);
        int i = ch[7] | (ch[8] << 7);
        CHECK_EQ(i, (int)idx);
        for (size_t k = 9; k + 1 < ch.size(); ++k) re += (char)ch[k];  // payload -> F7
    }
    CHECK(re == j);
}

// The v2 change notification is a 12-byte 0x11 frame with a little-endian revision.
TEST(v2_change_notification) {
    CapabilitySnapshot s = buildSnapshot(guitarProfile());
    s.revision = 300;
    auto m = GmbSysEx::encodeChangeNotification(s, 0x02);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK_EQ((int)m.size(), 12);
    CHECK_EQ((int)m[3], 0x11);
    CHECK_EQ((int)m[4], 0x02);
    uint32_t rev = m[5] | (m[6] << 7) | (m[7] << 14) | ((uint32_t)m[8] << 21) |
                   ((uint32_t)(m[9] & 0x0F) << 28);
    CHECK_EQ((int)rev, 300);
    CHECK_EQ((int)m[10], 0x02);
}

// End to end through the service: a Block-1 request now returns the v2 handshake
// (level 1, descriptor_size > 0), and a 0x10 request returns a descriptor segment.
TEST(v2_service_discovery) {
    GmbSysExService svc;
    svc.rebuild(guitarProfile());

    uint8_t id[] = {0xF0, 0x7D, 0x00, 0x01, 0x00, 0xF7};
    auto hs = svc.handleMessage(id, sizeof(id), 1);
    CHECK_EQ((int)hs.size(), 24);
    CHECK_EQ((int)hs[5], 0x02);
    int descSize = hs[14] | (hs[15] << 7) | (hs[16] << 14);
    CHECK(descSize > 0);  // level 1: a descriptor is available
    CHECK_EQ((size_t)descSize, svc.descriptorJson().size());

    uint8_t chunk[] = {0xF0, 0x7D, 0x00, 0x10, 0x00, 0x00, 0x00, 0xF7};
    auto seg = svc.handleMessage(chunk, sizeof(chunk), 2);
    CHECK(seg.size() > 9);
    CHECK_EQ((int)seg[3], 0x10);
    CHECK_EQ((int)seg[4], 0x01);
}

// SX-7: the string/fret selection CCs are announced only when selection is active
// (enabled AND not pure Automatic mode) — never when the firmware would ignore them.
TEST(sx7_selection_cc_only_when_active) {
    auto hasCc = [](const CapabilitySnapshot& s, uint8_t cc) {
        for (uint8_t x : s.capabilities.supportedCc)
            if (x == cc) return true;
        return false;
    };
    Profile hyb = guitarProfile();  // selector enabled, default Hybrid mode
    CapabilitySnapshot sh = buildSnapshot(hyb);
    CHECK(hasCc(sh, 20));
    CHECK(hasCc(sh, 21));
    CHECK_EQ((int)sh.stringConfig.ccActive, 1);

    Profile aut = hyb;
    aut.selector.mode = SelectionMode::Automatic;  // CCs are ignored in this mode
    CapabilitySnapshot sa = buildSnapshot(aut);
    CHECK(!hasCc(sa, 20));
    CHECK(!hasCc(sa, 21));
    CHECK_EQ((int)sa.stringConfig.ccActive, 0);
    CHECK(hasCc(sa, 7));    // standard CCs still announced
    CHECK(hasCc(sa, 120));
}

// SX-6: a very long instrument name is clamped in the (deprecated) capabilities
// block, so the 7-bit length byte stays valid and the message stays bounded.
TEST(sx6_capabilities_name_clamped) {
    Profile p = guitarProfile();
    p.instrument.name = std::string(200, 'X');
    CapabilitySnapshot s = buildSnapshot(p);
    auto m = GmbSysEx::encodeCapabilities(s);
    CHECK(GmbSysEx::isWellFormed(m.data(), m.size()));
    CHECK((int)m.size() <= (int)GmbSysEx::kMaxMessage);
}
