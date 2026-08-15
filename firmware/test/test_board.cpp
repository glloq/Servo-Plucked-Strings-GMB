#include "TestFramework.h"
#include "../src/core/board/BoardProfile.h"
#include "../src/core/board/PinManager.h"

using namespace gmb;

// Reserved pins stay red (unchanged from the board description).
TEST(board_reserved_pins_are_red) {
    BoardProfile b = makeEsp32S3DevKitC1();
    for (int8_t g : {0, 3, 19, 20, 43, 44, 45, 46, 48}) {
        const PinCapability* p = b.find(g);
        CHECK(p != nullptr);
        CHECK(p->reserved);
        CHECK(p->preference == PinPreference::Reserved);
    }
    // USB pins flagged.
    CHECK(b.find(19)->usb);
    CHECK(b.find(20)->usb);
}

// Candidate pins for a servo/OE output exclude reserved and USB pins.
TEST(board_servo_candidates_exclude_reserved) {
    BoardProfile b = makeEsp32S3DevKitC1();
    for (SignalKind k : {SignalKind::ServoOe, SignalKind::Generic}) {
        auto cands = b.candidatesFor(k);
        CHECK(!cands.empty());
        for (const PinCapability* p : cands) {
            CHECK(!p->reserved);
            CHECK(p->output);
            CHECK(p->gpio != 19 && p->gpio != 20);
        }
    }
}

// Auto-assignment now places only the PCA9685 I2C bus + /OE safety line: no
// stepper STEP/DIR/HOME/ENABLE signals exist any more.
TEST(auto_assign_places_i2c_and_oe_only) {
    BoardProfile b = makeEsp32S3DevKitC1();
    PinManager pm(b);
    PinRequest req;
    req.stringCount = 6;
    CHECK(pm.autoAssign(req));
    CHECK_EQ(pm.gpioOf("SDA"), 40);
    CHECK_EQ(pm.gpioOf("SCL"), 41);
    CHECK_EQ(pm.gpioOf("SERVO_OE"), 47);
    // No stepper signals are assigned.
    CHECK_EQ(pm.gpioOf("STEP1"), kNoPin);
    CHECK_EQ(pm.gpioOf("DIR1"), kNoPin);
    CHECK_EQ(pm.gpioOf("HOME1"), kNoPin);
    CHECK_EQ(pm.gpioOf("ENABLE"), kNoPin);
    // A clean auto-assignment must validate.
    CHECK(pm.validate(true).empty());
}

TEST(duplicate_pin_is_rejected) {
    BoardProfile b = makeEsp32S3DevKitC1();
    PinManager pm(b);
    pm.assign("SDA", SignalKind::I2cSda, 40);
    pm.assign("SCL", SignalKind::I2cScl, 40);  // conflict on the same GPIO
    auto errs = pm.validate(true);
    CHECK(!errs.empty());
    bool foundConflict = false;
    for (auto& e : errs)
        if (!e.conflictWith.empty()) foundConflict = true;
    CHECK(foundConflict);
}

TEST(usb_pin_rejected_when_reserved) {
    BoardProfile b = makeEsp32S3DevKitC1();
    PinManager pm(b);
    pm.assign("SERVO_OE", SignalKind::ServoOe, 19);  // USB pin
    CHECK(!pm.validate(true).empty());
}

TEST(servo_oe_on_reserved_pin_rejected) {
    BoardProfile b = makeEsp32S3DevKitC1();
    PinManager pm(b);
    // GPIO26 is a reserved flash pin — not a valid output.
    pm.assign("SERVO_OE", SignalKind::ServoOe, 26);
    CHECK(!pm.validate(true).empty());
}

// Signal kind is inferred from the signal name (fixes lost kind on import). The
// stepper names no longer map to dedicated kinds — they fall through to Generic.
TEST(signal_kind_from_name) {
    CHECK(signalKindFromName("SDA") == SignalKind::I2cSda);
    CHECK(signalKindFromName("SCL") == SignalKind::I2cScl);
    CHECK(signalKindFromName("SERVO_OE") == SignalKind::ServoOe);
    CHECK(signalKindFromName("ENABLE") == SignalKind::Enable);
    CHECK(signalKindFromName("ESTOP") == SignalKind::SafetyInput);
    CHECK(signalKindFromName("STEP1") == SignalKind::Generic);
    CHECK(signalKindFromName("MYSTERY") == SignalKind::Generic);
}

