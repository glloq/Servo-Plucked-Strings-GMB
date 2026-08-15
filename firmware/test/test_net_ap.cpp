// Firmware audit P1 — the access point must come up WITHOUT blocking loop().
//
// Net::startAccessPoint() used to be:
//
//     WiFi.mode(WIFI_AP);
//     delay(100);              // <-- inside a path reachable from tick()
//     WiFi.softAP(...);
//
// and tick() runs in loop(), which is also where the E-stop is polled. A station
// fallback, a forced hotspot or a softAP retry therefore stalled the safety poll
// for a tenth of a second — on exactly the frames where the network was already
// misbehaving. The wait is a timestamped two-step FSM now:
//
//     startAccessPoint(now)  -> mode set, apPending
//     tick(now + <100 ms)    -> still pending, returns immediately
//     tick(now + >=100 ms)   -> softAP() issued, AP live
//
// These tests run the host build, so the WiFi calls are compiled out and what is
// exercised is the STATE MACHINE and, above all, the promise that no call takes
// wall-clock time.
#include "TestFramework.h"

#include <chrono>

#include "../src/platform/esp32/Net.h"

using namespace gmb;

namespace {

NetworkConfig apCfg() {
    NetworkConfig c;
    c.mode = NetworkMode::AccessPoint;
    c.apSsid = "GMB-Test";
    c.hostname = "gmb-test";
    return c;
}

// Wall-clock cost of a callable, in milliseconds.
template <typename F>
double elapsedMs(F&& f) {
    auto t0 = std::chrono::steady_clock::now();
    f();
    auto t1 = std::chrono::steady_clock::now();
    return std::chrono::duration<double, std::milli>(t1 - t0).count();
}

}  // namespace

TEST(net_access_point_start_is_not_immediate_and_never_blocks) {
    Net n;
    // begin() arms the bring-up; it must NOT sit on a delay to do it.
    double ms = elapsedMs([&] { n.begin(apCfg(), "", ""); });
    CHECK(ms < 20.0);  // the old code spent >= 100 ms here

    // Armed, but the AP is not up yet — and nothing may claim it is.
    CHECK(n.accessPointPending());
    CHECK(!n.accessPointActive());
    CHECK(!n.connected());
}

TEST(net_access_point_completes_after_the_settle_window) {
    Net n;
    n.begin(apCfg(), "", "");
    CHECK(n.accessPointPending());

    // Ticks inside the window change nothing (and cost nothing).
    double ms = elapsedMs([&] {
        n.tick(1);
        n.tick(50);
        n.tick(99);
    });
    CHECK(ms < 20.0);
    CHECK(n.accessPointPending());
    CHECK(!n.accessPointActive());

    // The first tick past the window raises the AP.
    n.tick(100);
    CHECK(!n.accessPointPending());
    CHECK(n.accessPointActive());
    CHECK(n.connected());
    CHECK(n.mode() == "accessPoint");
}

TEST(net_forced_hotspot_is_also_non_blocking) {
    Net n;
    n.begin(apCfg(), "", "");
    n.tick(100);
    CHECK(n.accessPointActive());

    // A BOOT-button / web "Start hotspot" from the middle of loop(): same rule.
    double ms = elapsedMs([&] { n.forceAccessPoint(1000); });
    CHECK(ms < 20.0);
    CHECK(n.accessPointPending());
    CHECK(!n.accessPointActive());  // down while it restarts — reported honestly

    n.tick(1050);
    CHECK(n.accessPointPending());
    n.tick(1100);
    CHECK(n.accessPointActive());
}

TEST(net_tick_yields_while_the_access_point_is_settling) {
    Net n;
    n.begin(apCfg(), "", "");
    // A tick during the settle window must return promptly and leave the radio
    // alone: the whole point is that loop() gets the frame back for the E-stop.
    for (uint32_t t = 0; t < 100; t += 10) {
        double ms = elapsedMs([&] { n.tick(t); });
        CHECK(ms < 20.0);
        CHECK(!n.accessPointActive());
    }
    n.tick(100);
    CHECK(n.accessPointActive());
}

TEST(net_rebegin_cancels_a_pending_access_point) {
    Net n;
    n.begin(apCfg(), "", "");
    CHECK(n.accessPointPending());

    // New device settings arrive (POST /api/wifi) before the AP finished coming
    // up: the stale bring-up must not fire later and stamp on the new config.
    NetworkConfig sta;
    sta.mode = NetworkMode::Station;
    sta.ssid = "Workshop";
    sta.hostname = "gmb-test";
    n.begin(sta, "secret", "");
    CHECK(!n.accessPointPending());
    n.tick(500);
    CHECK(!n.accessPointActive());
}
