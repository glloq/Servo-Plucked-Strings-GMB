// Web -> loop() command queue + dispatch (audit P2.17 — extracted from main.cpp).
//
// The web task never touches mechanical state directly (spec P0): it enqueues a typed
// AppCommand and gets back an id; the main loop drains a bounded batch each tick and
// runs the command. This class owns all the plumbing — the FreeRTOS queue, the id
// counter, the live depth, and the outcome ring (via the host-tested
// CommandResultRing under a mutex) — while the actual command HANDLERS stay in
// main.cpp (they touch the instrument/servos/safety) and are injected as a callback.
//
// Platform class (FreeRTOS), like ServoBank / PlaybackScheduler: it is exercised by
// the host compile-check, and its pure result-ring logic is unit-tested separately.
#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

#include "../../core/configuration/Profile.h"
#include "../../core/util/CommandResultRing.h"

namespace gmb {

enum class CmdType : uint8_t { Panic, Reset, ActivateProfile, TestNote, TestServo };

struct AppCommand {
    CmdType type;
    uint32_t id = 0;
    Profile* profile = nullptr;
    uint8_t channel = 0, note = 0, velocity = 0;
    uint16_t durationMs = 0;
    int16_t servoIndex = -1;
    bool servoActive = false;
    uint16_t servoUs = 0;  // >0: drive the test servo to this exact pulse (live cal)
};

// What a drained command's handler reports (audit 7): Deferred marks a command
// whose real outcome arrives LATER (profile activation spans park -> swap -> park
// -> Ready over many loop passes) — the ring shows it as "running" until the owner
// calls finish() with the final state.
enum class CmdOutcome : uint8_t { Refused = 0, Succeeded = 1, Deferred = 2 };

class CommandDispatcher {
public:
    // Handler runs one command on the main loop and reports its outcome.
    using Handler = std::function<CmdOutcome(const AppCommand&)>;

    void begin(int queueLen) {
        queue_ = xQueueCreate(queueLen, sizeof(AppCommand*));
        resultMutex_ = xSemaphoreCreateMutex();
    }

    // Enqueue a copy of `in` (web task). Assigns an id, records it as "queued", and
    // returns the id (0 if the queue is full / not started). The owned copy is freed
    // when the command is drained or purged.
    uint32_t enqueue(const AppCommand& in) {
        if (!queue_) return 0;
        AppCommand c = in;
        c.id = nextId_.fetch_add(1);
        AppCommand* h = new AppCommand(c);
        if (xQueueSend(queue_, &h, 0) != pdTRUE) {
            delete h->profile;
            delete h;
            return 0;
        }
        depth_.fetch_add(1);
        setResult(c.id, CommandResultRing::Queued);
        return c.id;
    }

    // Drain up to maxPerTick commands (main loop), running `handler` on each and
    // recording the outcome. A Deferred command is marked "running": its owner
    // completes it later through finish() (audit 7 — succeeded must mean DONE,
    // not merely started). Returns the number handled.
    int drain(int maxPerTick, const Handler& handler) {
        if (!queue_) return 0;
        AppCommand* c = nullptr;
        int n = 0;
        for (; n < maxPerTick && xQueueReceive(queue_, &c, 0) == pdTRUE; ++n) {
            depth_.fetch_sub(1);
            CmdOutcome out = handler(*c);
            setResult(c->id, out == CmdOutcome::Succeeded ? CommandResultRing::Succeeded
                           : out == CmdOutcome::Deferred  ? CommandResultRing::Running
                                                          : CommandResultRing::Refused);
            delete c->profile;
            delete c;
        }
        return n;
    }

    // Record the FINAL state of a previously Deferred command (Succeeded / Failed /
    // Cancelled), from the loop that owns its continuation.
    void finish(uint32_t id, uint8_t state) { setResult(id, state); }

    // Drop every queued command without running it (panic / E-stop path). Each
    // dropped command is marked CANCELLED so a client following its outcome stops
    // immediately instead of waiting on a "queued" ghost forever (audit 6).
    void purge() {
        if (!queue_) return;
        AppCommand* c = nullptr;
        while (xQueueReceive(queue_, &c, 0) == pdTRUE) {
            depth_.fetch_sub(1);
            setResult(c->id, CommandResultRing::Cancelled);
            delete c->profile;
            delete c;
        }
    }

    // Live queue depth (for diagnostics high-water tracking).
    int depth() const { return depth_.load(); }

    // Outcome for `id`: queued / succeeded / refused / unknown (under the ring lock).
    std::string commandState(uint32_t id) {
        if (resultMutex_) xSemaphoreTake(resultMutex_, portMAX_DELAY);
        std::string s = results_.stateStr(id);
        if (resultMutex_) xSemaphoreGive(resultMutex_);
        return s;
    }

private:
    void setResult(uint32_t id, uint8_t state) {
        if (resultMutex_) xSemaphoreTake(resultMutex_, portMAX_DELAY);
        results_.set(id, state);
        if (resultMutex_) xSemaphoreGive(resultMutex_);
    }

    QueueHandle_t queue_ = nullptr;
    SemaphoreHandle_t resultMutex_ = nullptr;
    std::atomic<uint32_t> nextId_{1};
    std::atomic<int> depth_{0};
    CommandResultRing results_;
};

}  // namespace gmb