// ---- ESP32-S3-DevKitC-1 board revisions ------------------------------------
// The two revisions differ only in where the on-board RGB LED sits: GPIO48 on the
// original (v1.0) board, GPIO38 on v1.1 (Espressif user guide). The LED pin must
// be reserved and the other one free, per revision.
TEST(s3_devkitc1_revisions_swap_rgb_led_pin) {
    BoardProfile v10 = makeEsp32S3DevKitC1();
    CHECK(v10.identifier == "esp32-s3-devkitc-1");
    CHECK(v10.find(48)->reserved);
    CHECK(v10.find(48)->onboardPeripheral);
    CHECK(!v10.find(38)->reserved);
    CHECK(v10.supports(38, SignalKind::I2cSda));   // free for SDA2 on v1.0

    BoardProfile v11 = makeEsp32S3DevKitC1V11();
    CHECK(v11.identifier == "esp32-s3-devkitc-1-v1.1");
    CHECK(v11.find(38)->reserved);
    CHECK(v11.find(38)->onboardPeripheral);
    CHECK(!v11.find(48)->reserved);
    CHECK(v11.supports(48, SignalKind::Generic));
    CHECK(!v11.supports(38, SignalKind::I2cSda));  // the v1.1 LED pin carries nothing

    // Same header otherwise: every other pin has identical capability flags.
    CHECK_EQ((int)v10.pins.size(), (int)v11.pins.size());
    for (const auto& p : v10.pins) {
        if (p.gpio == 38 || p.gpio == 48) continue;
        const PinCapability* q = v11.find(p.gpio);
        CHECK(q != nullptr);
        CHECK(q->reserved == p.reserved);
        CHECK(q->preference == p.preference);
    }
}

// ---- hardware E-stop input (`ESTOP` -> SignalKind::SafetyInput) -------------
// A safety input needs a readable, interrupt-capable pin WITH a usable internal
// pull-up (the firmware samples ESTOP as INPUT_PULLUP — a pin without one would
// float), and must never sit on a strapping pin (the recommended NC loop idles
// the pin LOW through boot/reset).
TEST(safety_input_candidates_and_validation) {
    BoardProfile b = makeEsp32S3DevKitC1();
    // A plain recommended IO carries it.
    CHECK(b.supports(2, SignalKind::SafetyInput));
    // Reserved / strapping / USB pins never do.
    for (int8_t g : {0, 3, 19, 20, 45, 46, 48}) CHECK(!b.supports(g, SignalKind::SafetyInput));
    for (const PinCapability* c : b.candidatesFor(SignalKind::SafetyInput)) {
        CHECK(c->input);
        CHECK(c->interrupt);
        CHECK(c->internalPullUp);
        CHECK(!c->strapping);
        CHECK(!c->reserved);
    }
    // PinManager accepts a valid ESTOP assignment and rejects a reserved pin.
    PinManager pm(b);
    pm.assign("ESTOP", SignalKind::SafetyInput, 2);
    CHECK(pm.validate(true).empty());
    pm.clear();
    pm.assign("ESTOP", SignalKind::SafetyInput, 48);  // v1.0 RGB LED pin
    CHECK(!pm.validate(true).empty());

    // On the classic ESP32, the input-only pins (34/35/36/39) have NO internal
    // pull-up, so INPUT_PULLUP cannot bias them and the E-stop input would float:
    // they are refused even though they can read (audit P1 — the firmware
    // validator is the authority, whatever the UI shows). Strapping pins (e.g.
    // MTDI GPIO12) are refused too.
    BoardProfile w = makeEsp32Wroom32();
    for (int8_t g : {34, 35, 36, 39}) CHECK(!w.supports(g, SignalKind::SafetyInput));
    CHECK(!w.supports(12, SignalKind::SafetyInput));
    // A regular classic-ESP32 IO still qualifies.
    CHECK(w.supports(26, SignalKind::SafetyInput));
}

