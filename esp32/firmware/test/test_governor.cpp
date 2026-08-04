#include "TestFramework.h"
#include "../src/core/instrument/ServoActivationGovernor.h"

using namespace gmb;

// staggerMs == 0 disables throttling: every request is granted.
TEST(governor_disabled_when_stagger_zero) {
    ServoActivationGovernor g;
    g.configure(1, 0);
    for (int i = 0; i < 10; ++i) CHECK(g.requestStart(0));
}

// maxConcurrent == 1 spaces starts by staggerMs.
TEST(governor_serialises_single_slot) {
    ServoActivationGovernor g;
    g.configure(1, 10);
    CHECK(g.requestStart(1000));    // first: granted
    CHECK(!g.requestStart(1000));   // same instant: denied
    CHECK(!g.requestStart(1005));   // 5 ms later: still within stagger
    CHECK(g.requestStart(1010));    // 10 ms later: granted
    CHECK(!g.requestStart(1011));   // immediately after: denied again
}

// maxConcurrent == 3 lets three starts fire together, then throttles the burst.
TEST(governor_caps_concurrent_burst) {
    ServoActivationGovernor g;
    g.configure(3, 8);
    CHECK(g.requestStart(500));     // 1
    CHECK(g.requestStart(500));     // 2
    CHECK(g.requestStart(500));     // 3 — window now full
    CHECK(!g.requestStart(500));    // 4th in the same 8 ms window: denied
    CHECK(!g.requestStart(507));    // still inside the window relative to #1
    // 8 ms after the burst all three starts have aged out of the window, so three
    // fresh permits are available again — then it is full once more.
    CHECK(g.requestStart(508));
    CHECK(g.requestStart(508));
    CHECK(g.requestStart(508));
    CHECK(!g.requestStart(508));
}

// reset() clears the recent-starts history.
TEST(governor_reset_clears_history) {
    ServoActivationGovernor g;
    g.configure(1, 100);
    CHECK(g.requestStart(0));
    CHECK(!g.requestStart(1));
    g.reset();
    CHECK(g.requestStart(1));       // history cleared: granted again
}

// A very large burst is fanned out over time rather than all-at-once: across a
// window only maxConcurrent permits are ever granted.
TEST(governor_fans_out_large_chord) {
    ServoActivationGovernor g;
    g.configure(2, 5);
    int granted = 0;
    for (int i = 0; i < 6; ++i) if (g.requestStart(2000)) ++granted;
    CHECK_EQ(granted, 2);           // only 2 of 6 at the same instant
    // Advancing past the stagger frees the slots again.
    granted = 0;
    for (int i = 0; i < 6; ++i) if (g.requestStart(2005)) ++granted;
    CHECK_EQ(granted, 2);
}
