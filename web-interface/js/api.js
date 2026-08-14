/*
 * api.js — REST + WebSocket client for the Servo-Plucked-Strings-GMB
 * web interface, with a self-contained MOCK mode.
 *
 * The page is served from the ESP32 over LittleFS, so this file talks to the
 * firmware REST API (see endpoint list in README.md). When no backend is
 * reachable — typically when index.html is opened directly from disk — every
 * call transparently falls back to an in-memory mock so the whole UI stays
 * usable standalone with realistic sample data (a 4-string GCEA ukulele).
 *
 * Everything is exposed on the global GMB namespace; no ES modules / no build
 * step, so it works from file:// where module imports would be blocked.
 */
(function (global) {
  'use strict';

  var GMB = global.GMB || (global.GMB = {});

  // ---------------------------------------------------------------------------
  // ESP32-S3-DevKitC-1 board profile (spec 11.4 / 11.5).
  //
  // Mirrors firmware/src/core/board/BoardProfile.h PinCapability. `preference`:
  //   recommended | caution | reserved   (grey "used" is a runtime state).
  // ESP32-S3 exposes GPIO0..21 and GPIO26..48 (22..25 do not exist).
  // ---------------------------------------------------------------------------
  function pin(gpio, opts) {
    opts = opts || {};
    return {
      gpio: gpio,
      exposed: opts.exposed !== false,
      input: opts.input !== false,
      output: opts.output !== false,
      interrupt: opts.interrupt !== false,
      highSpeedOutput: !!opts.highSpeedOutput,
      internalPullUp: opts.internalPullUp !== false,
      internalPullDown: opts.internalPullDown !== false,
      adc: !!opts.adc,
      reserved: !!opts.reserved,
      strapping: !!opts.strapping,
      usb: !!opts.usb,
      onboardPeripheral: !!opts.onboardPeripheral,
      preference: opts.preference || 'recommended',
      note: opts.note || ''
    };
  }

  function buildDevKitC1() {
    var pins = [];
    // Strapping / boot pins — usable but risky, advanced only.
    pins.push(pin(0, { strapping: true, highSpeedOutput: true, preference: 'reserved',
      note: 'BOOT strapping pin — reserved to keep boot reliable.' }));
    pins.push(pin(1, { adc: true, highSpeedOutput: true, preference: 'recommended', note: 'ADC1_CH0.' }));
    pins.push(pin(2, { adc: true, highSpeedOutput: true, preference: 'recommended', note: 'ADC1_CH1.' }));
    pins.push(pin(3, { adc: true, strapping: true, highSpeedOutput: true, preference: 'caution',
      note: 'Strapping pin (JTAG source select) — use with care in advanced mode.' }));
    // Recommended general I/O — the auto-assigner draws STEP/DIR/HOME from here.
    [4, 5, 6, 7].forEach(function (g) {
      pins.push(pin(g, { adc: true, highSpeedOutput: true, preference: 'recommended',
        note: 'Fast, general purpose — recommended for STEP.' }));
    });
    [8, 9, 10, 11].forEach(function (g) {
      pins.push(pin(g, { adc: true, highSpeedOutput: true, preference: 'recommended',
        note: 'General purpose — recommended for DIR.' }));
    });
    [12, 13, 14].forEach(function (g) {
      pins.push(pin(g, { adc: true, highSpeedOutput: true, preference: 'recommended',
        note: 'General purpose — recommended for HOME sensors.' }));
    });
    [15, 16].forEach(function (g) {
      pins.push(pin(g, { adc: true, highSpeedOutput: true, preference: 'recommended',
        note: 'General purpose (ADC2) — recommended for STEP.' }));
    });
    [17, 18].forEach(function (g) {
      pins.push(pin(g, { adc: true, highSpeedOutput: true, preference: 'recommended',
        note: 'General purpose (ADC2) — recommended for DIR.' }));
    });
    // Native USB — reserved by default (spec 8.3 / 11.3).
    pins.push(pin(19, { usb: true, preference: 'reserved',
      note: 'USB-JTAG / native USB (D-). Reserved for future USB MIDI.' }));
    pins.push(pin(20, { usb: true, preference: 'reserved',
      note: 'USB-JTAG / native USB (D+). Reserved for future USB MIDI.' }));
    pins.push(pin(21, { highSpeedOutput: true, preference: 'recommended',
      note: 'General purpose — recommended for HOME sensor.' }));
    // GPIO22..25 do not exist on the ESP32-S3.
    // SPI flash — never usable on the DevKitC-1 module.
    [26, 27, 28, 29, 30, 31, 32].forEach(function (g) {
      pins.push(pin(g, { preference: 'reserved', reserved: true,
        note: 'Connected to on-module SPI flash — not available.' }));
    });
    // Variant-dependent memory pins.
    pins.push(pin(33, { highSpeedOutput: true, preference: 'caution',
      note: 'May be used by octal PSRAM on some variants — verify your module.' }));
    pins.push(pin(34, { highSpeedOutput: true, preference: 'caution',
      note: 'May be used by octal PSRAM on some variants — verify your module.' }));
    [35, 36, 37].forEach(function (g) {
      pins.push(pin(g, { preference: 'reserved', reserved: true,
        note: 'Flash/PSRAM on octal variants — reserved unless the variant frees it.' }));
    });
    [38, 39].forEach(function (g) {
      pins.push(pin(g, { highSpeedOutput: true, preference: 'recommended',
        note: 'General purpose — recommended for HOME sensor.' }));
    });
    pins.push(pin(40, { preference: 'recommended', note: 'Recommended I2C SDA (PCA9685).' }));
    pins.push(pin(41, { preference: 'recommended', note: 'Recommended I2C SCL (PCA9685).' }));
    pins.push(pin(42, { preference: 'recommended', note: 'Recommended global driver ENABLE.' }));
    // Main UART — programming / diagnostics.
    pins.push(pin(43, { onboardPeripheral: true, preference: 'reserved',
      note: 'U0TXD — programming & diagnostic UART. Reserved.' }));
    pins.push(pin(44, { onboardPeripheral: true, preference: 'reserved',
      note: 'U0RXD — programming & diagnostic UART. Reserved.' }));
    pins.push(pin(45, { strapping: true, preference: 'caution',
      note: 'Strapping pin (VDD_SPI voltage) — advanced use only.' }));
    pins.push(pin(46, { strapping: true, preference: 'caution',
      note: 'Strapping pin — advanced use only.' }));
    pins.push(pin(47, { highSpeedOutput: true, preference: 'recommended',
      note: 'Recommended PCA9685 /OE safety line.' }));
    pins.push(pin(48, { onboardPeripheral: true, preference: 'reserved',
      note: 'On-board RGB LED (WS2812). Reserved.' }));
    return {
      identifier: 'esp32-s3-devkitc-1',
      displayName: 'ESP32-S3-DevKitC-1',
      pins: pins,
      recommended: { SDA: 40, SCL: 41, SERVO_OE: 47, SDA2: 38, SCL2: 39, SERVO_OE2: 21,
        SERVO: [4, 5, 6, 7, 15, 16, 17, 18] }
      // No `layout`: the board diagram falls back to a schematic two-column view
      // (the 44-pin S3 header order is drawn by GPIO number, marked "schematic").
    };
  }

  // ---------------------------------------------------------------------------
  // Classic ESP32 (ESP32-WROOM-32 / ESP32-D0WD). Shared GPIO capability model for
  // the 38-pin DevKitC and the 30-pin DevKit v1 boards below; they differ only in
  // which pins are broken out (the 30-pin omits the SPI-flash pads) and the
  // physical header order used to draw the board diagram.
  //   • Input-only: 34, 35, 36 (VP), 39 (VN) — no output, can't drive I2C/servo/OE.
  //   • Strapping: 0, 2, 5, 12, 15 — usable but risky (advanced / caution).
  //   • Reserved: 1/3 (UART0), 6..11 (SPI flash).
  // ---------------------------------------------------------------------------
  function wroom32Pins(includeFlash) {
    var pins = [];
    pins.push(pin(0, { strapping: true, output: true, preference: 'caution',
      note: 'BOOT strapping pin — must be released at boot; advanced use only.' }));
    pins.push(pin(1, { onboardPeripheral: true, preference: 'reserved',
      note: 'U0TXD — programming & diagnostic UART. Reserved.' }));
    pins.push(pin(2, { adc: true, strapping: true, output: true, preference: 'caution',
      note: 'Strapping / on-board LED on many boards — advanced use only.' }));
    pins.push(pin(3, { onboardPeripheral: true, preference: 'reserved',
      note: 'U0RXD — programming & diagnostic UART. Reserved.' }));
    pins.push(pin(4, { adc: true, output: true, preference: 'recommended', note: 'General purpose (ADC2).' }));
    pins.push(pin(5, { strapping: true, output: true, preference: 'caution',
      note: 'Strapping pin (must be HIGH at boot) — advanced use only.' }));
    if (includeFlash) [6, 7, 8, 9, 10, 11].forEach(function (g) {
      pins.push(pin(g, { preference: 'reserved', reserved: true,
        note: 'Connected to the SPI flash — not available.' }));
    });
    pins.push(pin(12, { adc: true, strapping: true, output: true, preference: 'caution',
      note: 'MTDI strapping pin (flash voltage) — advanced use only.' }));
    pins.push(pin(13, { adc: true, output: true, preference: 'recommended', note: 'General purpose (ADC2).' }));
    pins.push(pin(14, { adc: true, output: true, preference: 'recommended', note: 'General purpose (ADC2).' }));
    pins.push(pin(15, { adc: true, strapping: true, output: true, preference: 'caution',
      note: 'MTDO strapping pin — advanced use only.' }));
    [16, 17].forEach(function (g) {
      pins.push(pin(g, { output: true, preference: 'recommended',
        note: 'General purpose — used by PSRAM on WROVER modules; verify yours.' }));
    });
    [18, 19].forEach(function (g) {
      pins.push(pin(g, { output: true, preference: 'recommended', note: 'General purpose (VSPI).' }));
    });
    pins.push(pin(21, { output: true, preference: 'recommended', note: 'Recommended I2C SDA (PCA9685).' }));
    pins.push(pin(22, { output: true, preference: 'recommended', note: 'Recommended I2C SCL (PCA9685).' }));
    pins.push(pin(23, { output: true, preference: 'recommended', note: 'Recommended PCA9685 /OE safety line.' }));
    [25, 26].forEach(function (g) {
      pins.push(pin(g, { adc: true, output: true, preference: 'recommended', note: 'General purpose (DAC / ADC2).' }));
    });
    pins.push(pin(27, { adc: true, output: true, preference: 'recommended', note: 'General purpose (ADC2).' }));
    [32, 33].forEach(function (g) {
      pins.push(pin(g, { adc: true, output: true, preference: 'recommended', note: 'General purpose (ADC1).' }));
    });
    // Input-only pins: usable as sensor inputs but never as outputs (no I2C/servo/OE).
    [34, 35].forEach(function (g) {
      pins.push(pin(g, { adc: true, input: true, output: false, internalPullUp: false, internalPullDown: false,
        preference: 'reserved', note: 'Input-only (ADC1) — cannot drive I2C / servo / /OE.' }));
    });
    pins.push(pin(36, { adc: true, input: true, output: false, internalPullUp: false, internalPullDown: false,
      preference: 'reserved', note: 'Input-only sensor VP (ADC1) — cannot output.' }));
    pins.push(pin(39, { adc: true, input: true, output: false, internalPullUp: false, internalPullDown: false,
      preference: 'reserved', note: 'Input-only sensor VN (ADC1) — cannot output.' }));
    return pins;
  }

  // Physical header order for the board diagram: one entry per header pin,
  // top→bottom, per side. { side, label, gpio (null for power/GND), power }.
  function P(side, label, gpio, power) { return { side: side, label: label, gpio: gpio == null ? null : gpio, power: !!power }; }

  function buildWroom32DevKitC() {
    // ESP32-WROOM-32 DevKitC — 38-pin header (USB at the bottom).
    var layout = [
      P('L', '3V3', null, true), P('L', 'EN', null, true), P('L', 'VP', 36), P('L', 'VN', 39),
      P('L', 'IO34', 34), P('L', 'IO35', 35), P('L', 'IO32', 32), P('L', 'IO33', 33),
      P('L', 'IO25', 25), P('L', 'IO26', 26), P('L', 'IO27', 27), P('L', 'IO14', 14),
      P('L', 'IO12', 12), P('L', 'GND', null, true), P('L', 'IO13', 13), P('L', 'D2', 9),
      P('L', 'D3', 10), P('L', 'CMD', 11),
      P('R', 'GND', null, true), P('R', 'IO23', 23), P('R', 'IO22', 22), P('R', 'TX0', 1),
      P('R', 'RX0', 3), P('R', 'IO21', 21), P('R', 'GND', null, true), P('R', 'IO19', 19),
      P('R', 'IO18', 18), P('R', 'IO5', 5), P('R', 'IO17', 17), P('R', 'IO16', 16),
      P('R', 'IO4', 4), P('R', 'IO0', 0), P('R', 'IO2', 2), P('R', 'IO15', 15),
      P('R', 'D1', 8), P('R', 'D0', 7), P('R', 'CLK', 6), P('R', '5V', null, true)
    ];
    return {
      identifier: 'esp32-wroom-32',
      displayName: 'ESP32-WROOM-32 (DevKitC, 38-pin)',
      pins: wroom32Pins(true),
      recommended: { SDA: 21, SCL: 22, SERVO_OE: 23, SDA2: 32, SCL2: 33, SERVO_OE2: 25,
        SERVO: [4, 13, 14, 16, 17, 18, 19, 27] },
      layout: layout
    };
  }

  function buildEsp32DevKitV1() {
    // ESP32 DevKit v1 / NodeMCU-32S — 30-pin header (flash pads not broken out).
    var layout = [
      P('L', 'EN', null, true), P('L', 'VP', 36), P('L', 'VN', 39), P('L', 'IO34', 34),
      P('L', 'IO35', 35), P('L', 'IO32', 32), P('L', 'IO33', 33), P('L', 'IO25', 25),
      P('L', 'IO26', 26), P('L', 'IO27', 27), P('L', 'IO14', 14), P('L', 'IO12', 12),
      P('L', 'IO13', 13), P('L', 'GND', null, true), P('L', 'VIN', null, true),
      P('R', 'IO23', 23), P('R', 'IO22', 22), P('R', 'TX0', 1), P('R', 'RX0', 3),
      P('R', 'IO21', 21), P('R', 'GND', null, true), P('R', 'IO19', 19), P('R', 'IO18', 18),
      P('R', 'IO5', 5), P('R', 'IO17', 17), P('R', 'IO16', 16), P('R', 'IO4', 4),
      P('R', 'IO0', 0), P('R', 'IO2', 2), P('R', 'IO15', 15)
    ];
    return {
      identifier: 'esp32-devkit-v1',
      displayName: 'ESP32 DevKit v1 (30-pin)',
      pins: wroom32Pins(false),
      recommended: { SDA: 21, SCL: 22, SERVO_OE: 23, SDA2: 32, SCL2: 33, SERVO_OE2: 25,
        SERVO: [4, 13, 14, 16, 17, 18, 19, 27] },
      layout: layout
    };
  }

  // Board registry — the boards the UI offers for the pin representation.
  var BOARDS = {};
  [buildDevKitC1(), buildWroom32DevKitC(), buildEsp32DevKitV1()].forEach(function (b) { BOARDS[b.identifier] = b; });
  function boardFor(id) { return BOARDS[id] || BOARDS['esp32-s3-devkitc-1']; }
  GMB.boardList = function () {
    return Object.keys(BOARDS).map(function (id) { return { id: id, name: BOARDS[id].displayName }; });
  };
  // Recommended pin map for a board id (SDA/SCL/OE… ), used by auto-assign and the
  // second-bus pin defaults. Falls back to the S3 map.
  GMB.recommendedFor = function (id) { return boardFor(id).recommended || RECOMMENDED; };

  // ---------------------------------------------------------------------------
  // Default recommended pin assignment (spec 11.5). Signal names
  // match firmware PinAssignment.signal ("STEP1", "HOME3", "SDA"...).
  // ---------------------------------------------------------------------------
  // Servo-per-fret needs no stepper STEP/DIR/HOME signals: fingers and pluckers are
  // driven over the PCA9685 I2C bus or on a direct GPIO. SERVO lists good free
  // output pins for direct-GPIO servos.
  var RECOMMENDED = {
    SDA: 40, SCL: 41, SERVO_OE: 47,
    SDA2: 38, SCL2: 39, SERVO_OE2: 21,  // optional second I2C bus (Wire1) + its /OE
    SERVO: [4, 5, 6, 7, 15, 16, 17, 18]
  };
  GMB.RECOMMENDED = RECOMMENDED;

  // Which capability a signal kind needs (mirrors BoardProfile::candidatesFor).
  var SIGNAL_KIND = {
    enable: 'enable', sda: 'i2cSda', scl: 'i2cScl', servoOe: 'servoOe', servo: 'servo'
  };
  GMB.SIGNAL_KIND = SIGNAL_KIND;

  // Can a pin (statically) carry a given signal kind? (spec 11.3)
  GMB.pinSupports = function (p, kind) {
    if (!p || !p.exposed || p.reserved || p.preference === 'reserved') return false;
    switch (kind) {
      case 'enable':
      case 'servo':    // direct-GPIO servo: LEDC 50 Hz PWM — any output pin
      case 'servoOe': return p.output;
      case 'i2cSda':
      case 'i2cScl': return p.input && p.output;
      default: return p.output;
    }
  };

  // ---------------------------------------------------------------------------
  // Sample profile — a 4-string GCEA ukulele (reentrant tuning G4 C4 E4 A4).
  // Matches the JSON schema in the project brief exactly.
  // ---------------------------------------------------------------------------
  // Servo-per-fret string: just an open pitch and the highest reachable fret.
  // Which frets carry a finger is derived from the servo list (see availableFrets).
  function makeString(openNote, maxFret) {
    return { enabled: true, openNote: openNote, maxFret: maxFret === undefined ? 12 : maxFret };
  }

  // A single servo entry (matches firmware ServoConfig). `source` is "pca" or
  // "gpio"; per-string servos carry stringIndex; a finger also carries its fret.
  function servo(fn, stringIndex, opts) {
    opts = opts || {};
    return {
      enabled: opts.enabled !== false,
      function: fn,
      stringIndex: stringIndex === undefined ? -1 : stringIndex,
      fret: opts.fret === undefined ? -1 : opts.fret,        // finger: fret 1..24
      fretB: opts.fretB === undefined ? -1 : opts.fretB,     // geared finger: 2nd fret (-1 = plain)
      source: opts.source || 'pca',   // "pca" | "gpio"
      pcaBoard: opts.pcaBoard || 0,   // 0..7 (0x40..0x47) — address within its I2C bus
      i2cBus: opts.i2cBus === 1 ? 1 : 0, // 0 | 1 — which ESP32 I2C controller the board is on
      channel: opts.channel === undefined ? 0 : opts.channel, // 0..15 (source == pca)
      gpio: opts.gpio === undefined ? -1 : opts.gpio,         // ESP32 GPIO (source == gpio)
      pulseMinUs: opts.pulseMinUs || 500,
      pulseMaxUs: opts.pulseMaxUs || 2500,
      restUs: opts.restUs || 1000,
      activeUs: opts.activeUs || 1800,
      activeBUs: opts.activeBUs || 0,   // geared finger: side-B press pulse (fretB)
      muteUs: opts.muteUs || 0,         // pluck/strum: plectrum-as-mute pulse (0 = none)
      inverted: !!opts.inverted,
      travelMs: opts.travelMs || 120,
      settleMs: opts.settleMs || 30,
      disableAtRest: opts.disableAtRest !== false,
      // Strum / pluck stroke shaping (matches firmware ServoConfig).
      engageDelayMs: opts.engageDelayMs || 0,
      alternateDirection: !!opts.alternateDirection,
      activeAltUs: opts.activeAltUs || 0,
      strokeMs: opts.strokeMs || 0,
      minStrikeUs: opts.minStrikeUs || 0
    };
  }
  GMB.servoDefaults = servo;

  // Angle <-> pulse helpers so the calibration UI can offer degrees while the
  // firmware keeps microseconds. A servo's [pulseMinUs, pulseMaxUs] maps linearly
  // to [0, 180]°.
  GMB.usToAngle = function (s, us) {
    var span = (s.pulseMaxUs || 2500) - (s.pulseMinUs || 500);
    if (span <= 0) return 0;
    return Math.round(((us - (s.pulseMinUs || 500)) / span) * 180);
  };
  GMB.angleToUs = function (s, deg) {
    var span = (s.pulseMaxUs || 2500) - (s.pulseMinUs || 500);
    var us = (s.pulseMinUs || 500) + (deg / 180) * span;
    return Math.round(Math.max(s.pulseMinUs || 500, Math.min(s.pulseMaxUs || 2500, us)));
  };

  // The set of frets that carry a finger servo on a string (fret 0 = open, always
  // playable, never listed). Sorted ascending.
  GMB.availableFrets = function (p, stringIndex) {
    var frets = [];
    (p.servos || []).forEach(function (sv) {
      if (!sv.enabled || sv.function !== 'finger' || sv.stringIndex !== stringIndex) return;
      if (sv.fret >= 1) frets.push(sv.fret);
      // A geared finger also makes its second fret (side B) playable.
      if (sv.fretB >= 1) frets.push(sv.fretB);
    });
    frets.sort(function (a, b) { return a - b; });
    return frets;
  };

  // ---------------------------------------------------------------------------
  // Mechanical wiring generator (Instrument Builder).
  //
  // A string's servo layout is generated from a small mechanical SPEC rather than
  // hard-coded, so the UI can offer real mechanical choices. Channels are assigned
  // sequentially from 0 on the string's board, which reproduces the historical
  // "one finger per fret + one plucker, one PCA per string" layout byte-for-byte
  // when spec = { fretting:'chromatic', sounding:'pluck' } (see defaultStringServos).
  //
  //   spec = {
  //     maxFret,                                    // highest fret on the string
  //     fretting: 'chromatic'|'geared'|'open'|'custom',
  //     gearThreshold,                              // geared: pair frets 1..threshold
  //     sounding: 'pluck'|'strum',                  // per-string striker role
  //     lift, damper,                               // optional strumLift / damper
  //     board                                       // PCA board (default = stringIndex)
  //   }
  // 'open' equips no fingers (open string only); 'custom' generates nothing so the
  // caller can keep hand-tuned wiring (see buildInstrument).
  GMB.buildStringServos = function (stringIndex, spec) {
    spec = spec || {};
    var out = [], ch = 0;
    var board = (spec.board === undefined || spec.board === null) ? stringIndex : spec.board;
    var maxFret = spec.maxFret || 0;
    function push(fn, opts) {
      opts = opts || {};
      opts.pcaBoard = board;
      opts.channel = ch++;              // sequential — byte-compatible with the old layout
      out.push(servo(fn, stringIndex, opts));
    }
    if (spec.fretting === 'chromatic') {
      for (var f = 1; f <= maxFret; f++) push('finger', { fret: f });
    } else if (spec.fretting === 'geared') {
      var end = Math.min(spec.gearThreshold || 6, maxFret), a = 1;
      var mid = 1500;                                   // centre of the default pulse window
      while (a + 1 <= end) {                            // antagonistic pairs (1,2)(3,4)…
        push('finger', { fret: a, fretB: a + 1, restUs: mid,
          activeUs: mid + 400, activeBUs: mid - 400 });
        a += 2;
      }
      for (; a <= maxFret; a++) push('finger', { fret: a });   // narrow high frets stay plain
    }
    // 'open' / 'custom' add no finger servos.

    if (spec.fretting !== 'custom') {                  // every sounding string needs a striker
      // Unified plucking model: the plectrum RESTS against the string (contact,
      // ~90°) and sweeps ± an angle for alternating strokes — down-stroke to
      // activeUs (~110°), up-stroke to activeAltUs (~70°). Same config for every
      // striker; only the angles change with the mechanical mounting.
      push(spec.sounding === 'strum' ? 'strum' : 'pluck',
        { restUs: 1500, activeUs: 1720, activeAltUs: 1280, alternateDirection: true,
          travelMs: 90, settleMs: 20 });
      if (spec.lift)   push('strumLift', { restUs: 1000, activeUs: 1600, engageDelayMs: 20 });
      if (spec.damper) push('damper',    { restUs: 1000, activeUs: 1600 });
    }
    return out;
  };

  // Differential regeneration (audit 5 P0): a regenerated servo that mechanically
  // matches an EXISTING one — same string, role, fret and geared side-B — keeps the
  // existing servo's ENTIRE configuration (source pca/gpio, board/bus/channel or
  // GPIO, every calibrated pulse, direction, timings). Only genuinely NEW actuators
  // receive the generated defaults. Pure: returns a new array, consumes each
  // existing servo at most once.
  GMB.mergeBuilderServos = function (generated, existing) {
    var pool = (existing || []).slice();
    function key(s) {
      return s.function + ':' +
        (s.fret === undefined || s.fret === null ? -1 : s.fret) + ':' +
        (s.fretB === undefined || s.fretB === null ? -1 : s.fretB);
    }
    return generated.map(function (g) {
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].stringIndex === g.stringIndex && key(pool[i]) === key(g)) {
          return pool.splice(i, 1)[0];  // keep the calibrated servo as-is
        }
      }
      return g;  // a new actuator: generated defaults
    });
  };

  // Build the whole servo list from a per-string spec function. A string whose
  // fretting is 'custom' keeps its EXISTING servos untouched; every other string
  // is regenerated DIFFERENTIALLY: servos that still exist mechanically keep their
  // full calibration + wiring, only new positions get defaults (audit 5 P0 — a
  // simple maxFret change used to silently reset every pulse to factory values).
  // Pass existing = [] (or null) for an explicit factory reset. Pure.
  GMB.buildInstrument = function (specFor, strings, existing) {
    var out = [];
    for (var i = 0; i < strings.length; i++) {
      var es = specFor(i) || {};
      var mine = (existing || []).filter(function (s) { return s.stringIndex === i; });
      if (es.fretting === 'custom')
        out = out.concat(mine);
      else
        out = out.concat(GMB.mergeBuilderServos(GMB.buildStringServos(i, es), mine));
    }
    return out;
  };

  // Backward-compatible default wiring: one finger per fret + one plucker, one
  // PCA9685 per string. Delegates to the mechanical generator; the output is
  // deep-equal to the historical layout (fingers on channels 0..maxFret-1, plucker
  // on channel maxFret, pcaBoard = stringIndex).
  GMB.defaultStringServos = function (stringIndex, maxFret) {
    return GMB.buildStringServos(stringIndex, {
      maxFret: maxFret, fretting: 'chromatic', sounding: 'pluck',
      lift: false, damper: false, board: stringIndex
    });
  };

  function sampleProfile() {
    return {
      project: 'Servo-Plucked-Strings-GMB', profileVersion: 1, capabilitiesRevision: 7,
      instrument: {
        name: 'Ukulele GCEA', description: '4-string soprano ukulele',
        stringCount: 4, type: 'ukulele', gmProgram: 24, typeId: 4,
        capo: 0, transpose: 0
      },
      board: { profile: 'esp32-s3-devkitc-1', reserveUsb: true, automaticPinAssignment: true },
      pins: [
        { signal: 'SDA', kind: 'sda', gpio: 40 }, { signal: 'SCL', kind: 'scl', gpio: 41 },
        { signal: 'SERVO_OE', kind: 'servoOe', gpio: 47 }
      ],
      network: {
        mode: 'accessPoint', ssid: '', hostname: 'gmb-ukulele',
        apSsid: 'Servo-Plucked-Strings-GMB'
      },
      power: { maxConcurrentMoves: 3, maxConcurrentPerBoard: 0, staggerMs: 8 },
      pluck: {
        strokeMs: 0, minStrikePct: 0, fretToPluckMs: 0, muteSource: 'auto',
        muteHoldMs: 60, liftMuteOnNoteOff: false, liftEngage: 'lowerToPlay'
      },
      midi: {
        globalChannel: 0, omni: false, transpose: 0, chordWindowMs: 3,
        velocityCurve: 'linear', sustainPedal: true, sustainCc: 64,
        saturationStrategy: 'priorityLow',
        noteExecutionDelayMs: 0, strumLeadMs: 0
      },
      stringFretSelection: {
        enabled: true, mode: 'hybrid', preset: 'general-midi-boop', perMidiChannel: true,
        selectionTimeoutMs: 100, prepareOnCompleteSelection: true, queueDepth: 32,
        string: { ccNumber: 20, minimum: 1, maximum: 4, offset: 0, numbering: 'oneBased',
          reverseOrder: false, mapping: [0, 1, 2, 3] },
        fret: { ccNumber: 21, minimum: 0, maximum: 12, offset: 0, invalidValuePolicy: 'automaticFallback' },
        validation: {
          notePositionPolicy: 'ccPriorityWithWarning',
          missingSelectionPolicy: 'automaticAllocation',
          expiredSelectionPolicy: 'automaticAllocation'
        }
      },
      // Ukulele GCEA: physical order low->high used by GMB = G4(67) C4(60) E4(64) A4(69).
      // Fret reach shortens across the neck: 12 / 10 / 8 / 7 frets per string.
      strings: [makeString(67, 12), makeString(60, 10), makeString(64, 8), makeString(69, 7)],
      // Each string: a geared servo covering the first two frets (tight low frets
      // need the extra torque of a reduction gear), plain fingers on the rest, and
      // one plucker. One PCA9685 per string (board = string index).
      servos: GMB.buildStringServos(0, { maxFret: 12, fretting: 'geared', gearThreshold: 2, sounding: 'pluck', board: 0 })
        .concat(GMB.buildStringServos(1, { maxFret: 10, fretting: 'geared', gearThreshold: 2, sounding: 'pluck', board: 1 }))
        .concat(GMB.buildStringServos(2, { maxFret: 8, fretting: 'geared', gearThreshold: 2, sounding: 'pluck', board: 2 }))
        .concat(GMB.buildStringServos(3, { maxFret: 7, fretting: 'geared', gearThreshold: 2, sounding: 'pluck', board: 3 }))
    };
  }
  GMB.sampleProfile = sampleProfile;

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  GMB.noteName = function (n) {
    if (n === null || n === undefined || n < 0) return '--';
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
  };

  // Which frets are actually wired on a string: bit f set iff a finger servo
  // presses fret f (or its geared side-B). Mirrors the firmware availableFretMask()
  // so the announced range reflects real, non-contiguous fretboards (audit SX-1).
  function availableFretMask(p, idx) {
    var m = 0;
    (p.servos || []).forEach(function (sv) {
      if (!sv.enabled || sv.function !== 'finger' || sv.stringIndex !== idx) return;
      if (sv.fret >= 1) m |= (1 << sv.fret);
      if (sv.fretB >= 1) m |= (1 << sv.fretB);
    });
    return m;
  }

  // Derive read-only capabilities from a profile (SysEx spec 5 / 6 / 17). Mirrors
  // the firmware buildSnapshot(): playability follows the wired frets (SX-1), the
  // open pitch folds in the global transpose (SX-3), tuning/frets stay in physical
  // string order (SX-2), and polyphony honours instrument.polyphonyMax (SX-4).
  GMB.computeCapabilities = function (p) {
    var strings = p.strings || [];
    var capo = p.instrument.capo || 0;
    var transpose = (p.instrument.transpose || 0) + ((p.midi && p.midi.transpose) || 0);
    var notesSet = {};
    var min = 128, max = -1, active = 0, maxFret = 0;
    var tuning = [], fretsPer = [];
    strings.forEach(function (s, i) {
      if (s.enabled === false) return;
      active++;
      if ((s.maxFret || 0) > maxFret) maxFret = s.maxFret || 0;
      var openEff = s.openNote + transpose;
      tuning.push(Math.max(0, Math.min(127, openEff)));
      fretsPer.push(s.maxFret || 0);
      var mask = availableFretMask(p, i);
      var add = function (f) {
        var n = openEff + capo + f;
        if (n < 0 || n > 127) return;
        notesSet[n] = true; if (n < min) min = n; if (n > max) max = n;
      };
      add(0);  // open string always playable
      for (var f = 1; f <= (s.maxFret || 0); f++) if ((mask >> f) & 1) add(f);
    });
    if (max < 0) { min = 0; max = 0; }
    var allContinuous = true;
    for (var n2 = min; n2 <= max; n2++) if (!notesSet[n2]) { allContinuous = false; break; }
    var discreteNotes = Object.keys(notesSet).map(Number).sort(function (a, b) { return a - b; });
    var sfs = p.stringFretSelection;
    var polyMax = p.instrument.polyphonyMax || 0;
    return {
      strings: p.instrument.stringCount,
      frets: maxFret,
      noteMin: min, noteMax: max, noteMode: allContinuous ? 0 : 1,
      discreteNotes: discreteNotes,
      polyphony: polyMax > 0 ? Math.min(polyMax, active) : active,
      polyphonyAuto: polyMax === 0,
      ccString: sfs.string.ccNumber, ccFret: sfs.fret.ccNumber,
      ccActive: sfs.enabled ? 1 : 0,
      tuning: tuning, tuningNames: tuning.map(GMB.noteName),
      fretsPerString: fretsPer,
      capo: capo,
      revision: p.capabilitiesRevision,
      supportedCc: buildSupportedCc(p)
    };
  };

  function buildSupportedCc(p) {
    // Announce only enabled CCs (SysEx spec 7).
    var cc = [7, 11];
    if (p.stringFretSelection.enabled) {
      cc.push(p.stringFretSelection.string.ccNumber);
      cc.push(p.stringFretSelection.fret.ccNumber);
    }
    if (p.midi.sustainPedal) cc.push(64);
    cc.push(120, 123);
    return cc.sort(function (a, b) { return a - b; });
  }

  // ---------------------------------------------------------------------------
  // Live status (dashboard, spec 19). Mock evolves over time.
  // ---------------------------------------------------------------------------
  function sampleStatus() {
    var p = MOCK.profile;
    var caps = GMB.computeCapabilities(p);
    return {
      state: 'READY',
      wifi: { mode: p.network.mode, ssid: p.network.mode === 'station' ? p.network.ssid : p.network.apSsid,
        ip: p.network.mode === 'station' ? '192.168.1.42' : '192.168.4.1', rssi: -54, connected: true },
      midiSource: 'WebSocket MIDI (Wi-Fi)',
      midiSourcePolicy: MOCK.midiSourcePolicy || 'open',
      midiSourceLocked: false,
      authConfigured: !!MOCK.authConfigured,
      activeProfile: p.instrument.name,
      stringsReady: p.instrument.stringCount, stringsTotal: p.instrument.stringCount,
      notesPlaying: 0,
      faults: [],
      capabilitiesRevision: p.capabilitiesRevision,
      strings: p.strings.map(function (s, i) {
        return {
          index: i, state: 'IDLE',
          note: null, fret: null,
          finger: 'up', plectrum: 'rest', lastFault: 'none',
          openNote: s.openNote
        };
      })
    };
  }

  // ---------------------------------------------------------------------------
  // Mock store.
  //
  // `slots` mirrors the firmware's slotted ProfileStorage: an array where each
  // entry is null (empty slot) or a full profile object. GET /api/profiles
  // derives { profiles:[{slot,name,used}], startupSlot } from it.
  // ---------------------------------------------------------------------------
  function demoProfile(name, type) {
    var p = sampleProfile();
    p.instrument.name = name;
    p.instrument.type = type;
    return p;
  }

  var MOCK = {
    board: buildDevKitC1(),
    profile: sampleProfile(),
    slots: [
      sampleProfile(),
      demoProfile('Guitar Standard', 'guitar'),
      demoProfile('Bass EADG', 'bass'),
      null, null, null, null, null
    ],
    startupSlot: 0
  };
  // The board the current working profile targets (falls back to the S3 DevKitC-1).
  function currentBoardId() {
    return (GMB.state && GMB.state.profile && GMB.state.profile.board &&
      GMB.state.profile.board.profile) || 'esp32-s3-devkitc-1';
  }
  GMB.mockBoard = function () { return boardFor(currentBoardId()); };

  // Build the { profiles:[...], startupSlot } list from the slot array.
  function mockProfilesList() {
    var profiles = MOCK.slots.map(function (p, i) {
      return { slot: i, name: p ? (p.instrument.name || '') : '', used: !!p };
    });
    return { profiles: profiles, startupSlot: MOCK.startupSlot };
  }

  // ---------------------------------------------------------------------------
  // Mock auto-assign — reproduces the recommended profile, respecting the
  // requested string count and reserved USB pins (mirrors PinManager::autoAssign).
  // ---------------------------------------------------------------------------
  function mockAutoAssign(req) {
    var rec = GMB.recommendedFor(currentBoardId());
    var pins = [];
    if (req.useI2cServos !== false) {
      pins.push({ signal: 'SDA', kind: 'sda', gpio: rec.SDA });
      pins.push({ signal: 'SCL', kind: 'scl', gpio: rec.SCL });
    }
    if (req.servoSafetyOe !== false) pins.push({ signal: 'SERVO_OE', kind: 'servoOe', gpio: rec.SERVO_OE });
    return { pins: pins, errors: [] };
  }

  // Mock validation (spec 11.6). Mirrors the firmware contract:
  // decodes the full profile and returns { ok, issues:[{field,message,severity}] }.
  function mockValidatePins(profile) {
    var pins = (profile && profile.pins) || [];
    var reserveUsb = !!(profile && profile.board && profile.board.reserveUsb);
    var brd = boardFor(profile && profile.board && profile.board.profile);
    var errors = [];
    var byGpio = {};
    pins.forEach(function (a) {
      if (a.gpio < 0) return;
      var cap = brd.pins.filter(function (p) { return p.gpio === a.gpio; })[0];
      // Duplicate use.
      if (byGpio[a.gpio]) {
        errors.push({ signal: a.signal, gpio: a.gpio,
          reason: 'GPIO ' + a.gpio + ' is already used by ' + byGpio[a.gpio] + '.',
          suggestion: suggest(a.kind, pins, brd), conflictWith: byGpio[a.gpio] });
      } else {
        byGpio[a.gpio] = a.signal;
      }
      // Reserved / USB / capability.
      if (!cap) {
        errors.push({ signal: a.signal, gpio: a.gpio,
          reason: 'GPIO ' + a.gpio + ' does not exist on this board.',
          suggestion: suggest(a.kind, pins, brd), conflictWith: '' });
      } else if (reserveUsb && cap.usb) {
        errors.push({ signal: a.signal, gpio: a.gpio,
          reason: 'GPIO ' + a.gpio + ' is reserved for future native USB.',
          suggestion: suggest(a.kind, pins, brd), conflictWith: 'USB (reserved)' });
      } else if (cap.preference === 'reserved') {
        errors.push({ signal: a.signal, gpio: a.gpio,
          reason: cap.note || ('GPIO ' + a.gpio + ' is reserved.'),
          suggestion: suggest(a.kind, pins, brd), conflictWith: '' });
      } else if (!GMB.pinSupports(cap, SIGNAL_KIND[a.kind] || 'generic')) {
        errors.push({ signal: a.signal, gpio: a.gpio,
          reason: 'GPIO ' + a.gpio + ' is not compatible with a ' + a.kind.toUpperCase() + ' signal.',
          suggestion: suggest(a.kind, pins, brd), conflictWith: '' });
      }
    });
    // Map the rich mock errors onto the firmware's { field, message, severity }
    // issue shape.
    var issues = errors.map(function (e) {
      var msg = e.reason + (e.suggestion ? ' ' + e.suggestion : '');
      return { field: e.signal + ' (GPIO' + e.gpio + ')', message: msg, severity: 'error' };
    });
    return { ok: issues.length === 0, issues: issues };
  }

  function suggest(kind, pins, brd) {
    var used = {};
    pins.forEach(function (a) { used[a.gpio] = true; });
    var wantKind = SIGNAL_KIND[kind] || 'generic';
    var free = (brd || boardFor(currentBoardId())).pins.filter(function (p) {
      return !used[p.gpio] && p.preference === 'recommended' && GMB.pinSupports(p, wantKind);
    });
    return free.length ? ('Try GPIO ' + free[0].gpio + '.') : 'No free recommended pin — free one up first.';
  }

  // ---------------------------------------------------------------------------
  // SysEx mock (Communication ... SysEx spec). Builds byte arrays + decoded view.
  // ---------------------------------------------------------------------------
  var HEADER = [0xF0, 0x7D, 0x00];
  function hex(bytes) { return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2).toUpperCase(); }).join(' '); }
  GMB.hex = hex;

  // Block ids. dir 0x00 = request (host->device). Identity (0x01) now answers with
  // the GMB v2 handshake; the change notification is the v2 block 0x11. Blocks
  // 5/6/7 remain for the deprecated fixed-block path the firmware still serves.
  var BLOCK = { identity: 0x01, descriptor: 0x05, capabilities: 0x06, stringConfig: 0x07, notify: 0x11 };

  // Build the raw request bytes for a block. Channel-bearing blocks
  // (capabilities 0x06, stringConfig 0x07) carry the MIDI channel byte.
  // Returns null for spontaneous, device-emitted blocks (notify).
  function buildSysexRequest(kind, channel) {
    var ch = (channel || 0) & 0x7F;
    switch (kind) {
      case 'identity':     return HEADER.concat([BLOCK.identity, 0x00, 0xF7]);
      case 'descriptor':   return HEADER.concat([BLOCK.descriptor, 0x00, 0xF7]);
      case 'capabilities': return HEADER.concat([BLOCK.capabilities, 0x00, ch, 0xF7]);
      case 'stringConfig': return HEADER.concat([BLOCK.stringConfig, 0x00, ch, 0xF7]);
      default:             return null;   // notify has no host->device request
    }
  }
  GMB.buildSysexRequest = buildSysexRequest;

  // Build the GMB v2 block-0x11 change-notification (device-emitted):
  // F0 7D 00 11 02 <revision[5]> <flags> F7. Flags bit 1 = INSTRUMENTS_CHANGED.
  function buildNotifyMessage(p) {
    var caps = GMB.computeCapabilities(p);
    return HEADER.concat([BLOCK.notify, 0x02])
      .concat(encodeRevision(caps.revision)).concat([0x02, 0xF7]);
  }

  // Build the GMB v2 descriptor object from a profile (mirrors the firmware
  // GmbDescriptor::toJson). Used by the offline mock of GET /gmb/descriptor.json.
  GMB.mockDescriptor = function (p) {
    var caps = GMB.computeCapabilities(p);
    var enabled = (p.strings || []).filter(function (s) { return s.enabled !== false; });
    var sfs = p.stringFretSelection;
    var notes = caps.noteMode === 0
      ? { mode: 'range', min: caps.noteMin, max: caps.noteMax }
      : { mode: 'discrete', list: caps.discreteNotes };
    var voices = caps.tuning.map(function (t, i) {
      var lo = Math.max(0, Math.min(127, t + caps.capo));
      var reach = caps.fretsPerString[i] != null ? caps.fretsPerString[i] : caps.frets;
      return { id: 's' + (i + 1), notes: { mode: 'range', min: lo, max: Math.max(0, Math.min(127, lo + reach)) } };
    });
    var physical = {
      family: 'strings', string_count: enabled.length, fret_count: caps.frets,
      frets_per_string: caps.fretsPerString, fretless: false, capo: caps.capo,
      tuning: caps.tuning,
      string_order: (sfs.string && sfs.string.reverseOrder) ? 'reversed'
        : ((sfs.string && sfs.string.mapping && sfs.string.mapping.length) ? 'custom' : 'normal')
    };
    if (sfs.enabled) {
      physical.selection = {
        mode: sfs.mode,
        cc_string: sfs.string.ccNumber, cc_string_min: sfs.string.minimum,
        cc_string_max: sfs.string.maximum, cc_string_offset: sfs.string.offset || 0,
        cc_fret: sfs.fret.ccNumber, cc_fret_min: sfs.fret.minimum,
        cc_fret_max: sfs.fret.maximum, cc_fret_offset: sfs.fret.offset || 0
      };
    }
    var inst = {
      channel: p.midi.omni ? 0 : p.midi.globalChannel, configured: true,
      name: p.instrument.name || '', gm_program: p.instrument.gmProgram,
      notes: notes,
      polyphony: { max: caps.polyphony, constraints: [{ type: 'one_note_per_voice' }] },
      expression: { cc: caps.supportedCc }, voices: voices, physical: physical
    };
    if (p.instrument.type) inst.type = p.instrument.type;
    return {
      gmb_descriptor: 2, revision: caps.revision,
      device: { name: p.instrument.name || '', model: p.project || 'Servo-Plucked-Strings-GMB' },
      instruments: [inst]
    };
  };

  // MOCK backend for POST /api/sysex/request: accepts { bytes:[...] } and
  // returns { ok:true, response:[...] } — the raw response bytes for the block
  // named in the request, built from the active mock profile.
  function mockSysExBackend(body) {
    var bytes = (body && body.bytes) || [];
    return { ok: true, response: mockSysexResponse(bytes) };
  }
  GMB.mockSysEx = mockSysExBackend;

  function mockSysexResponse(bytes) {
    if (!bytes || bytes.length < 5) return [];
    var block = bytes[3];
    var p = MOCK.profile, caps = GMB.computeCapabilities(p);
    var name = p.instrument.name || '';
    switch (block) {
      case BLOCK.identity: {
        // GMB v2 24-byte handshake: F0 7D 00 01 01 <proto=02> <instance_id[5]>
        // <fw[3]> <descriptor_size[3] LE> <revision[5] LE> <flags> F7.
        var dsz = JSON.stringify(GMB.mockDescriptor(p)).length;
        return HEADER.concat([BLOCK.identity, 0x01, 0x02])   // dir=response, proto_ver=2
          .concat([0x01, 0x02, 0x03, 0x04, 0x05])            // instance_id[5]
          .concat([0x01, 0x00, 0x00])                        // firmware 1.0.0
          .concat([dsz & 0x7F, (dsz >> 7) & 0x7F, (dsz >> 14) & 0x7F])  // descriptor_size[3]
          .concat(encodeRevision(caps.revision))             // revision[5]
          .concat([0x03, 0xF7]);                             // flags (HTTP+push), end
      }
      case BLOCK.descriptor:
        return HEADER.concat([BLOCK.descriptor, 0x01, 0x01, 0x01,
          p.midi.globalChannel, p.instrument.gmProgram, p.instrument.typeId, 0xF7]);
      case BLOCK.capabilities: {
        var ch = bytes[5] & 0x7F;
        return HEADER.concat([BLOCK.capabilities, 0x01, 0x01, ch, p.instrument.gmProgram, p.instrument.typeId,
          0x00, caps.noteMode, caps.noteMin, caps.noteMax, caps.polyphony, 0x00,
          caps.supportedCc.length]).concat(caps.supportedCc)
          .concat([name.length]).concat(strBytes(name, name.length))
          .concat([0xF7]);
      }
      case BLOCK.stringConfig: {
        var ch2 = bytes[5] & 0x7F;
        return HEADER.concat([BLOCK.stringConfig, 0x01, 0x01, ch2, caps.strings, caps.frets, 0x00, caps.capo,
          caps.ccActive, caps.ccString, caps.ccFret]).concat(caps.tuning).concat([0xF7]);
      }
      default:
        return [];
    }
  }

  // Decode raw response bytes for a block into a { field: value } display map,
  // by parsing the bytes (works for both the mock and the real firmware, which
  // share the SysEx wire layout).
  function decodeSysexResponse(kind, resp) {
    if (!resp || !resp.length) return {};
    try {
      switch (kind) {
        case 'identity': {
          // GMB v2 handshake (24 bytes).
          var dsz = (resp[14] || 0) | ((resp[15] || 0) << 7) | ((resp[16] || 0) << 14);
          var flg = resp[22] || 0;
          return { 'Proto ver': resp[5], 'Instance id': hex(resp.slice(6, 11)),
            Firmware: resp[11] + '.' + resp[12] + '.' + resp[13],
            'Descriptor size': dsz + ' B', Level: dsz > 0 ? '1 (descriptor)' : '0 (basic)',
            Revision: decodeRevision(resp.slice(17, 22)),
            HTTP: (flg & 1) ? 'yes' : 'no', Push: (flg & 2) ? 'yes' : 'no' };
        }
        case 'descriptor':
          return { Channel: resp[7] + 1, 'GM program': resp[8],
            'Type id': '0x0' + (resp[9] || 0).toString(16) };
        case 'capabilities': {
          var ch = resp[6], noteMode = resp[10], noteMin = resp[11], noteMax = resp[12],
            poly = resp[13], ccLen = resp[15];
          var cc = resp.slice(16, 16 + ccLen);
          return { Channel: ch + 1, Range: GMB.noteName(noteMin) + ' .. ' + GMB.noteName(noteMax),
            'Note mode': noteMode === 0 ? 'continuous' : 'discrete', Polyphony: poly,
            CC: cc.join(', ') };
        }
        case 'stringConfig': {
          // resp[10] is the protocol's transpose/offset byte (kept on the wire, not
          // surfaced in the interface).
          var strings = resp[7], frets = resp[8],
            ccString = resp[12], ccFret = resp[13];
          var tuning = resp.slice(14, 14 + strings);
          return { Channel: resp[6] + 1, Strings: strings, Frets: frets, Fretless: 'no',
            'CC string': ccString, 'CC fret': ccFret,
            Tuning: tuning.map(GMB.noteName).join(' ') };
        }
        case 'notify':
          // GMB v2 block 0x11: F0 7D 00 11 02 <revision[5]> <flags> F7.
          return { Revision: decodeRevision(resp.slice(5, 10)),
            Flags: '0x' + (resp[10] || 0).toString(16) };
        default:
          return {};
      }
    } catch (e) { return { error: String(e) }; }
  }

  // Assemble the display view the SysEx tester renders (request/response hex,
  // decoded fields, 7-bit validity, byte count).
  function makeSysexView(kind, req, resp, t0) {
    var valid = resp.every(function (b) { return b === 0xF0 || b === 0xF7 || (b >= 0 && b <= 0x7F); });
    return {
      kind: kind, request: req ? hex(req) : '(spontaneous notification)',
      response: hex(resp), decoded: decodeSysexResponse(kind, resp), valid: valid,
      length: resp.length, durationMs: +(nowMs() - t0 + 1.2).toFixed(2), error: ''
    };
  }

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function strBytes(s, len) {
    var out = [];
    for (var i = 0; i < len; i++) out.push(i < s.length ? (s.charCodeAt(i) & 0x7F) : 0x00);
    return out;
  }
  function readStr(bytes, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) { var b = bytes[off + i]; if (!b) break; s += String.fromCharCode(b); }
    return s;
  }
  function encodeRevision(r) {
    // 5 x 7-bit bytes, LSB first.
    var out = [];
    for (var i = 0; i < 5; i++) { out.push(r & 0x7F); r = r >> 7; }
    return out;
  }
  function decodeRevision(bytes) {
    var r = 0;
    for (var i = 0; i < bytes.length; i++) r |= (bytes[i] & 0x7F) << (7 * i);
    return r;
  }

  // ---------------------------------------------------------------------------
  // The API client. Every REST method tries fetch() first. It falls back to the
  // mock ONLY when the backend is unreachable (network failure / forced demo).
  // A real HTTP error (4xx/5xx from the firmware) is propagated to the caller so
  // the UI shows the real failure instead of a faked success.
  // ---------------------------------------------------------------------------
  var api = {
    mock: false,
    _forceMock: false,
    // Admin token attached to write requests (X-GMB-Token). Persisted locally so
    // it survives reloads; set via setAdminToken().
    _adminToken: (typeof localStorage !== 'undefined' && localStorage.getItem('gmbAdminToken')) || '',

    // Force mock mode (used by a "Demo mode" toggle if desired).
    useMock: function (on) { this._forceMock = !!on; if (on) this.mock = true; },

    // Remember an admin token locally (does NOT store it on the device — use
    // setAdminTokenRemote for that).
    setAdminToken: function (t) {
      this._adminToken = t || '';
      if (typeof localStorage !== 'undefined') localStorage.setItem('gmbAdminToken', this._adminToken);
    },
    // Configure the device's admin token (POST /api/auth) and remember it.
    setAdminTokenRemote: function (t) {
      var self = this;
      return this._call('/api/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t })
      }, function () { MOCK.authConfigured = true; return { ok: true }; })
        .then(function (r) { self.setAdminToken(t); return r; });
    },
    // POST /api/auth/check with a CANDIDATE token: 200 = it is the device's admin
    // token (remember it locally so this browser's writes work), 401 = wrong.
    // Never changes the stored token (audit 5 — a fresh browser knowing the token
    // had no way to authenticate itself).
    unlockAdminToken: function (t) {
      var self = this;
      return this._call('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GMB-Token': t || '' },
        body: '{}'
      }, function () { return { ok: true }; }).then(function (r) {
        self.setAdminToken(t);
        return r;
      });
    },
    // POST /api/midi/source -> { ok }. UDP MIDI source posture: policy
    // "open"|"lockToFirst"|"disabled" (optional) and/or unlock:true to forget
    // the currently locked sender. Stored device-side (NVS), survives reboots.
    setMidiSource: function (payload) {
      var body = {};
      if (payload.policy) body.policy = payload.policy;
      if (payload.unlock) body.unlock = true;
      return this._call('/api/midi/source', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, function () {
        if (body.policy) MOCK.midiSourcePolicy = body.policy;
        return { ok: true };
      });
    },

    _fetch: function (path, opts) {
      var self = this;
      if (this._forceMock) {
        var fm = new Error('forced-mock'); fm.network = true; return Promise.reject(fm);
      }
      // Attach the admin token to write requests when one is configured — unless
      // the caller already set one (the unlock flow probes a CANDIDATE token).
      if (this._adminToken && opts && opts.method && opts.method !== 'GET') {
        opts.headers = opts.headers || {};
        if (!opts.headers['X-GMB-Token']) opts.headers['X-GMB-Token'] = this._adminToken;
      }
      return fetch(path, opts).then(function (r) {
        // Backend replied. Whatever the status, we are NOT offline.
        self.mock = false;
        var ct = r.headers.get('content-type') || '';
        var bodyP = ct.indexOf('application/json') >= 0
          ? r.json().catch(function () { return {}; })
          : r.text();
        if (!r.ok) {
          return bodyP.then(function (body) {
            var e = new Error('HTTP ' + r.status);
            e.httpStatus = r.status;
            e.body = body;             // e.g. { ok:false, issues:[...] }
            throw e;                   // real error — do not mask with the mock
          });
        }
        return bodyP;
      }, function (networkErr) {
        // fetch() itself rejected -> the backend is unreachable.
        var e = new Error('network'); e.network = true; e.cause = networkErr;
        throw e;
      });
    },

    // Wrap a REST call so it falls back to the mock ONLY when offline.
    _call: function (path, opts, mockFn) {
      var self = this;
      return this._fetch(path, opts).catch(function (e) {
        if (self._forceMock || (e && e.network)) { self.mock = true; return mockFn(); }
        throw e;  // propagate real HTTP errors to the caller
      });
    },

    getStatus: function () {
      return this._call('/api/status', null, function () { return sampleStatus(); });
    },
    getProfile: function () {
      return this._call('/api/profile', null, function () { return deepCopy(MOCK.profile); });
    },
    putProfile: function (profile) {
      return this._call('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile)
      }, function () {
        MOCK.profile = deepCopy(profile);
        MOCK.profile.capabilitiesRevision = (MOCK.profile.capabilitiesRevision || 0) + 1;
        return { ok: true, capabilitiesRevision: MOCK.profile.capabilitiesRevision };
      });
    },
    // GET /api/profiles -> { profiles:[{slot,name,used}], startupSlot }.
    getProfiles: function () {
      return this._call('/api/profiles', null, function () { return mockProfilesList(); });
    },
    // POST /api/profiles -> { ok } : save a full profile to a slot (optionally
    // making it the startup slot).
    saveProfileSlot: function (slot, profile, startup) {
      var body = { slot: slot, profile: profile };
      if (startup) body.startup = true;
      return this._call('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }, function () {
        MOCK.slots[slot] = deepCopy(profile);
        if (startup) MOCK.startupSlot = slot;
        return { ok: true };
      });
    },
    // POST /api/profiles/load -> { ok } (404 if the slot is empty).
    // NOTE: this ACTIVATES the slot and triggers a reconfigure on the firmware.
    loadProfileSlot: function (slot) {
      return this._call('/api/profiles/load', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: slot })
      }, function () {
        var stored = MOCK.slots[slot];
        if (!stored) return { ok: false, error: 'slot not found' };
        MOCK.profile = deepCopy(stored);
        return { ok: true };
      });
    },
    // POST /api/profiles/read -> the slot's profile JSON, WITHOUT activating it
    // (no actuator movement). Used by copy / rename / set-startup.
    readProfileSlot: function (slot) {
      return this._call('/api/profiles/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: slot })
      }, function () {
        var stored = MOCK.slots[slot];
        if (!stored) throw Object.assign(new Error('HTTP 404'), { httpStatus: 404 });
        return deepCopy(stored);
      });
    },
    // POST /api/reset -> recover from a panic / E-stop, then re-arm.
    resetSystem: function () {
      return this._call('/api/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }, function () { return { ok: true }; });
    },
    // POST /api/profiles/delete -> { ok }.
    deleteProfileSlot: function (slot) {
      return this._call('/api/profiles/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot: slot })
      }, function () {
        MOCK.slots[slot] = null;
        if (MOCK.startupSlot === slot) MOCK.startupSlot = 0;
        return { ok: true };
      });
    },
    getBoard: function (id) {
      return this._call('/api/board/' + id, null, function () { return deepCopy(boardFor(id)); });
    },
    // GET /gmb/descriptor.json -> the GMB v2 descriptor the firmware serves (the
    // authoritative view of what a General-Midi-Boop controller receives).
    getDescriptor: function () {
      return this._call('/gmb/descriptor.json', null, function () {
        return GMB.mockDescriptor(MOCK.profile);
      });
    },
    autoPins: function (req) {
      // Tell the firmware which board the draft targets (board-aware auto-assign).
      var body = Object.assign({ board: currentBoardId() }, req);
      return this._call('/api/pins/auto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }, function () { return mockAutoAssign(req); });
    },
    // POST /api/pins/validate -> { ok, issues:[{field,message,severity}] }.
    // The backend decodes the body as a full Profile and runs its validator, so
    // we send the whole draft profile (not just the pins).
    validatePins: function (profile) {
      return this._call('/api/pins/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile)
      }, function () { return mockValidatePins(profile); });
    },
    panic: function () {
      return this._call('/api/panic', { method: 'POST' }, function () {
        return { ok: true, message: 'PANIC executed: drivers disabled, servos neutralised, queue flushed.' };
      });
    },
    // POST /api/test/note -> { ok:true } (200) or { ok:false, error } (409 when
    // the instrument is not ready). The firmware reads only
    // channel/note/velocity/durationMs; the richer payload feeds the mock trace.
    testNote: function (payload) {
      var wire = { channel: payload.channel | 0, note: payload.note | 0,
        velocity: payload.velocity | 0, durationMs: payload.durationMs || 500 };
      return this._call('/api/test/note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wire)
      }, function () { return mockTestNote(payload); });
    },
    // POST /api/test/servo -> { ok } (409 if not armed). Body: { index, active }
    // plus an optional { us }: when present the firmware drives the servo to that
    // exact pulse and holds it (live calibration, incl. a geared finger's side-B
    // press); absent/0 keeps the rest/active press-release semantics.
    // When the payload carries the servo's mechanical IDENTITY (function +
    // stringIndex [+ fret]) the firmware resolves it against the ACTIVE profile
    // instead of trusting the draft's array index — a draft whose servo list has
    // been edited would otherwise move the WRONG actuator (audit 5 P0). It answers
    // 409 for an actuator that only exists in the unsaved draft.
    testServo: function (payload) {
      var wire = { index: payload.index | 0, active: !!payload.active };
      if (payload.us) wire.us = payload.us | 0;
      if (payload.function) {
        wire.function = payload.function;
        wire.stringIndex = payload.stringIndex | 0;
        if (payload.fret >= 1) wire.fret = payload.fret | 0;
      }
      return this._call('/api/test/servo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wire)
      }, function () { return mockTestServo(payload); });
    },
    // GET /api/commands?id=N -> { id, state:"queued"|"succeeded"|"refused"|"unknown" }.
    // Lets a 202-accepted command (e.g. a servo test) be followed up for its real outcome.
    commandState: function (id) {
      return this._call('/api/commands?id=' + encodeURIComponent(id), null,
        function () { return { id: id, state: 'succeeded' }; });
    },
    // POST /api/wifi -> { ok:true }. Device network settings + write-only passwords.
    // Stored in device NVS so mode/SSID/hostname survive a reboot independently of
    // any profile slot; `apply:true` reconnects immediately (hotspot fallback on
    // failure). `clearStationPassword` really erases the stored secret (an empty
    // password field still means "keep the old one").
    setWifi: function (payload) {
      var body = {};
      ['mode', 'ssid', 'apSsid', 'hostname'].forEach(function (k) {
        if (payload[k] !== undefined) body[k] = payload[k];
      });
      if (payload.stationPassword) body.stationPassword = payload.stationPassword;
      if (payload.apPassword) body.apPassword = payload.apPassword;
      if (payload.clearStationPassword) body.clearStationPassword = true;
      if (payload.clearApPassword) body.clearApPassword = true;
      if (payload.apply) body.apply = true;
      return this._call('/api/wifi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, function () { return { ok: true, note: 'stored (mock)' }; });
    },
    // GET /api/wifi/scan[?start=1] -> { ok, scanning, networks:[{ssid,rssi,secure,
    // channel}] } deduped by SSID, sorted by RSSI. Poll while `scanning` is true.
    wifiScan: function (start) {
      var self = this;
      return this._call('/api/wifi/scan' + (start ? '?start=1' : ''), null, function () {
        if (start) { MOCK.scanStartedAt = nowMs(); }
        var elapsed = MOCK.scanStartedAt ? nowMs() - MOCK.scanStartedAt : 1e9;
        if (elapsed < 1500) return { ok: true, scanning: true, networks: [] };
        return { ok: true, scanning: false, networks: [
          { ssid: 'Workshop-24', rssi: -48, secure: true, channel: 6 },
          { ssid: 'FreeCafe', rssi: -61, secure: false, channel: 11 },
          { ssid: 'Neighbor', rssi: -77, secure: true, channel: 1 }
        ] };
      });
    },
    // POST /api/hotspot -> switch to the access point + captive portal now.
    startHotspot: function () {
      return this._call('/api/hotspot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }, function () { return { ok: true, note: 'Hotspot starting (mock) — rejoin the device Wi-Fi.' }; });
    },
    // POST /api/sysex/request: build the request bytes for the block, send
    // { bytes:[...] }, then decode the returned response bytes for display.
    sysexRequest: function (kind) {
      var prof = (global.GMB.state && global.GMB.state.profile) || MOCK.profile;
      var t0 = nowMs();
      // Block 8 (notify) is device-emitted — there is no host->device request,
      // so it is built and decoded locally.
      if (kind === 'notify') {
        return Promise.resolve(makeSysexView('notify', null, buildNotifyMessage(prof), t0));
      }
      var req = buildSysexRequest(kind, prof.midi.globalChannel);
      if (!req) return Promise.resolve(makeSysexView(kind, null, [], t0));
      return this._call('/api/sysex/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bytes: req })
      }, function () { return mockSysExBackend({ bytes: req }); }).then(function (res) {
        return makeSysexView(kind, req, (res && res.response) || [], t0);
      });
    },
    getCapabilities: function () {
      return this._call('/api/capabilities', null, function () { return GMB.computeCapabilities(MOCK.profile); });
    }
  };

  function mockTestNote(payload) {
    // Emulate the integrated test tool (selection spec 16) with a step log.
    var steps = [
      { step: 'CC string received', detail: 'CC' + payload.stringCc + ' = ' + payload.string },
      { step: 'CC fret received', detail: 'CC' + payload.fretCc + ' = ' + payload.fret },
      { step: 'Selection validated', detail: 'string ' + payload.string + ', fret ' + payload.fret },
      { step: 'Axis moving', detail: 'string ' + payload.string + ' -> fret ' + payload.fret },
      { step: 'Position reached', detail: 'ok' },
      { step: 'Finger pressed', detail: payload.fret === 0 ? 'skipped (open string)' : 'ok' },
      { step: 'String plucked', detail: 'velocity ' + payload.velocity }
    ];
    // Also inject the events into the mock MIDI stream so the monitor shows them.
    injectMidi(payload);
    return { ok: true, steps: steps };
  }

  // Mock servo test (/api/test/servo): matches the firmware contract
  // { ok } for a { index, active } request.
  function mockTestServo(payload) {
    var us = payload.us ? (payload.us | 0)
      : (payload.active ? (payload.activeUs || 1800) : (payload.restUs || 1000));
    var to = payload.us ? 'exact pulse' : (payload.active ? 'active' : 'rest');
    var where = payload.source === 'gpio'
      ? ('GPIO' + (payload.gpio >= 0 ? payload.gpio : '—'))
      : ('PCA board ' + (payload.pcaBoard || 0) + ', channel ' + (payload.channel || 0));
    return {
      ok: true,
      message: 'Servo "' + (payload.function || 'servo') + '" (' + where + ') driven to ' +
        to + ' (' + us + ' µs).'
    };
  }

  // ---------------------------------------------------------------------------
  // WebSocket helpers. Real WS if reachable, otherwise a mock event pump.
  // Consumers use GMB.api.connect('/ws/midi', onMessage) -> returns {close}.
  // ---------------------------------------------------------------------------
  var midiSubscribers = [];
  var statusSubscribers = [];

  api.connectMidi = function (onEvent) {
    return connect('/ws/midi', onEvent, midiSubscribers, startMidiPump);
  };
  api.connectStatus = function (onEvent) {
    return connect('/ws/status', onEvent, statusSubscribers, startStatusPump);
  };

  function connect(path, onEvent, subs, startPump) {
    var url;
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = proto + '//' + location.host + path;
    } catch (e) { url = null; }
    var handle = { close: function () {}, mock: false };
    if (!url || location.protocol === 'file:') { return mockConnect(onEvent, subs, startPump, handle); }
    try {
      var ws = new WebSocket(url);
      var opened = false;
      ws.onopen = function () { opened = true; api.mock = false; };
      ws.onmessage = function (ev) { try { onEvent(JSON.parse(ev.data)); } catch (e) {} };
      ws.onerror = function () { if (!opened) { ws.close(); mockConnect(onEvent, subs, startPump, handle); } };
      ws.onclose = function () { if (!opened) mockConnect(onEvent, subs, startPump, handle); };
      handle.close = function () { try { ws.close(); } catch (e) {} };
      return handle;
    } catch (e) {
      return mockConnect(onEvent, subs, startPump, handle);
    }
  }

  function mockConnect(onEvent, subs, startPump, handle) {
    api.mock = true;
    handle.mock = true;
    subs.push(onEvent);
    startPump();
    handle.close = function () {
      var i = subs.indexOf(onEvent);
      if (i >= 0) subs.splice(i, 1);
    };
    return handle;
  }

  // Mock MIDI event pump — periodically emits a plausible GMB tablature sequence.
  var midiTimer = null, midiTime = 0;
  function startMidiPump() {
    if (midiTimer) return;
    var seq = 0;
    midiTimer = setInterval(function () {
      if (!midiSubscribers.length) { clearInterval(midiTimer); midiTimer = null; return; }
      var p = MOCK.profile, sfs = p.stringFretSelection;
      var str = 1 + (seq % p.instrument.stringCount);
      var fret = (seq * 2) % (p.strings[str - 1].maxFret + 1);
      var note = p.strings[str - 1].openNote + fret;
      emitMidi({ channel: 1, type: 'cc', cc: sfs.string.ccNumber, value: str,
        interpretation: 'string ' + str });
      emitMidi({ channel: 1, type: 'cc', cc: sfs.fret.ccNumber, value: fret,
        interpretation: 'fret ' + fret });
      emitMidi({ channel: 1, type: 'noteOn', note: note, value: 100,
        interpretation: 'string ' + str + ', fret ' + fret + (fret === 0 ? ' (open)' : '') });
      seq++;
    }, 2500);
  }

  function emitMidi(ev) {
    ev.timeMs = Math.round(midiTime += 1);
    ev.t = Date.now();
    midiSubscribers.forEach(function (fn) { try { fn(ev); } catch (e) {} });
  }

  // Push test-tool events straight into the monitor stream.
  function injectMidi(payload) {
    emitMidi({ channel: (payload.channel || 0) + 1, type: 'cc', cc: payload.stringCc,
      value: payload.string, interpretation: 'string ' + payload.string });
    emitMidi({ channel: (payload.channel || 0) + 1, type: 'cc', cc: payload.fretCc,
      value: payload.fret, interpretation: 'fret ' + payload.fret });
    emitMidi({ channel: (payload.channel || 0) + 1, type: 'noteOn', note: payload.note,
      value: payload.velocity, interpretation: 'string ' + payload.string + ', fret ' + payload.fret });
  }
  GMB.injectMidi = injectMidi;

  // Mock status pump — small live jitter so the dashboard feels alive.
  var statusTimer = null;
  function startStatusPump() {
    if (statusTimer) return;
    statusTimer = setInterval(function () {
      if (!statusSubscribers.length) { clearInterval(statusTimer); statusTimer = null; return; }
      var st = sampleStatus();
      statusSubscribers.forEach(function (fn) { try { fn(st); } catch (e) {} });
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Test sequencer — play an ordered list of servo / note / wait steps, cancellably.
  //
  // The firmware tests ONE servo at a time (POST /api/test/servo). A "group test"
  // (sweep every finger of a string, pluck every string, test everything…) is built
  // here as a sequence with a dwell between moves, so the in-rush current stays
  // bounded and each move is visible. Only one sequence runs at a time; a global
  // stop() (and the STOP / panic button) cancels it. Steps:
  //   { kind:'servo', index, active?, us?, after?, label? }  -> POST /api/test/servo
  //   { kind:'note',  channel, note, velocity, durationMs, after?, label? } -> /test/note
  //   { kind:'wait',  ms, label? }                           -> pure delay
  // `after` is an extra dwell (ms) once the step's request resolves; `label` drives
  // the progress readout. run(steps, {onStep, onDone}) returns a handle with stop().
  var _seq = { running: false, token: 0, onState: null };
  function seqDelay(ms) { return new Promise(function (res) { setTimeout(res, ms | 0); }); }
  GMB.testRunner = {
    isRunning: function () { return _seq.running; },
    // Register the single state listener (start/stop). Re-set on each render so the
    // active step's Stop button + status line always reflect the live state.
    onState: function (fn) { _seq.onState = fn || null; },
    stop: function () {
      var was = _seq.running;
      _seq.running = false; _seq.token++;   // invalidate any in-flight loop
      if (was && _seq.onState) { try { _seq.onState(false); } catch (e) {} }
    },
    run: function (steps, opts) {
      opts = opts || {};
      steps = steps || [];
      var token = ++_seq.token;              // supersede any running sequence
      var wasRunning = _seq.running;
      _seq.running = true;
      if (!wasRunning && _seq.onState) { try { _seq.onState(true); } catch (e) {} }
      var i = 0;
      function fin(cancelled) {
        if (_seq.token === token) {
          _seq.running = false;
          if (_seq.onState) { try { _seq.onState(false); } catch (e) {} }
        }
        if (opts.onDone) { try { opts.onDone(cancelled); } catch (e) {} }
      }
      function step() {
        if (_seq.token !== token) return fin(true);   // stopped / superseded
        if (i >= steps.length) return fin(false);
        var s = steps[i]; var at = i; i++;
        if (opts.onStep) { try { opts.onStep(s, at, steps.length); } catch (e) {} }
        var p;
        if (s.kind === 'note') p = GMB.api.testNote(s).catch(function () {});
        else if (s.kind === 'servo') p = GMB.api.testServo(s).catch(function () {});
        else p = Promise.resolve();                   // 'wait' / 'label'
        p.then(function () { return seqDelay(s.kind === 'wait' ? (s.ms || 0) : (s.after || 0)); })
         .then(function () { if (_seq.token === token) step(); else fin(true); });
      }
      step();
      return { stop: function () { GMB.testRunner.stop(); } };
    }
  };

  // ---------------------------------------------------------------------------
  // Small utilities.
  // ---------------------------------------------------------------------------
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  GMB.deepCopy = deepCopy;
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'profile'; }
  GMB.slug = slug;

  GMB.api = api;
})(window);
