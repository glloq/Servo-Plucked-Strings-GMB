// Audit 7: the controlled park REPORTS failures (ParkResult) instead of being
// fire-and-forget — arming / a profile swap must abort when a rest command never
// reached a servo, because "the fingers lifted" can then not be assumed. Uses the
// host-only write-fault hook (the native build has no hardware able to refuse a
// write, so failure paths need injection).
#include "TestFramework.h"

#include "../src/platform/esp32/ServoBank.h"

using namespace gmb;

namespace {

ServoConfig parkServo(const char* fn, int str) {
    ServoConfig s;
    s.enabled = true;
    s.function = fn;
    s.stringIndex = static_cast<int8_t>(str);
    s.source = ServoSource::Pca;
    s.pcaBoard = 0;
    s.channel = static_cast<uint8_t>(str);
    s.pulseMinUs = 500;
    s.pulseMaxUs = 2500;
    s.restUs = 1500;
    s.activeUs = 1900;
    s.travelMs = 80;
    s.settleMs = 20;
    return s;
}

}  // namespace

TEST(servobank_park_ok_and_disabled_skipped) {
    ServoBank b;
    std::vector<ServoConfig> sv = {parkServo("finger", 0), parkServo("pluck", 0),
                                   parkServo("finger", 1)};
    sv[1].enabled = false;  // disabled: never driven, so never a park failure
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);
    ServoBank::ParkResult r = b.moveAllToRest();
    CHECK(r.ok);
    CHECK_EQ(r.failedServo, -1);
    CHECK(r.reason == ActuatorResult::Ok);
    CHECK_EQ((int)b.lastCommandedUs(0), 1500);  // enabled servos commanded to rest
    CHECK_EQ((int)b.lastCommandedUs(2), 1500);
    CHECK_EQ((int)b.lastCommandedUs(1), 0);     // the disabled one was left alone
}

TEST(servobank_park_reports_first_failure) {
    ServoBank b;
    std::vector<ServoConfig> sv = {parkServo("finger", 0), parkServo("finger", 1),
                                   parkServo("pluck", 1)};
    b.begin(sv, -1, -1, -1);
    b.outputEnable(true);
    // Servos 1 AND 2 refuse their write: the report must carry the FIRST one.
    b.hostWriteResult = [](int idx) {
        return idx >= 1 ? ActuatorResult::OutputFault : ActuatorResult::Ok;
    };
    ServoBank::ParkResult r = b.moveAllToRest();
    CHECK(!r.ok);
    CHECK_EQ(r.failedServo, 1);
    CHECK(r.reason == ActuatorResult::OutputFault);

    // With the fault gone the same bank parks cleanly again.
    b.hostWriteResult = nullptr;
    ServoBank::ParkResult r2 = b.moveAllToRest();
    CHECK(r2.ok);
}
