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
    CHECK(signalKindFromName("STEP1") == SignalKind::Generic);
    CHECK(signalKindFromName("MYSTERY") == SignalKind::Generic);
}