// ---- classic ESP32 boards (WROOM-32 / DevKit v1) --------------------------

TEST(builtin_profiles_resolved_by_id) {
    CHECK(builtinBoardProfile("esp32-s3-devkitc-1") != nullptr);
    CHECK(builtinBoardProfile("esp32-wroom-32") != nullptr);
    CHECK(builtinBoardProfile("esp32-devkit-v1") != nullptr);
    CHECK(builtinBoardProfile("no-such-board") == nullptr);
}

// The classic ESP32 has input-only pins (34/35/36/39): usable as inputs but never
// as outputs, so they can carry none of our (output) signals.
TEST(wroom_input_only_pins_cannot_output) {
    BoardProfile b = makeEsp32Wroom32();
    for (int8_t g : {34, 35, 36, 39}) {
        const PinCapability* p = b.find(g);
        CHECK(p != nullptr);
        CHECK(p->input);
        CHECK(!p->output);
        CHECK(!b.supports(g, SignalKind::ServoOe));
        CHECK(!b.supports(g, SignalKind::I2cSda));
        CHECK(!b.supports(g, SignalKind::Generic));
    }
    // GPIO 20 / 24 do not exist on the classic ESP32.
    CHECK(b.find(20) == nullptr);
    CHECK(b.find(24) == nullptr);
    // The recommended I2C pins are usable both ways.
    CHECK(b.supports(21, SignalKind::I2cSda));
    CHECK(b.supports(22, SignalKind::I2cScl));
    CHECK(b.supports(23, SignalKind::ServoOe));
}

// The 30-pin DevKit v1 does not break out the SPI-flash pads (6..11).
TEST(devkitv1_omits_flash_pins) {
    BoardProfile b = makeEsp32DevKitV1();
    for (int g = 6; g <= 11; ++g) CHECK(b.find(static_cast<int8_t>(g)) == nullptr);
    // Still a full classic-ESP32 otherwise.
    CHECK(b.find(21) != nullptr);
    CHECK(b.find(34) != nullptr);
}

// P1.15: GPIO0 is the BOOT button (forces the Wi-Fi hotspot) on every ESP32 dev
// board — the firmware samples it as an input the whole time — so it must never be
// selectable for a servo / I2C / /OE line: reserved on all three profiles, absent
// from every candidate list, and rejected by the validator when hand-assigned.
TEST(gpio0_boot_button_reserved_on_all_boards) {
    for (const BoardProfile& b :
         {makeEsp32S3DevKitC1(), makeEsp32Wroom32(), makeEsp32DevKitV1()}) {
        const PinCapability* p = b.find(0);
        CHECK(p != nullptr);
        CHECK(p->reserved);
        CHECK(p->preference == PinPreference::Reserved);
        // Carries none of our (output) signals.
        CHECK(!b.supports(0, SignalKind::ServoOe));
        CHECK(!b.supports(0, SignalKind::I2cSda));
        CHECK(!b.supports(0, SignalKind::Generic));
        // Never offered as an auto-assign candidate.
        for (SignalKind k : {SignalKind::ServoOe, SignalKind::I2cSda, SignalKind::Generic})
            for (const PinCapability* c : b.candidatesFor(k))
                CHECK(c->gpio != 0);
        // An explicit SERVO_OE (or direct servo) on GPIO0 is rejected.
        PinManager pm(b);
        pm.assign("SERVO_OE", SignalKind::ServoOe, 0);
        CHECK(!pm.validate(true).empty());
    }
}

// Auto-assign on a classic ESP32 places I2C + /OE on real output pins.
TEST(wroom_auto_assign_places_valid_pins) {
    BoardProfile b = makeEsp32Wroom32();
    PinManager pm(b);
    PinRequest req;
    req.stringCount = 4;
    CHECK(pm.autoAssign(req));
    for (const char* sig : {"SDA", "SCL", "SERVO_OE"}) {
        int8_t g = pm.gpioOf(sig);
        CHECK(g != kNoPin);
        const PinCapability* p = b.find(g);
        CHECK(p != nullptr);
        CHECK(p->output);
        CHECK(!p->reserved);
    }
    CHECK(pm.validate(true).empty());
}
