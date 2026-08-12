// P1.6: the ActuatorManager governs current-hungry positioning moves but never a
// sound-producing (deadline) strike, so musical timing is not degraded.
#include "TestFramework.h"
#include "../src/core/instrument/ActuatorManager.h"

using namespace gmb;

TEST(deadline_moves_are_never_throttled) {
    ActuatorManager m;
    m.configure(1, 0, 100);  // global cap 1, 100 ms stagger — very tight
    // Fill the single staggerable slot.
    CHECK(m.requestMove(MoveClass::Staggerable, 0));
    CHECK(!m.requestMove(MoveClass::Staggerable, 1));  // second press: throttled
    // A pluck at the same instant still fires — deadline is exempt.
    CHECK(m.requestMove(MoveClass::Deadline, 1));
    CHECK(m.requestMove(MoveClass::Deadline, 1));
    // Deadline moves also do not consume a governor slot: once the window frees, a
    // staggerable start is available again exactly on schedule.
    CHECK(m.requestMove(MoveClass::Staggerable, 100));
}

TEST(staggerable_moves_follow_the_governor) {
    ActuatorManager m;
    m.configure(2, 0, 10);  // 2 concurrent, 10 ms window
    CHECK(m.requestMove(MoveClass::Staggerable, 500));   // 1
    CHECK(m.requestMove(MoveClass::Staggerable, 500));   // 2 — window full
    CHECK(!m.requestMove(MoveClass::Staggerable, 500));  // 3rd deferred
    CHECK(m.requestMove(MoveClass::Staggerable, 510));   // window aged out
    CHECK_EQ((int)m.throttleCount(), 1);                 // exactly one deferral
}

TEST(governor_disabled_passes_everything) {
    ActuatorManager m;
    m.configure(1, 0, 0);  // staggerMs 0 -> throttling off
    for (int i = 0; i < 8; ++i) CHECK(m.requestMove(MoveClass::Staggerable, 0));
    CHECK_EQ((int)m.throttleCount(), 0);
}
