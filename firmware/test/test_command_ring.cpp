// P2.17: the command-result ring extracted from main.cpp — outcome tracking with a
// fixed-size, wrap-around history.
#include "TestFramework.h"
#include "../src/core/util/CommandResultRing.h"

using namespace gmb;

TEST(command_ring_tracks_and_updates_state) {
    CommandResultRing r;
    CHECK(std::string(r.stateStr(1)) == "unknown");  // never issued
    r.set(1, CommandResultRing::Queued);
    CHECK(std::string(r.stateStr(1)) == "queued");
    r.set(1, CommandResultRing::Succeeded);           // update in place
    CHECK(std::string(r.stateStr(1)) == "succeeded");
    r.set(2, CommandResultRing::Refused);
    CHECK(std::string(r.stateStr(2)) == "refused");
    CHECK(std::string(r.stateStr(1)) == "succeeded");  // 1 still tracked
    r.set(0, CommandResultRing::Succeeded);            // id 0 ignored
    CHECK(std::string(r.stateStr(0)) == "unknown");
}

TEST(command_ring_evicts_oldest_after_capacity) {
    CommandResultRing r;
    // Fill well past capacity (16); the earliest ids must age out to "unknown".
    for (uint32_t id = 1; id <= 20; ++id) r.set(id, CommandResultRing::Succeeded);
    CHECK(std::string(r.stateStr(1)) == "unknown");   // evicted
    CHECK(std::string(r.stateStr(4)) == "unknown");   // evicted
    CHECK(std::string(r.stateStr(5)) == "succeeded"); // within the last 16
    CHECK(std::string(r.stateStr(20)) == "succeeded"); // newest retained
}
