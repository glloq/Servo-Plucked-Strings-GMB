# Native (host) build of the pure-C++ firmware core + unit tests.
# Usage:  make        -> build and run tests
#         make build  -> build only
CXX ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O1 -g

ROOT := ..
CORE := $(ROOT)/src/core

CORE_SRC := \
  $(ROOT)/src/platform/esp32/ServoBank.cpp \
  $(CORE)/Types.cpp \
  $(CORE)/board/BoardProfile.cpp \
  $(CORE)/board/PinManager.cpp \
  $(CORE)/midi/StringFretSelector.cpp \
  $(CORE)/midi/MidiParser.cpp \
  $(CORE)/instrument/NoteAllocator.cpp \
  $(CORE)/instrument/StringController.cpp \
  $(CORE)/instrument/InstrumentController.cpp \
  $(CORE)/gmb/GmbSysExService.cpp \
  $(CORE)/configuration/Profile.cpp \
  $(CORE)/configuration/ProfileValidator.cpp \
  $(CORE)/gmb/Capabilities.cpp \
  $(CORE)/gmb/GmbSysEx.cpp \
  $(CORE)/gmb/GmbDescriptor.cpp \
  $(CORE)/safety/SafetyManager.cpp

TEST_SRC := \
  test_main.cpp \
  test_board.cpp \
  test_selector.cpp \
  test_allocator.cpp \
  test_string_fsm.cpp \
  test_profile.cpp \
  test_sysex.cpp \
  test_integration.cpp \
  test_midiparser.cpp \
  test_servos.cpp \
  test_scheduler.cpp \
  test_pluck.cpp \
  test_governor.cpp \
  test_fretservo.cpp \
  test_geared.cpp \
  test_audit.cpp \
  test_debounce.cpp \
  test_safety.cpp \
  test_diagnostics.cpp \
  test_transport.cpp \
  test_actuator_manager.cpp \
  test_device_instrument.cpp \
  test_command_ring.cpp \
  test_holdbutton.cpp \
  test_profile_activation.cpp \
  test_app_phase.cpp \
  test_readiness.cpp \
  test_udp_source_gate.cpp

BIN := run_tests

.PHONY: all build clean
all: build
	./$(BIN)

build: $(BIN)

$(BIN): $(CORE_SRC) $(TEST_SRC)
	$(CXX) $(CXXFLAGS) $^ -o $(BIN)

clean:
	rm -f $(BIN)
