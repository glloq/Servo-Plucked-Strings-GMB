// Pin assignment engine + validator (spec 11.3 / 11.5 / 11.6).
#pragma once

#include <string>
#include <vector>

#include "../Types.h"
#include "BoardProfile.h"

namespace gmb {

struct PinAssignment {
    std::string signal;   // e.g. "SDA", "SCL", "SERVO_OE"
    SignalKind kind = SignalKind::Generic;
    int8_t gpio = -1;
};

// Infer the signal kind from a signal name (e.g. "SDA" -> I2cSda). Used to
// restore PinAssignment.kind on import so GPIO validation stays strict.
SignalKind signalKindFromName(const std::string& signal);

struct PinError {
    std::string signal;
    int8_t gpio = -1;
    std::string reason;        // why the pin is incompatible
    std::string suggestion;    // which pin to use instead
    std::string conflictWith;  // signal already using the pin, if any
};

// Inputs that drive automatic assignment (spec, step 3). Servo-per-fret only needs
// the PCA9685 I2C bus and its /OE safety line; direct-GPIO servos carry their own
// pin in the servo entry, not here.
struct PinRequest {
    int stringCount = 1;
    bool useI2cServos = true;   // PCA9685 present (assign SDA/SCL)
    bool servoSafetyOe = true;  // PCA9685 /OE tied to a safety pin
    bool reserveUsb = true;     // keep GPIO19/20 free for future native USB
};

class PinManager {
public:
    explicit PinManager(const BoardProfile& board) : board_(board) {}

    // Build a conflict-free assignment following the recommended profile,
    // falling back to any compatible candidate when a preferred pin is taken.
    // Returns false if some required signal could not be placed.
    bool autoAssign(const PinRequest& req);

    const std::vector<PinAssignment>& assignments() const { return assignments_; }
    void set(const std::vector<PinAssignment>& a) { assignments_ = a; }
    void clear() { assignments_.clear(); }

    // Manually assign / override a single signal.
    void assign(const std::string& signal, SignalKind kind, int8_t gpio);

    // Full validation. Empty vector == valid configuration.
    std::vector<PinError> validate(bool reserveUsb = true) const;

    // Convenience: which GPIO is currently used by a signal (-1 if none).
    int8_t gpioOf(const std::string& signal) const;

private:
    const BoardProfile& board_;
    std::vector<PinAssignment> assignments_;

    bool place(const std::string& signal, SignalKind kind,
               const std::vector<int8_t>& preferred);
    bool isUsed(int8_t gpio, const std::string& exceptSignal = "") const;
};

}  // namespace gmb
