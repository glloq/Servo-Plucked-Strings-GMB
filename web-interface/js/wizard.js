/*
 * wizard.js — first-configuration assistant for a SERVO-PER-FRET instrument.
 *
 * The physical machine has two independent halves per string, and the wizard now
 * mirrors that split so each can be configured, calibrated and tested on its own:
 *
 *   • FRETS  (frettes) — one dedicated finger servo per fret position; it presses
 *                        the string against the fret. Step "Frets".
 *   • PLUCK  (grattage) — the plectrum / strum servo that sounds the string, plus
 *                        the optional strum-lift and damper. Step "Plucking".
 *
 * Steps: Builder -> Frets -> Plucking -> MIDI -> Power -> Test -> Validation
 * (the Builder merges the old Instrument + Strings steps). Every actuator step
 * carries an Arm control and a "test bench" that
 * drives ONE servo or a whole GROUP (sweep every fret of a string, pluck every
 * string, test everything…) through the shared GMB.testRunner sequencer, with a
 * live status line and a Stop button. The Simplified / Advanced toggle hides the
 * wiring (source, board, channel) and fine timing in simplified mode.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var STEPS = ['Builder', 'Frets', 'Plucking', 'MIDI', 'Power', 'Test', 'Validation'];
  var step = 0;
  var activeStr = 0;        // per-string steps show one string at a time
  var expandedFrets = {};   // Frets step: which fret rows show their calibration editor
  var calibratedFrets = {}; // Frets step: frets marked calibrated this session

  // Instrument Builder: a transient mechanical spec. The profile stores no
  // mechanical-choice field, so this is DERIVED from the servo list when the
  // Builder is (re)entered, edited via the builder's radio-cards, and committed to
  // p.servos by applyBuilder(). `perString[i]` holds only fields overriding global.
  var builder = null;
  var builderRef = null;    // the profile object `builder` was derived from

  var TUNINGS = {
    ukulele: { notes: [67, 60, 64, 69], maxFret: 12 },        // G C E A
    guitar: { notes: [40, 45, 50, 55, 59, 64], maxFret: 12 }, // E A D G B E
    bass: { notes: [28, 33, 38, 43], maxFret: 12 },           // E A D G
    mandolin: { notes: [55, 62, 69, 76], maxFret: 12 },       // G D A E
    banjo: { notes: [50, 55, 59, 62, 67], maxFret: 12 }       // D G B D g
  };
  var GM_PROGRAM = { ukulele: 24, guitar: 24, bass: 33, mandolin: 25, banjo: 105 };
  var TYPE_ID = { ukulele: 0x04, guitar: 0x04, bass: 0x05, mandolin: 0x04, banjo: 0x06 };

  // ---- servo helpers --------------------------------------------------------

  function servosOf(strIdx) {
    return GMB.state.profile.servos.filter(function (s) { return s.stringIndex === strIdx; });
  }
  function fingerFor(strIdx, fret) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      // Matches a plain finger on `fret` OR a geared finger whose side A (fret) or
      // side B (fretB) presses this fret.
      if (s.function === 'finger' && s.stringIndex === strIdx &&
          (s.fret === fret || s.fretB === fret)) return s;
    }
    return null;
  }
  function isGeared(sv) { return !!sv && sv.function === 'finger' && sv.fretB >= 1; }
  function strikerFor(strIdx) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++)
      if ((list[i].function === 'pluck' || list[i].function === 'strum') &&
          list[i].stringIndex === strIdx) return list[i];
    return null;
  }
  function servoIndexOf(sv) { return GMB.state.profile.servos.indexOf(sv); }
  // First per-string servo of a given role (strumLift / damper / ...), or null.
  function perStringServo(strIdx, fn) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++)
      if (list[i].function === fn && list[i].stringIndex === strIdx) return list[i];
    return null;
  }
  // Global auxiliary actuators (stringIndex -1), in profile order.
  function auxServos() {
    return GMB.state.profile.servos.filter(function (s) { return s.function === 'aux'; });
  }

  // Lowest free PCA channel on a board (0..15), or -1 if the board is full.
  function freeChannel(board) {
    var used = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca' && s.pcaBoard === board) used[s.channel] = true;
    });
    for (var c = 0; c < 16; c++) if (!used[c]) return c;
    return -1;
  }

  function addFinger(strIdx, fret) {
    var board = strIdx;  // one-PCA-per-string convention (editable afterwards)
    var ch = freeChannel(board);
    if (ch < 0) { board = 0; ch = freeChannel(0); }
    GMB.state.profile.servos.push(
      GMB.servoDefaults('finger', strIdx, { pcaBoard: board, channel: ch < 0 ? 0 : ch, fret: fret }));
    GMB.markDirty();
  }
  function removeServo(sv) {
    var i = servoIndexOf(sv);
    if (i >= 0) { GMB.state.profile.servos.splice(i, 1); GMB.markDirty(); }
  }

  // Toggle a finger between plain (one fret) and geared (drives a second, antagonist
  // fret through a gear). Enabling picks an adjacent fret as side B, removes that
  // fret's now-redundant standalone servo, and seeds a CENTRED neutral with a
  // symmetric press on each side (the user then fine-tunes all three positions).
  function setGeared(sv, on, strIdx) {
    if (on) {
      var maxFret = GMB.state.profile.strings[strIdx].maxFret;
      var b = sv.fret + 1 <= maxFret ? sv.fret + 1 : sv.fret - 1;
      if (b < 1) { GMB.toast('No adjacent fret available to pair.', 'warn'); return; }
      // Drop a standalone finger already sitting on side B (the gear replaces it).
      var partner = null, list = GMB.state.profile.servos;
      for (var i = 0; i < list.length; i++)
        if (list[i] !== sv && list[i].function === 'finger' &&
            list[i].stringIndex === strIdx && list[i].fret === b) { partner = list[i]; break; }
      if (partner) removeServo(partner);
      sv.fretB = b;
      var mid = Math.round(((sv.pulseMinUs || 500) + (sv.pulseMaxUs || 2500)) / 2);
      sv.restUs = mid;                                            // neutral: both up
      sv.activeUs = Math.min(sv.pulseMaxUs || 2500, mid + 400);   // side A press
      sv.activeBUs = Math.max(sv.pulseMinUs || 500, mid - 400);   // side B press
    } else {
      var oldB = sv.fretB;
      sv.fretB = -1;
      sv.activeBUs = 0;  // back to a plain single finger (keeps rest/active as-is)
      // Un-gearing: give the fret that side B used to cover its own finger back, so
      // it doesn't silently become unplayable (symmetric with enabling).
      if (oldB >= 1 && !fingerFor(strIdx, oldB)) addFinger(strIdx, oldB);
    }
    GMB.markDirty();
  }
  function ensureStriker(strIdx) {
    if (strikerFor(strIdx)) return;
    var board = strIdx, ch = freeChannel(board);
    if (ch < 0) { board = 0; ch = freeChannel(0); }
    GMB.state.profile.servos.push(
      GMB.servoDefaults('pluck', strIdx,
        { pcaBoard: board, channel: ch < 0 ? 0 : ch, activeUs: 1700, travelMs: 90, settleMs: 20 }));
    GMB.markDirty();
  }

  // Pick a free PCA slot, preferring `preferBoard` (a string's own board), then
  // scanning the other boards. Falls back to board 0 / channel 0 when everything is
  // full — the user can re-wire or switch the new servo to a direct GPIO afterwards.
  function pickPcaSlot(preferBoard) {
    var b = preferBoard >= 0 ? preferBoard : 0;
    var ch = freeChannel(b);
    if (ch < 0) for (b = 0; b < 8; b++) { ch = freeChannel(b); if (ch >= 0) break; }
    if (ch < 0) { b = preferBoard >= 0 ? preferBoard : 0; ch = 0; }
    return { board: b, channel: ch };
  }

  // Add an optional actuator (strumLift / damper / aux) on a sensible default PCA
  // slot; the user can switch it to a direct GPIO or re-wire it in the editor.
  function addRoleServo(fn, strIdx) {
    var slot = pickPcaSlot(strIdx);
    var opts = { pcaBoard: slot.board, channel: slot.channel };
    if (fn === 'strumLift') { opts.restUs = 1000; opts.activeUs = 1600; opts.engageDelayMs = 20; }
    GMB.state.profile.servos.push(GMB.servoDefaults(fn, strIdx, opts));
    GMB.markDirty();
  }

  // Wire (or re-wire) a whole string: one finger per fret 1..maxFret on its own
  // PCA board + a plucker. Replaces this string's existing servos.
  function autoWireString(strIdx) {
    var p = GMB.state.profile;
    var maxFret = p.strings[strIdx].maxFret;
    p.servos = p.servos.filter(function (s) { return s.stringIndex !== strIdx; });
    GMB.defaultStringServos(strIdx, maxFret).forEach(function (s) { p.servos.push(s); });
    GMB.markDirty();
  }

  // Grow / shrink the instrument to n strings, keeping servos in sync.
  function setStringCount(n) {
    var p = GMB.state.profile;
    n = Math.max(1, Math.min(6, n | 0));
    var cur = p.strings.length;
    var maxFret = cur ? p.strings[cur - 1].maxFret : 12;
    if (n > cur) {
      for (var i = cur; i < n; i++) {
        p.strings.push({ enabled: true, openNote: 40, maxFret: maxFret });
        GMB.defaultStringServos(i, maxFret).forEach(function (s) { p.servos.push(s); });
      }
    } else if (n < cur) {
      p.strings.length = n;
      p.servos = p.servos.filter(function (s) { return s.stringIndex < n; });
    }
    p.instrument.stringCount = n;
    p.stringFretSelection.string.maximum = n;
    p.stringFretSelection.string.mapping = [];
    for (var k = 0; k < n; k++) p.stringFretSelection.string.mapping.push(k);
    GMB.markDirty();
  }

  function stringTabs(onPick) {
    var n = GMB.state.profile.instrument.stringCount;
    if (activeStr >= n) activeStr = n - 1;
    if (activeStr < 0) activeStr = 0;
    var tabs = [];
    for (var i = 0; i < n; i++) {
      (function (idx) {
        tabs.push(h('button.strtab' + (idx === activeStr ? '.active' : ''),
          { onclick: function () { activeStr = idx; if (onPick) onPick(); drawStep(); } },
          'String ' + (idx + 1)));
      })(i);
    }
    return h('div.strtabs', tabs);
  }

  // ---- Arm control + test bench (shared by Frets / Plucking / Test) ----------

  // Arm control + a live armed/not-armed badge (real device state). The hardware
  // servo / note tests only drive the mechanics once the instrument is armed.
  function armToolbar() {
    var badge = h('span.badge', 'checking…');
    function refresh() {
      GMB.api.getStatus().then(function (st) {
        var s = String(st && st.state || '').toUpperCase();
        var armed = s === 'READY' || s === 'READYDEGRADED';
        badge.textContent = armed ? 'Armed' : 'Not armed';
        badge.className = 'badge ' + (armed ? 'ok' : 'warn');
      }).catch(function () { badge.textContent = 'unknown'; badge.className = 'badge'; });
    }
    refresh();
    return h('div.toolbar', [
      GMB.button('Arm for testing', function () {
        GMB.api.resetSystem().then(function (res) {
          if (res && res.ok === false) GMB.toast('Arm refused: ' + (res.error || 'E-stop/invalid config') + '.', 'warn');
          else GMB.toast('Armed — servo / note tests can now drive the hardware.', 'ok');
          refresh();
        }).catch(function (e) { GMB.toast('Arm failed: ' + (e && e.message || e), 'error'); });
      }, 'ghost'),
      badge,
      h('span.muted', 'Tests move the mechanics only while armed.')
    ]);
  }

  // A reusable test-bench panel wired to GMB.testRunner: a status line, a Stop
  // button that reflects the live run state, and one button per group test. Each
  // action is { label, build } where build() returns the step list to sequence
  // (see GMB.testRunner). Empty step lists are reported, never silently ignored.
  function testBench(title, actions) {
    var status = h('span.tb-status', 'Idle');
    var stopBtn = GMB.button('Stop', function () { GMB.testRunner.stop(); }, 'danger');
    stopBtn.disabled = !GMB.testRunner.isRunning();
    // Single live listener — re-registered on every render so the visible bench owns it.
    GMB.testRunner.onState(function (running) {
      stopBtn.disabled = !running;
      if (!running && status.textContent === 'Idle') return;
      if (!running) status.textContent = 'Idle';
    });
    var btns = (actions || []).filter(Boolean).map(function (a) {
      return GMB.button(a.label, function () {
        if (GMB.testRunner.isRunning()) { GMB.toast('A test is already running — Stop it first.', 'warn'); return; }
        var steps = a.build();
        if (!steps || !steps.length) { GMB.toast('Nothing to test: ' + a.label + '.', 'warn'); return; }
        status.textContent = a.label + '…';
        GMB.testRunner.run(steps, {
          onStep: function (s, i, total) {
            if (s && s.label) status.textContent = a.label + ' — ' + s.label + ' (' + (i + 1) + '/' + total + ')';
          },
          onDone: function (cancelled) {
            status.textContent = cancelled ? 'Stopped.' : 'Done.';
            GMB.toast(cancelled ? 'Test stopped.' : (a.label + ' complete.'), cancelled ? 'warn' : 'ok');
          }
        });
      }, 'ghost');
    });
    return h('div.testbench', [
      h('div.tb-head', [h('strong', title || 'Test bench'), h('span.spacer'), status, stopBtn]),
      h('div.tb-actions', btns)
    ]);
  }

  // ---- group-test step builders (fed to GMB.testRunner) ----------------------

  // Sweep every equipped fret of one string: press (exact draft pulse) then release,
  // so an unsaved calibration previews live and each finger is visible in turn.
  function fretSweepSteps(strIdx) {
    var s = GMB.state.profile.strings[strIdx];
    var out = [];
    for (var f = 1; f <= s.maxFret; f++) {
      var sv = fingerFor(strIdx, f);
      if (!sv || !sv.enabled) continue;
      var idx = servoIndexOf(sv);
      if (idx < 0) continue;
      var key = (isGeared(sv) && sv.fretB === f) ? 'activeBUs' : 'activeUs';
      out.push({ kind: 'servo', index: idx, active: true, us: sv[key] | 0, after: 450,
        label: 'S' + (strIdx + 1) + ' fret ' + f });
      out.push({ kind: 'servo', index: idx, active: false, us: sv.restUs | 0, after: 250 });
    }
    return out;
  }
  function allFretsSteps() {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      if (s.enabled) out = out.concat(fretSweepSteps(i));
    });
    return out;
  }
  // Drive every finger of a string back to its rest (lifted) position.
  function allRestSteps(strIdx) {
    var out = [];
    servosOf(strIdx).forEach(function (sv) {
      if (sv.function !== 'finger' || !sv.enabled) return;
      var idx = servoIndexOf(sv);
      if (idx < 0) return;
      out.push({ kind: 'servo', index: idx, active: false, us: sv.restUs | 0, after: 80, label: 'rest' });
    });
    return out;
  }
  // Pluck each enabled open string through the real note path (fret 0 = plectrum only).
  function pluckStringsSteps() {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      if (!s.enabled) return;
      out.push({ kind: 'note', channel: 0, note: s.openNote, velocity: 100, durationMs: 350, after: 650,
        label: 'string ' + (i + 1) + ' (' + GMB.noteName(s.openNote) + ')' });
    });
    return out;
  }
  // Sweep the plectrum / strum servo of each string directly (strike then rest),
  // exercising the plucking mechanics without needing the note map.
  function pluckServoSweepSteps() {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      var sk = strikerFor(i);
      if (!sk || !sk.enabled) return;
      var idx = servoIndexOf(sk);
      if (idx < 0) return;
      out.push({ kind: 'servo', index: idx, active: true, us: sk.activeUs | 0, after: 220,
        label: 'string ' + (i + 1) + ' strike' });
      out.push({ kind: 'servo', index: idx, active: false, us: sk.restUs | 0, after: 350 });
    });
    return out;
  }
  // Demonstrate the strum stroke on each strummed string: a down-stroke then an
  // up-stroke (activeAltUs, or mirrored about rest when 0).
  function strumAltSteps() {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      var sk = strikerFor(i);
      if (!sk || !sk.enabled || sk.function !== 'strum') return;
      var idx = servoIndexOf(sk);
      if (idx < 0) return;
      var up = sk.activeAltUs ? sk.activeAltUs : (2 * sk.restUs - sk.activeUs);
      out.push({ kind: 'servo', index: idx, active: true, us: sk.activeUs | 0, after: 220, label: 'S' + (i + 1) + ' down' });
      out.push({ kind: 'servo', index: idx, active: false, us: sk.restUs | 0, after: 180 });
      out.push({ kind: 'servo', index: idx, active: true, us: up | 0, after: 220, label: 'S' + (i + 1) + ' up' });
      out.push({ kind: 'servo', index: idx, active: false, us: sk.restUs | 0, after: 300 });
    });
    return out;
  }
  // Sweep a per-string optional actuator role (strumLift / damper) where present.
  function roleSweepSteps(fn, verb) {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      var sv = perStringServo(i, fn);
      if (!sv || !sv.enabled) return;
      var idx = servoIndexOf(sv);
      if (idx < 0) return;
      out.push({ kind: 'servo', index: idx, active: true, us: sv.activeUs | 0, after: 300,
        label: 'string ' + (i + 1) + ' ' + verb });
      out.push({ kind: 'servo', index: idx, active: false, us: sv.restUs | 0, after: 300 });
    });
    return out;
  }
  function anyRole(fn) {
    for (var i = 0; i < GMB.state.profile.strings.length; i++)
      if (perStringServo(i, fn)) return true;
    return false;
  }
  // A short ascending run on the active string (open .. up to fret 5), exercising
  // fingering + plucking together through the real note path.
  function scaleSteps(strIdx) {
    var s = GMB.state.profile.strings[strIdx];
    var top = Math.min(5, s.maxFret);
    var out = [];
    for (var f = 0; f <= top; f++) {
      if (f > 0 && !fingerFor(strIdx, f)) continue;   // skip frets with no finger
      out.push({ kind: 'note', channel: 0, note: s.openNote + f, velocity: 100, durationMs: 300, after: 350,
        label: 'S' + (strIdx + 1) + ' fret ' + f });
    }
    return out;
  }
  // End-to-end: on each enabled string, play the open note plus up to two fretted
  // notes, so fingers and plectrum are checked together through the note path.
  function everythingSteps() {
    var out = [];
    GMB.state.profile.strings.forEach(function (s, i) {
      if (!s.enabled) return;
      out.push({ kind: 'note', channel: 0, note: s.openNote, velocity: 100, durationMs: 300, after: 500,
        label: 'S' + (i + 1) + ' open' });
      GMB.availableFrets(GMB.state.profile, i).slice(0, 2).forEach(function (f) {
        out.push({ kind: 'note', channel: 0, note: s.openNote + f, velocity: 100, durationMs: 300, after: 500,
          label: 'S' + (i + 1) + ' fret ' + f });
      });
    });
    return out;
  }

  // ---- render / nav ---------------------------------------------------------

  function render(host) {
    GMB.testRunner.stop();   // never leave a sequence running across a full re-render
    host.appendChild(h('div.card.wizard-card', [
      h('div.stepper', STEPS.map(function (label, i) {
        return h('button.step' + (i === step ? '.active' : '') + (i < step ? '.done' : ''),
          { onclick: function () { goto(i); } },
          [h('span.step-num', String(i + 1)), h('span.step-label', label)]);
      })),
      h('div#wizard-body.wizard-body'),
      h('div.wizard-nav', [
        GMB.button('Back', function () { goto(step - 1); }, 'ghost'),
        h('span.spacer'),
        h('span.muted', 'Step ' + (step + 1) + ' of ' + STEPS.length),
        h('span.spacer'),
        step < STEPS.length - 1
          ? GMB.button('Next', function () { goto(step + 1); }, 'primary')
          : GMB.button('Finish & save', function () { GMB.saveProfile(); }, 'primary')
      ])
    ]));
    drawStep();
  }

  function goto(i) { if (i >= 0 && i < STEPS.length) { step = i; GMB.render(); } }

  function drawStep() {
    GMB.testRunner.stop();   // any config edit / step change cancels a running test
    var body = document.getElementById('wizard-body');
    if (!body) return;
    body.innerHTML = '';
    ([stepBuilder, stepFrets, stepPluck, stepMidi, stepPower,
      stepTest, stepValidation][step])(body);
  }

  // ---- Step 1: Instrument Builder -------------------------------------------
  //
  // One adaptive screen driven by the MECHANICAL choices. The instrument type is
  // cosmetic (tuning + GM tags); the real decisions are the fretting mechanism
  // (chromatic / geared / open / custom) and the sounding mechanism (individual
  // pick vs per-string strum, + optional strum-lift / damper). Those drive
  // GMB.buildInstrument, which generates the servo wiring.

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // A titled builder card. `children` is an array appended after the head.
  function builderSection(title, children, hint) {
    var head = h('div.card-head', [h('h3', title), hint ? h('span.muted', hint) : null]);
    return h('div.card.builder-section', [head].concat(children || []));
  }

  // ---- mechanical-spec derivation (profile has no field for it) --------------

  function fingersOf(i) {
    return GMB.state.profile.servos.filter(function (s) {
      return s.function === 'finger' && s.stringIndex === i;
    });
  }
  // True when the fingers are exactly one plain finger on each fret 1..maxFret.
  function coversChromatic(fingers, maxFret) {
    if (maxFret < 1) return false;
    if (fingers.some(function (f) { return f.fretB >= 1; })) return false;
    var have = {};
    fingers.forEach(function (f) { if (f.fret >= 1) have[f.fret] = 1; });
    for (var fr = 1; fr <= maxFret; fr++) if (!have[fr]) return false;
    return Object.keys(have).length === maxFret;
  }
  // Classify one string's current mechanics from its servo list. 'custom' means the
  // wiring can't be reduced to a preset variant, so regeneration must not touch it.
  function deriveStringSpec(i) {
    var p = GMB.state.profile, s = p.strings[i], fingers = fingersOf(i);
    var fretting;
    if (fingers.length === 0) fretting = 'open';
    else if (fingers.some(function (f) { return f.fretB >= 1; })) fretting = 'geared';
    else if (coversChromatic(fingers, s.maxFret)) fretting = 'chromatic';
    else fretting = 'custom';
    var gt = 6;
    if (fretting === 'geared') { gt = 0; fingers.forEach(function (f) {
      if (f.fretB >= 1) gt = Math.max(gt, f.fret, f.fretB); }); }
    var striker = strikerFor(i);
    return {
      fretting: fretting, gearThreshold: gt,
      sounding: striker && striker.function === 'strum' ? 'strum' : 'pluck',
      lift: !!perStringServo(i, 'strumLift'), damper: !!perStringServo(i, 'damper')
    };
  }
  function modeOf(arr, fallback) {
    var c = {}, best = fallback, bestN = 0;
    arr.forEach(function (v) { var k = String(v); c[k] = (c[k] || 0) + 1;
      if (c[k] > bestN) { bestN = c[k]; best = v; } });
    return best;
  }
  // Build the whole-instrument spec (global + per-string overrides) from the servos.
  function deriveSpec() {
    var specs = GMB.state.profile.strings.map(function (_, i) { return deriveStringSpec(i); });
    var global = {
      fretting: modeOf(specs.map(function (s) { return s.fretting; }), 'chromatic'),
      gearThreshold: Math.max.apply(null, specs.map(function (s) { return s.gearThreshold || 6; }).concat([6])),
      sounding: modeOf(specs.map(function (s) { return s.sounding; }), 'pluck'),
      lift: specs.filter(function (s) { return s.lift; }).length * 2 >= specs.length && specs.some(function (s) { return s.lift; }),
      damper: specs.filter(function (s) { return s.damper; }).length * 2 >= specs.length && specs.some(function (s) { return s.damper; }),
      wiring: 'perString'
    };
    var per = {};
    specs.forEach(function (sp, i) {
      var o = {};
      ['fretting', 'sounding', 'lift', 'damper'].forEach(function (f) {
        if (sp[f] !== global[f]) o[f] = sp[f];
      });
      if (Object.keys(o).length) per[i] = o;
    });
    return { global: global, perString: per };
  }
  // Set the global fretting mechanism. Fretting is an instrument-wide choice (there
  // is no per-string fretting control — only per-string *sounding*), so choosing it
  // clears any per-string fretting override derived from a loaded profile, keeping
  // the global card authoritative.
  function setGlobalFretting(v) {
    builder.global.fretting = v;
    Object.keys(builder.perString).forEach(function (i) {
      if (builder.perString[i].fretting !== undefined) delete builder.perString[i].fretting;
      if (!Object.keys(builder.perString[i]).length) delete builder.perString[i];
    });
    drawStep();
  }
  // The effective spec for string i (global merged with its overrides).
  function effectiveSpec(i) {
    var p = GMB.state.profile, g = builder.global, o = builder.perString[i] || {};
    return {
      maxFret: p.strings[i].maxFret,
      fretting: o.fretting || g.fretting,
      gearThreshold: g.gearThreshold,
      sounding: o.sounding || g.sounding,
      lift: o.lift !== undefined ? o.lift : g.lift,
      damper: o.damper !== undefined ? o.damper : g.damper,
      board: i
    };
  }
  function previewServos() {
    var p = GMB.state.profile;
    return GMB.buildInstrument(effectiveSpec, p.strings, p.servos);
  }
  // Structural signature (ignores calibration µs / channel) so we can tell whether
  // the committed wiring already matches the chosen mechanics.
  function wiringSignature(servos) {
    return servos.filter(function (s) { return s.function !== 'aux'; })
      .map(function (s) { return s.stringIndex + ':' + s.function + ':' + s.fret + ':' + s.fretB; })
      .sort().join('|');
  }
  function syncSelection() {
    var p = GMB.state.profile;
    var maxF = Math.max.apply(null, p.strings.map(function (s) { return s.maxFret; }).concat([0]));
    p.stringFretSelection.string.maximum = p.strings.length;
    p.stringFretSelection.string.mapping = p.strings.map(function (_, i) { return i; });
    p.stringFretSelection.fret.maximum = maxF;
  }
  // Commit the chosen mechanics to p.servos. Preserves aux actuators and any string
  // still classified 'custom' (unless the user explicitly picked a variant for it).
  function applyBuilder() {
    var p = GMB.state.profile;
    var overwrite = p.strings.some(function (_, i) {
      return deriveStringSpec(i).fretting === 'custom' && effectiveSpec(i).fretting !== 'custom';
    });
    if (overwrite && !confirm('Some strings have hand-edited wiring. Replace it with the chosen mechanics?'))
      return false;
    var aux = p.servos.filter(function (s) { return s.function === 'aux'; });
    // Preserve each PCA board's I²C-bus assignment across regeneration (bus is a
    // property of the physical board, not of the mechanical spec being rebuilt).
    var busByBoard = {};
    p.servos.forEach(function (s) { if (s.source === 'pca' && s.i2cBus === 1) busByBoard[s.pcaBoard] = 1; });
    p.servos = GMB.buildInstrument(effectiveSpec, p.strings, p.servos).concat(aux);
    p.servos.forEach(function (s) { if (s.source === 'pca' && busByBoard[s.pcaBoard]) s.i2cBus = 1; });
    ensureBusPins();
    syncSelection();
    GMB.markDirty();
    return true;
  }

  // Load a type preset: tuning + GM tags + a fresh chromatic+pluck wiring.
  function applyPreset(type) {
    var p = GMB.state.profile, t = TUNINGS[type];
    p.instrument.type = type;
    if (GM_PROGRAM[type]) p.instrument.gmProgram = GM_PROGRAM[type];
    if (TYPE_ID[type]) p.instrument.typeId = TYPE_ID[type];
    p.network.hostname = 'gmb-' + type;
    if (t) {
      p.strings = t.notes.map(function (n) { return { enabled: true, openNote: n, maxFret: t.maxFret }; });
      p.instrument.stringCount = t.notes.length;
      builder = { global: { fretting: 'chromatic', gearThreshold: 6, sounding: 'pluck',
        lift: false, damper: false, wiring: 'perString' }, perString: {} };
      builderRef = p;
      var aux = p.servos.filter(function (s) { return s.function === 'aux'; });
      p.servos = GMB.buildInstrument(effectiveSpec, p.strings, []).concat(aux);
      ensureBusPins();   // a preset is single-bus: drop any stale SDA2/SCL2/OE2 pins
      syncSelection();
      GMB.markDirty();
    }
    drawStep();
    GMB.toast('Loaded ' + type + ' — one servo per fret + a plucker per string.', 'ok');
  }

  // ---- how many finger servos a fretting variant produces (live card badge) ---
  function fingerCountForFretting(fretting, gearThreshold, strings) {
    var n = 0;
    strings.forEach(function (s) {
      var mf = s.maxFret || 0;
      if (fretting === 'chromatic') n += mf;
      else if (fretting === 'geared') {
        var end = Math.min(gearThreshold || 6, mf), a = 1, pairs = 0;
        while (a + 1 <= end) { pairs++; a += 2; }
        n += pairs + Math.max(0, mf - (a - 1));
      }
    });
    return n;
  }

  // ---- builder UI atoms ------------------------------------------------------
  function radioCard(selected, title, desc, badge, onClick) {
    return h('button.radio-card' + (selected ? '.selected' : ''),
      { type: 'button', onclick: onClick }, [
        h('div.rc-head', [h('strong', title), badge != null ? h('span.rc-badge', badge) : null]),
        h('div.rc-desc', desc)
      ]);
  }

  // Named-tuning helper + whole-instrument transpose.
  function tuningHelper() {
    var p = GMB.state.profile, n = p.strings.length;
    var opts = [{ value: '', label: 'Tuning preset…' }];
    Object.keys(TUNINGS).forEach(function (t) {
      if (TUNINGS[t].notes.length === n)
        opts.push({ value: t, label: cap(t) + ' (' + TUNINGS[t].notes.map(GMB.noteName).join(' ') + ')' });
    });
    var sel = GMB.input({ v: '' }, 'v', { type: 'select', options: opts, onChange: function (v) {
      if (v && TUNINGS[v]) { p.strings.forEach(function (s, i) {
        if (TUNINGS[v].notes[i] != null) s.openNote = TUNINGS[v].notes[i]; });
        GMB.markDirty(); drawStep(); }
    } });
    function shift(d) { p.strings.forEach(function (s) {
      s.openNote = Math.max(0, Math.min(127, s.openNote + d)); }); GMB.markDirty(); drawStep(); }
    return h('div.tuning-helper', [
      GMB.field('Tuning helper', sel, 'set all open notes at once'),
      h('div.row', [GMB.button('− semitone', function () { shift(-1); }, 'ghost'),
        GMB.button('+ semitone', function () { shift(1); }, 'ghost')])
    ]);
  }

  // One compact string row: enable / open note / max fret + a per-string sounding
  // override (so e.g. one drone string can be strummed while the rest are picked).
  function stringRow(s, i) {
    var cur = (builder.perString[i] || {}).sounding || '';
    var soundSel = GMB.input({ v: cur }, 'v', { type: 'select', options: [
      { value: '', label: 'sound: global' }, { value: 'pluck', label: 'sound: pick' },
      { value: 'strum', label: 'sound: strum' }], onChange: function (v) {
        builder.perString[i] = builder.perString[i] || {};
        if (v) builder.perString[i].sounding = v; else delete builder.perString[i].sounding;
        if (!Object.keys(builder.perString[i]).length) delete builder.perString[i];
        drawStep();
      } });
    return h('div.string-row', [
      h('span.sr-idx', 'String ' + (i + 1)),
      h('label.sr-cell', [GMB.input(s, 'enabled', { type: 'checkbox' }), h('span.muted', 'on')]),
      h('label.sr-cell', [h('span.muted', 'open'),
        GMB.input(s, 'openNote', { type: 'number', min: 0, max: 127, onChange: drawStep })]),
      h('span.sr-note', GMB.noteName(s.openNote)),
      h('label.sr-cell', [h('span.muted', 'max fret'),
        GMB.input(s, 'maxFret', { type: 'number', min: 0, max: 24, onChange: drawStep })]),
      h('span.muted', '→ ' + GMB.noteName(s.openNote + s.maxFret)),
      soundSel
    ]);
  }

  // ---- I²C bus topology (creation): assign PCA boards to bus 0 or bus 1 -------
  // The ESP32-S3 has two hardware I²C controllers; splitting the PCA boards over
  // both buses halves the traffic and refreshes the servos faster on large rigs.

  function distinctPcaBoards() {
    var set = {}, out = [];
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca' && !(s.pcaBoard in set)) { set[s.pcaBoard] = 1; out.push(s.pcaBoard); }
    });
    return out.sort(function (a, b) { return a - b; });
  }
  function anyBus1() { return GMB.state.profile.servos.some(function (s) { return s.source === 'pca' && s.i2cBus === 1; }); }
  function boardBus(board) {
    var s = GMB.state.profile.servos.filter(function (x) { return x.source === 'pca' && x.pcaBoard === board; })[0];
    return s && s.i2cBus === 1 ? 1 : 0;
  }
  function setBoardBus(board, bus) {
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca' && s.pcaBoard === board) s.i2cBus = bus ? 1 : 0;
    });
    ensureBusPins();
    GMB.markDirty();
  }
  // The second-bus signals (SDA2/SCL2) exist in the profile iff a board is on bus 1.
  function ensureBusPins() {
    var p = GMB.state.profile;
    p.pins = p.pins || [];
    var has = function (sig) { return p.pins.some(function (x) { return x.signal === sig; }); };
    if (anyBus1()) {
      var R = GMB.RECOMMENDED || {};
      if (!has('SDA2')) p.pins.push({ signal: 'SDA2', kind: 'sda', gpio: R.SDA2 != null ? R.SDA2 : 38 });
      if (!has('SCL2')) p.pins.push({ signal: 'SCL2', kind: 'scl', gpio: R.SCL2 != null ? R.SCL2 : 39 });
    } else {
      // No board on bus 1 → drop the second bus's signals (incl. its /OE).
      p.pins = p.pins.filter(function (x) { return x.signal !== 'SDA2' && x.signal !== 'SCL2' && x.signal !== 'SERVO_OE2'; });
    }
  }
  // Split /OE per bus (adds SERVO_OE2) or keep it shared (removes it).
  function hasOe2() { return (GMB.state.profile.pins || []).some(function (x) { return x.signal === 'SERVO_OE2'; }); }
  function setSplitOe(on) {
    var p = GMB.state.profile; p.pins = p.pins || [];
    if (on) {
      if (!hasOe2()) {
        var R = GMB.RECOMMENDED || {};
        p.pins.push({ signal: 'SERVO_OE2', kind: 'servoOe', gpio: R.SERVO_OE2 != null ? R.SERVO_OE2 : 21 });
      }
    } else {
      p.pins = p.pins.filter(function (x) { return x.signal !== 'SERVO_OE2'; });
    }
    GMB.markDirty();
  }
  // Distribute the boards evenly across the two buses (first half → bus 0).
  function autoSplitBuses() {
    var boards = distinctPcaBoards(), half = Math.ceil(boards.length / 2);
    boards.forEach(function (b, i) { setBoardBus(b, i >= half ? 1 : 0); });
  }
  function setSecondBus(on) {
    if (on) { if (!anyBus1()) autoSplitBuses(); }
    else {
      GMB.state.profile.servos.forEach(function (s) { if (s.source === 'pca') s.i2cBus = 0; });
      ensureBusPins(); GMB.markDirty();
    }
  }

  // The Builder's I²C-bus control: a toggle, per-board bus pickers and auto-split.
  function busTopology() {
    var boards = distinctPcaBoards();
    var two = anyBus1();
    var R = GMB.RECOMMENDED || {};
    var toggle = h('input', { type: 'checkbox', checked: two });
    toggle.addEventListener('change', function () { setSecondBus(toggle.checked); drawStep(); });
    var kids = [h('label.inline.builder-opt', [toggle,
      h('span', 'Use a second I²C bus — split the PCA9685 boards across the ESP32-S3’s two I²C controllers ' +
        '(Wire + Wire1) to cut bus traffic and refresh the servos faster on large instruments')])];
    if (two) {
      var n0 = boards.filter(function (b) { return boardBus(b) === 0; }).length;
      kids.push(h('div.bus-grid', boards.map(function (b) {
        var sel = GMB.input({ v: boardBus(b) }, 'v', { type: 'select', coerce: Number,
          options: [{ value: 0, label: 'Bus 0' }, { value: 1, label: 'Bus 1' }],
          onChange: function (v) { setBoardBus(b, Number(v)); drawStep(); } });
        return h('div.bus-board', [h('span.bus-board-id', 'PCA #' + b + ' · 0x' + (0x40 + b).toString(16)), sel]);
      })));
      kids.push(h('div.row', [
        GMB.button('Auto-split evenly', function () { autoSplitBuses(); drawStep(); }, 'ghost'),
        h('span.muted', 'Bus 0: ' + n0 + ' · Bus 1: ' + (boards.length - n0) + ' board(s). ' +
          'Assign the SDA2 / SCL2 pins on the GPIO Pins tab (default GPIO' +
          (R.SDA2 != null ? R.SDA2 : 38) + ' / GPIO' + (R.SCL2 != null ? R.SCL2 : 39) + ').')
      ]));
      var oeToggle = h('input', { type: 'checkbox', checked: hasOe2() });
      oeToggle.addEventListener('change', function () { setSplitOe(oeToggle.checked); drawStep(); });
      kids.push(h('label.inline.builder-opt', [oeToggle,
        h('span', 'Separate the /OE safety line per bus (adds SERVO_OE2, default GPIO' +
          (R.SERVO_OE2 != null ? R.SERVO_OE2 : 21) + ') — otherwise both buses share the single /OE line')]));
    }
    return h('div.bus-topology', kids);
  }

  // PCA9685 channel usage per (bus, board) + direct-GPIO count vs firmware limits.
  function capacityReport() {
    var preview = previewServos().concat(auxServos());
    // Preview servos are regenerated without a bus, so overlay the committed
    // board→bus assignment (a board's bus is a property of its physical wiring).
    var busOfBoard = {};
    GMB.state.profile.servos.forEach(function (s) { if (s.source === 'pca' && s.i2cBus === 1) busOfBoard[s.pcaBoard] = 1; });
    var byKey = {}, direct = 0;
    preview.forEach(function (s) {
      if (s.source === 'gpio') { direct++; return; }
      var bus = busOfBoard[s.pcaBoard] ? 1 : 0, k = bus + ':' + s.pcaBoard;
      byKey[k] = byKey[k] || { bus: bus, board: s.pcaBoard, n: 0 };
      byKey[k].n++;
    });
    var two = anyBus1();
    var keys = Object.keys(byKey).sort(function (a, b) {
      return byKey[a].bus - byKey[b].bus || byKey[a].board - byKey[b].board;
    });
    var rows = keys.map(function (k) {
      var e = byKey[k], over = e.n > 16, pct = Math.min(100, e.n / 16 * 100);
      return h('div.cap-line', [
        h('span.cap-label', (two ? 'Bus ' + e.bus + ' · ' : '') + 'PCA ' + e.board),
        h('div.cap-bar' + (over ? '.over' : ''), h('span', { style: 'width:' + pct + '%' })),
        h('span.cap-val', e.n + ' / 16' + (over ? ' — overflow' : ''))
      ]);
    });
    var warn = [];
    [0, 1].forEach(function (bus) {
      var count = keys.filter(function (k) { return byKey[k].bus === bus; }).length;
      if (count > 8) warn.push((two ? 'Bus ' + bus + ': ' : '') + count + ' PCA boards — at most 8 per I²C bus.');
    });
    if (direct > 8) warn.push(direct + ' direct-GPIO servos — at most 8 allowed.');
    keys.forEach(function (k) { var e = byKey[k]; if (e.n > 16)
      warn.push('PCA ' + e.board + ' needs ' + e.n + ' channels (max 16) — spread servos across more boards.'); });
    return h('div.capacity-meter', rows.concat(warn.map(function (w) { return h('div.pill.warn', w); })));
  }

  function stepBuilder(body) {
    var p = GMB.state.profile;
    if (builder === null || builderRef !== p) { builder = deriveSpec(); builderRef = p; }
    var g = builder.global, strings = p.strings;

    body.appendChild(h('div.note-box',
      'Build the instrument from its mechanics. Pick a starting point, set the tuning, ' +
      'then choose how the strings are fretted and sounded — the servo wiring is generated ' +
      'for you. The type is only cosmetic; the real choices are the mechanisms below.'));

    // 1 · Instrument identity + presets.
    var TYPES = ['ukulele', 'guitar', 'bass', 'mandolin', 'banjo'];
    var presets = TYPES.map(function (t) {
      return h('button.preset-card' + (p.instrument.type === t ? '.selected' : ''),
        { type: 'button', onclick: function () { applyPreset(t); } },
        [h('strong', cap(t)), h('span.muted', TUNINGS[t].notes.length + ' strings')]);
    });
    presets.push(h('button.preset-card' + (TYPES.indexOf(p.instrument.type) < 0 ? '.selected' : ''),
      { type: 'button', onclick: function () { p.instrument.type = 'custom'; GMB.markDirty(); drawStep(); } },
      [h('strong', 'Custom'), h('span.muted', 'your own')]));
    body.appendChild(builderSection('1 · Instrument', [
      h('div.preset-row', presets),
      h('div.grid2', [
        GMB.field('Instrument name', GMB.input(p.instrument, 'name')),
        GMB.field('Description', GMB.input(p.instrument, 'description'))
      ]),
      GMB.isAdvanced() ? h('div.grid3', [
        GMB.field('Capo', GMB.input(p.instrument, 'capo', { type: 'number', min: 0, max: 24 }),
          'décalage virtuel (agit comme transpose) — laisser à 0 : pas de barre physique'),
        GMB.field('Transpose', GMB.input(p.instrument, 'transpose', { type: 'number', min: -48, max: 48 }),
          'décalage global en demi-tons (à privilégier au capo)'),
        GMB.field('GM program', GMB.input(p.instrument, 'gmProgram', { type: 'number', min: 0, max: 127 })),
        GMB.field('GMB type id', GMB.input(p.instrument, 'typeId', { type: 'number', min: 0, max: 127 }))
      ]) : null
    ], 'type is cosmetic (tags name / GM only)'));

    // 2 · Strings & tuning.
    body.appendChild(builderSection('2 · Strings & tuning', [
      h('div.row', [
        GMB.field('Number of strings', GMB.input(p.instrument, 'stringCount',
          { type: 'number', min: 1, max: 6, onChange: function (v) { setStringCount(v); drawStep(); } })),
        tuningHelper()
      ]),
      h('div.string-rows', strings.map(function (s, i) { return stringRow(s, i); }))
    ]));

    // 3 · Fretting mechanism.
    var fretExtra = [];
    if (g.fretting === 'geared')
      fretExtra.push(GMB.field('Gear frets up to', GMB.input(g, 'gearThreshold',
        { type: 'number', min: 2, max: 24, onChange: drawStep }),
        'frets 1..N are paired two-per-servo; higher frets stay single'));
    body.appendChild(builderSection('3 · Fretting mechanism', [
      h('div.radio-row', [
        radioCard(g.fretting === 'chromatic', 'One servo per fret',
          'A dedicated finger on every fret — maximum range, most servos.',
          fingerCountForFretting('chromatic', g.gearThreshold, strings) + ' fingers',
          function () { setGlobalFretting('chromatic'); }),
        radioCard(g.fretting === 'geared', 'Geared low neck',
          'Pair the wide low frets on one antagonistic servo each; narrow high frets stay single. Halves the low-neck servo count.',
          fingerCountForFretting('geared', g.gearThreshold, strings) + ' fingers',
          function () { setGlobalFretting('geared'); }),
        radioCard(g.fretting === 'open', 'Open string only',
          'No frets — each string plays its open note only (slide / open tunings).',
          '0 fingers', function () { setGlobalFretting('open'); }),
        radioCard(g.fretting === 'custom', 'Custom',
          'Keep the current per-fret wiring; equip frets yourself on the Frets step.',
          null, function () { setGlobalFretting('custom'); })
      ])
    ].concat(fretExtra.length ? [h('div.row', fretExtra)] : [])));

    // 4 · Sounding mechanism.
    body.appendChild(builderSection('4 · Sounding mechanism', [
      h('div.radio-row', [
        radioCard(g.sounding === 'pluck', 'Individual pick',
          'One plectrum per string — best for chords, repeated notes, tremolo and per-string velocity.',
          null, function () { g.sounding = 'pluck'; drawStep(); }),
        radioCard(g.sounding === 'strum', 'Per-string strum',
          'A strum servo per string with up/down strokes. (Actuated only when the string has no pick.)',
          null, function () { g.sounding = 'strum'; drawStep(); })
      ]),
      h('label.inline.builder-opt', [GMB.input(g, 'lift', { type: 'checkbox', onChange: drawStep }),
        h('span', 'Add strum lift — raises the striker off the string between strokes')]),
      h('label.inline.builder-opt', [GMB.input(g, 'damper', { type: 'checkbox', onChange: drawStep }),
        h('span', 'Add a per-string damper — presses the string to mute it')])
    ], 'sound each string with a pick or a strum'));

    // 5 · Wiring & capacity.
    body.appendChild(builderSection('5 · Wiring & capacity', [
      h('p.muted', 'Default: one PCA9685 board per string (its fingers + striker share the 16 channels), all on ' +
        'a single I²C bus. Switch individual servos to a direct GPIO on the Frets / Plucking steps.'),
      busTopology(),
      capacityReport()
    ]));

    if (GMB.isAdvanced()) body.appendChild(builderSection('Board & network', [
      h('div.grid2', [
        GMB.field('Reserve native USB (GPIO19/20)', GMB.input(p.board, 'reserveUsb', { type: 'checkbox' })),
        GMB.field('Network mode', GMB.input(p.network, 'mode',
          { type: 'select', options: [{ value: 'accessPoint', label: 'Access point' }, { value: 'station', label: 'Wi-Fi client' }] })),
        GMB.field('AP SSID', GMB.input(p.network, 'apSsid')),
        GMB.field('Station SSID', GMB.input(p.network, 'ssid')),
        GMB.field('Hostname', GMB.input(p.network, 'hostname'))
      ])
    ]));

    // 6 · Generate.
    var preview = previewServos(), auxN = auxServos().length;
    var pending = wiringSignature(p.servos) !== wiringSignature(preview);
    var boards = {}; preview.forEach(function (s) { if (s.source === 'pca') boards[s.pcaBoard] = 1; });
    body.appendChild(builderSection('6 · Generate wiring', [
      h('div.summary', [
        h('div', [h('strong', strings.length + ' strings'),
          ' · fretting ' + g.fretting + ' · sounding ' + g.sounding +
          (g.lift ? ' + lift' : '') + (g.damper ? ' + damper' : '')]),
        h('div.muted', (preview.length + auxN) + ' servos total across ' +
          Object.keys(boards).length + ' PCA board(s)')
      ]),
      pending ? h('div.pill.warn', 'Pending — click Generate to apply your mechanical choices.')
              : h('div.pill.ok', 'Wiring matches your choices.'),
      h('div.row', [
        GMB.button('Generate wiring', function () {
          if (applyBuilder()) { GMB.toast('Wiring generated.', 'ok'); drawStep(); }
        }, 'primary'),
        GMB.button('Next: calibrate frets →', function () { goto(1); }, 'ghost')
      ])
    ]));
  }

  // ---- direct-GPIO pin picker (same rules as the GPIO Pins tab) -------------

  // Board capability model. The ESP32-S3-DevKitC-1 is the only supported board and
  // GMB.mockBoard() is a faithful mirror of the firmware BoardProfile, so it is used
  // synchronously as the pin source; on a real device we also fetch the active board
  // profile once (/api/board) and re-render when it arrives, in case it ever differs.
  var boardModel = null, boardTried = false;
  function boardPins() {
    if (boardModel && boardModel.pins) return boardModel.pins;
    var fb = (GMB.mockBoard && GMB.mockBoard()) || { pins: [] };
    if (!boardTried) {
      boardTried = true;
      var id = (GMB.state.profile.board && GMB.state.profile.board.profile) || fb.identifier;
      GMB.api.getBoard(id).then(function (b) {
        if (b && b.pins) { boardModel = b; if (GMB.state.current === 'wizard') drawStep(); }
      }).catch(function () {});
    }
    return fb.pins || [];
  }

  // GPIOs already taken by a board signal (SDA/SCL/OE…) or another direct servo,
  // each mapped to a short label explaining the clash. `self` is excluded.
  function usedGpios(self) {
    var p = GMB.state.profile, used = {};
    p.pins.forEach(function (a) { if (a.gpio >= 0) used[a.gpio] = a.signal || 'signal'; });
    p.servos.forEach(function (s) {
      if (s !== self && s.enabled && s.source === 'gpio' && s.gpio >= 0)
        used[s.gpio] = (s.function || 'servo') + (s.stringIndex >= 0 ? ' S' + (s.stringIndex + 1) : '');
    });
    return used;
  }

  // A <select> of output-capable GPIOs for a direct servo: reserved / USB-reserved /
  // already-used pins are filtered out (same capability rules as the Pins tab), so a
  // user can only pick a pin the firmware will accept. The current pin stays listed
  // even if it now conflicts, so switching source never silently drops a value.
  function servoGpioSelect(sv) {
    var used = usedGpios(sv);
    var reserveUsb = GMB.state.profile.board && GMB.state.profile.board.reserveUsb;
    var sel = h('select');
    sel.appendChild(h('option', { value: -1, selected: !(sv.gpio >= 0) }, '— select a GPIO —'));
    var seen = {};
    boardPins().forEach(function (cap) {
      if (used[cap.gpio]) return;
      if (cap.reserved || cap.preference === 'reserved') return;
      if (cap.usb && reserveUsb) return;
      if (cap.preference === 'caution' && !GMB.isAdvanced()) return;
      if (!GMB.pinSupports(cap, 'servo')) return;
      seen[cap.gpio] = true;
      sel.appendChild(h('option', { value: cap.gpio, selected: cap.gpio === sv.gpio },
        'GPIO' + cap.gpio + (cap.preference === 'caution' ? ' (caution)' : '')));
    });
    if (sv.gpio >= 0 && !seen[sv.gpio]) {
      var why = used[sv.gpio] ? ' — conflict: ' + used[sv.gpio] : ' (current)';
      sel.appendChild(h('option', { value: sv.gpio, selected: true }, 'GPIO' + sv.gpio + why));
    }
    sel.addEventListener('change', function () {
      sv.gpio = Number(sel.value); GMB.markDirty(); drawStep();
    });
    return sel;
  }

  // Wiring editor for ONE servo — its signal source (PCA9685 channel or a direct
  // ESP32 GPIO) — reused for every role: fingers, pluckers, strum-lift, damper, aux.
  function servoSourceEditor(sv) {
    var srcSel = GMB.input(sv, 'source', {
      type: 'select', options: [{ value: 'pca', label: 'PCA9685' }, { value: 'gpio', label: 'Direct GPIO' }],
      onChange: drawStep
    });
    var fields = [GMB.field('Source', srcSel)];
    if (sv.source === 'gpio') {
      fields.push(GMB.field('GPIO', servoGpioSelect(sv), 'output-capable free pins only'));
    } else {
      fields.push(GMB.field('PCA board', GMB.input(sv, 'pcaBoard', { type: 'number', min: 0, max: 7 })));
      fields.push(GMB.field('I²C bus', GMB.input(sv, 'i2cBus', {
        type: 'select', coerce: Number, options: [{ value: 0, label: 'Bus 0' }, { value: 1, label: 'Bus 1' }],
        onChange: function () { ensureBusPins(); drawStep(); } }), 'SDA/SCL (0) or SDA2/SCL2 (1)'));
      fields.push(GMB.field('Channel', GMB.input(sv, 'channel', { type: 'number', min: 0, max: 15 })));
    }
    return fields;
  }

  // A degree slider bound to sv[key] (rest / active / activeB) with a live readout.
  // Sets the value while dragging and drives the servo to that exact pulse on release
  // (when armed) so the angle previews on the hardware. label === null renders just
  // the slider row (a compact inline cell); otherwise it is a labelled field.
  // onCommit (optional) fires on release, after the test — used to mark progress.
  function angleSlider(sv, key, label, hint, onCommit) {
    var deg = GMB.usToAngle(sv, sv[key]);
    var slider = h('input.install-slider', { type: 'range', min: 0, max: 180, value: deg });
    var readout = h('span.install-deg', deg + '°');
    slider.addEventListener('input', function () {
      readout.textContent = slider.value + '°';
      sv[key] = GMB.angleToUs(sv, Number(slider.value));
    });
    slider.addEventListener('change', function () {
      GMB.markDirty();
      var idx = servoIndexOf(sv);
      if (idx >= 0) GMB.api.testServo({ index: idx, active: true, us: sv[key] | 0 }).catch(function () {});
      if (onCommit) onCommit();
    });
    var row = h('div.install-slider-row', [slider, readout]);
    return label ? GMB.field(label, row, hint) : row;
  }

  function testServoBtn(label, sv, active) {
    return GMB.button(label, function () {
      var idx = servoIndexOf(sv);
      if (idx < 0) return;
      // Send the DRAFT pulse (activeUs/restUs read at click time) so an unsaved
      // calibration angle previews live, instead of the currently-active profile's.
      var us = (active ? sv.activeUs : sv.restUs) | 0;
      GMB.api.testServo({ index: idx, active: active, us: us }).then(function () {
        GMB.toast('Servo ' + idx + (active ? ' → contact' : ' → rest'), 'ok');
      }).catch(function () { GMB.toast('Servo test refused (arm the instrument first).', 'warn'); });
    }, 'ghost');
  }

  // Drive a servo to the EXACT draft pulse held in sv[key] (read at click time), so
  // a not-yet-saved calibration angle — including a geared finger's neutral / side-B
  // — can be previewed live on the hardware.
  function testPulseBtn(label, sv, key, toastMsg) {
    return GMB.button(label, function () {
      var idx = servoIndexOf(sv);
      if (idx < 0) return;
      GMB.api.testServo({ index: idx, active: true, us: sv[key] | 0 }).then(function () {
        GMB.toast(toastMsg || ('Servo ' + idx + ' → ' + (sv[key] | 0) + ' µs'), 'ok');
      }).catch(function () { GMB.toast('Servo test refused (arm the instrument first).', 'warn'); });
    }, 'ghost');
  }

  // Play one real note (string open pitch + fret) through the note path.
  function playNoteBtn(strIdx, fret, label) {
    var note = GMB.state.profile.strings[strIdx].openNote + fret;
    return GMB.button(label || ('▶ Play ' + GMB.noteName(note)), function () {
      GMB.api.testNote({ channel: 0, note: note, velocity: 100, durationMs: 400 })
        .then(function () { GMB.toast('Playing ' + GMB.noteName(note), 'ok'); })
        .catch(function () { GMB.toast('Play refused (arm the instrument first).', 'warn'); });
    }, 'primary');
  }

  // Mark a fret (both frets of a geared pair) calibrated and collapse its editor.
  function markFretDone(strIdx, sv, fret) {
    calibratedFrets[strIdx + ':' + fret] = true;
    expandedFrets[strIdx + ':' + fret] = false;
    if (isGeared(sv)) {
      calibratedFrets[strIdx + ':' + sv.fret] = true;
      calibratedFrets[strIdx + ':' + sv.fretB] = true;
      expandedFrets[strIdx + ':' + sv.fret] = false;
    }
    GMB.markDirty();
  }

  // ---- Step 2: Frets (frettes) — finger servos only -------------------------

  // A clickable fret strip for the active string: shows which frets carry a finger
  // (geared marked ⚙) and this-session calibration progress, and expands a row when
  // clicked so the strip doubles as a guided calibration overview.
  function fretCoverage(strIdx) {
    var s = GMB.state.profile.strings[strIdx];
    var chips = [];
    for (var f = 1; f <= s.maxFret; f++) {
      (function (fret) {
        var key = strIdx + ':' + fret;
        var sv = fingerFor(strIdx, fret);
        var cls = !sv ? 'none' : (calibratedFrets[key] ? 'done' : 'todo');
        if (expandedFrets[key]) cls += ' current';
        chips.push(h('button', {
          class: 'fret-chip ' + cls,
          title: sv ? (isGeared(sv) ? 'geared servo — click to calibrate' : 'has servo — click to calibrate')
                    : 'not equipped',
          onclick: function () {
            if (sv) { var owner = isGeared(sv) ? sv.fret : fret; expandedFrets[strIdx + ':' + owner] = true; }
            drawStep();
          }
        }, String(fret) + (sv && isGeared(sv) ? '⚙' : '')));
      })(f);
    }
    return h('div.fret-progress', [
      h('div.fret-chips', chips),
      h('div.fret-legend', [
        h('span.lg', [h('span.fret-chip.mini.done'), 'calibrated']),
        h('span.lg', [h('span.fret-chip.mini.todo'), 'to do']),
        h('span.lg', [h('span.fret-chip.mini.none'), 'no servo'])
      ])
    ]);
  }

  // One compact line per fret. Simplified mode shows only what a player tweaks —
  // equipped / geared / contact angle / calibrate; wiring (source, board, channel)
  // and fine timing live in the per-row "Calibrate" editor, which exposes wiring
  // only in Advanced mode.
  function fretLine(strIdx, fret) {
    var p = GMB.state.profile;
    var note = GMB.noteName(p.strings[strIdx].openNote + fret);
    var sv = fingerFor(strIdx, fret);
    var id = h('div.fret-line-id', [h('strong', 'Fret ' + fret), h('span.muted', note)]);

    if (!sv) {
      return h('div.fret-line.empty', [id, h('span.spacer'),
        h('span.muted', 'not equipped'),
        GMB.button('+ Add servo', function () { addFinger(strIdx, fret); drawStep(); }, 'ghost')]);
    }
    // Side-B fret of a geared servo: it is edited on its side-A (owner) row.
    if (isGeared(sv) && sv.fret !== fret) {
      return h('div.fret-line', [id,
        h('span.muted', '↳ side B of the geared servo on fret ' + sv.fret),
        h('span.spacer'),
        GMB.button('Edit on fret ' + sv.fret, function () {
          expandedFrets[strIdx + ':' + sv.fret] = true; drawStep();
        }, 'ghost')]);
    }
    var geared = isGeared(sv);
    var gearCb = h('input', { type: 'checkbox' });
    gearCb.checked = geared;
    gearCb.addEventListener('change', function () { setGeared(sv, gearCb.checked, strIdx); drawStep(); });

    var ekey = strIdx + ':' + fret;
    var open = !!expandedFrets[ekey];
    var line = h('div.fret-line', [
      id,
      h('label.fret-gear', [gearCb, h('span', 'gear')]),
      h('div.fret-slider-cell', [
        h('span.muted.fret-slider-lbl', geared ? 'press A' : 'contact'),
        angleSlider(sv, 'activeUs', null)
      ]),
      GMB.button(open ? 'Calibrate ▾' : 'Calibrate ▸', function () { expandedFrets[ekey] = !open; drawStep(); }, 'ghost'),
      GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')
    ]);
    if (!open) return line;

    // Inline guided calibration for this fret (folds in the old Install helper): set
    // the contact / rest angle, preview each on the hardware, play the note, mark done.
    var detail = [];
    if (geared) {
      detail.push(GMB.field('Second fret (side B)', GMB.input(sv, 'fretB',
        { type: 'number', min: 1, max: 24, onChange: drawStep,
          coerce: function (v) { return (v === null || v === '' || v < 1) ? -1 : (v | 0); } }),
        'the other fret this servo presses'));
      detail.push(angleSlider(sv, 'activeUs', 'Press A angle', 'side A (fret ' + sv.fret + ')'));
      detail.push(angleSlider(sv, 'activeBUs', 'Press B angle', 'side B (fret ' + sv.fretB + ')'));
      detail.push(angleSlider(sv, 'restUs', 'Neutral angle', 'both fingers lifted'));
      detail.push(GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' })));
      var _lo = Math.min(sv.activeUs, sv.activeBUs), _hi = Math.max(sv.activeUs, sv.activeBUs);
      if (!(sv.restUs > _lo && sv.restUs < _hi))
        detail.push(h('div.pill.warn.fret-warn',
          '⚠ Neutral should sit between press A and press B so both fingers lift off.'));
      detail.push(h('div.row', [
        testPulseBtn('Neutral', sv, 'restUs', 'Servo → neutral'),
        testPulseBtn('Press A', sv, 'activeUs', 'Servo → press A'),
        testPulseBtn('Press B', sv, 'activeBUs', 'Servo → press B'),
        playNoteBtn(strIdx, sv.fret, '▶ Play A'),
        playNoteBtn(strIdx, sv.fretB, '▶ Play B'),
        GMB.button('Mark calibrated ✓', function () { markFretDone(strIdx, sv, fret); drawStep(); }, 'ghost')
      ]));
    } else {
      detail.push(angleSlider(sv, 'activeUs', 'Contact angle', 'finger pressing the fret'));
      detail.push(angleSlider(sv, 'restUs', 'Rest angle', 'finger lifted off the string'));
      detail.push(GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' })));
      if (Math.abs(GMB.usToAngle(sv, sv.activeUs) - GMB.usToAngle(sv, sv.restUs)) < 5)
        detail.push(h('div.pill.warn.fret-warn',
          '⚠ Contact and rest angle are nearly equal — the finger may not press the string.'));
      detail.push(h('div.row', [
        testServoBtn('Test rest', sv, false),
        testServoBtn('Test contact', sv, true),
        playNoteBtn(strIdx, fret),
        GMB.button('Apply angle to all frets', function () { applyContactToAll(strIdx, sv); drawStep(); }, 'ghost'),
        GMB.button('Mark calibrated ✓', function () { markFretDone(strIdx, sv, fret); drawStep(); }, 'ghost')
      ]));
    }
    if (GMB.isAdvanced()) {
      detail.push(h('div.grid3', servoSourceEditor(sv).concat([
        GMB.field('Pulse min (µs)', GMB.input(sv, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Pulse max (µs)', GMB.input(sv, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Cut PWM at rest', GMB.input(sv, 'disableAtRest', { type: 'checkbox' })),
        // Disable keeps the calibration but drops this fret from play (unlike Remove,
        // which deletes it) — audit G7.
        GMB.field('Enabled', GMB.input(sv, 'enabled', { type: 'checkbox', onChange: drawStep }))
      ])));
    }
    return h('div.fret-line-wrap', [line, h('div.fret-detail', detail)]);
  }

  // Guard-rail helper: copy one plain finger's contact + rest angle to every other
  // PLAIN finger on the same string (geared fingers keep their own three positions).
  function applyContactToAll(strIdx, sv) {
    var n = 0;
    GMB.state.profile.servos.forEach(function (s) {
      if (s.function === 'finger' && s.stringIndex === strIdx && s.fretB < 1 && s !== sv) {
        s.activeUs = sv.activeUs; s.restUs = sv.restUs; n++;
      }
    });
    GMB.markDirty();
    GMB.toast('Applied the contact / rest angle to ' + n + ' other fret(s).', 'ok');
  }

  // Copy the active string's finger + gearing + calibration to every other string
  // (one PCA board per string) as a starting point to fine-tune per string.
  function copyStringFingers(fromIdx) {
    var p = GMB.state.profile;
    var src = p.servos.filter(function (s) { return s.stringIndex === fromIdx && s.function === 'finger'; });
    for (var j = 0; j < p.strings.length; j++) {
      if (j === fromIdx) continue;
      p.servos = p.servos.filter(function (s) { return !(s.stringIndex === j && s.function === 'finger'); });
      src.forEach(function (s) {
        var c = GMB.deepCopy(s);
        c.stringIndex = j;
        c.pcaBoard = j;  // one-PCA-per-string convention
        p.servos.push(c);
      });
    }
    GMB.markDirty();
  }

  function pcaMap(strIdx) {
    var used = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca') used[s.pcaBoard + ':' + s.channel] = s;
    });
    var board = strIdx;  // show this string's board
    var chips = [];
    for (var c = 0; c < 16; c++) {
      var key = board + ':' + c;
      var s = used[key];
      var cls = s ? (s.function === 'finger' ? 'used' : 'strike') : 'free';
      chips.push(h('span.chan-chip.' + cls, s ? (s.function === 'finger'
        ? ('f' + s.fret + (s.fretB >= 1 ? '/' + s.fretB : '')) : s.function.charAt(0)) : c));
    }
    return h('div', [h('span.muted', 'PCA board ' + board + ' channels: '), h('span.chan-map', chips)]);
  }

  // Equip a plain finger on every not-yet-equipped fret of a string (leaves the
  // striker and any geared fingers untouched — used by the open-only banner).
  function equipAllFrets(strIdx) {
    var s = GMB.state.profile.strings[strIdx];
    for (var f = 1; f <= s.maxFret; f++) if (!fingerFor(strIdx, f)) addFinger(strIdx, f);
    GMB.markDirty();
  }

  function stepFrets(body) {
    var p = GMB.state.profile;
    var s = p.strings[activeStr];
    body.appendChild(h('div.note-box',
      'Frets (frettes): one dedicated finger servo per fret presses the string. Equip ' +
      'each fret (gaps allowed), or pair two frets on one geared servo. Click a fret to ' +
      'calibrate its contact angle, preview it live and play the note. Test one finger, ' +
      'or sweep the whole string, from the test bench.'));

    body.appendChild(armToolbar());
    body.appendChild(testBench('Fret test bench', [
      { label: 'Sweep this string', build: function () { return fretSweepSteps(activeStr); } },
      { label: 'Sweep all strings', build: allFretsSteps },
      { label: 'All fingers to rest', build: function () { return allRestSteps(activeStr); } }
    ]));

    body.appendChild(stringTabs());
    if (GMB.isAdvanced()) body.appendChild(pcaMap(activeStr));

    // Adaptive: an open-only string (chosen in the Builder) has no fret rows to
    // calibrate — surface that clearly with a one-click way to equip frets.
    if (s.maxFret > 0 && GMB.availableFrets(p, activeStr).length === 0)
      body.appendChild(h('div.note-box', [
        'This string is open-only — no frets equipped, so it plays its open note only. ',
        GMB.button('Equip frets 1–' + s.maxFret, function () { equipAllFrets(activeStr); drawStep(); }, 'ghost')
      ]));

    var lines = [];
    for (var f = 1; f <= s.maxFret; f++) lines.push(fretLine(activeStr, f));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Finger servos · string ' + (activeStr + 1)),
        h('div.row', [
          GMB.button('Auto-wire all frets', function () { autoWireString(activeStr); drawStep(); }, 'ghost'),
          p.strings.length > 1
            ? GMB.button('Copy to all strings', function () {
                if (confirm('Copy this string’s finger servos (and calibration) to all other strings?')) {
                  copyStringFingers(activeStr); drawStep();
                }
              }, 'ghost')
            : null
        ])]),
      s.maxFret > 0 ? fretCoverage(activeStr) : null,
      s.maxFret > 0 ? h('div.fret-lines', lines)
        : h('p.muted', 'Max fret is 0 — this string plays open only (no frets).')
    ]));
  }

  // ---- Step 3: Plucking (grattage) — plucker + strum lift + damper + aux -----

  // Shared editor body for a non-finger, non-plucker actuator: rest/active angles,
  // a live test, and — in Advanced mode — the full wiring (source incl. direct GPIO)
  // plus pulse/timing. Used for strum-lift, damper and auxiliary servos so every one
  // of them can sit on a PCA channel OR a direct ESP32 GPIO, exactly like a finger.
  function extraActuatorEditor(sv, hints) {
    hints = hints || {};
    var rows = [
      angleSlider(sv, 'restUs', 'Rest angle', hints.rest),
      angleSlider(sv, 'activeUs', 'Active angle', hints.active)
    ];
    if (sv.function === 'strumLift')
      rows.push(GMB.field('Engage delay (ms)', GMB.input(sv, 'engageDelayMs',
        { type: 'number', min: 0, max: 500 }), 'pause after the lift is down before the stroke fires'));
    rows.push(GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' })));
    var block = [
      h('div.grid2', rows),
      h('div.row', [testServoBtn('Test rest', sv, false), testServoBtn('Test active', sv, true)])
    ];
    if (GMB.isAdvanced())
      block.push(h('div.grid3', servoSourceEditor(sv).concat([
        GMB.field('Pulse min (µs)', GMB.input(sv, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Pulse max (µs)', GMB.input(sv, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Cut PWM at rest', GMB.input(sv, 'disableAtRest', { type: 'checkbox' }))
      ])));
    return block;
  }

  function actuatorBlock(title, sv, hints) {
    return h('div.actuator', [
      h('div.actuator-head', [h('strong', title),
        GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')]),
      extraActuatorEditor(sv, hints)
    ]);
  }

  // Global auxiliary actuators (not tied to a string; stringIndex -1): any extra
  // servo, each on a PCA channel or a direct GPIO.
  function auxCard() {
    var list = auxServos();
    var items = list.map(function (sv, k) {
      return actuatorBlock('Auxiliary #' + (k + 1), sv,
        { rest: 'idle position', active: 'actuated position' });
    });
    items.push(h('div.row', [
      GMB.button('+ Add auxiliary actuator', function () { addRoleServo('aux', -1); drawStep(); }, 'ghost')
    ]));
    return h('div.card', [
      h('div.card-head', [h('h3', 'Auxiliary actuators'),
        h('span.muted', 'global — not tied to a string')]),
      items
    ]);
  }

  // Ensure a loaded/older profile carries the global plucking block and the timing
  // fields the grattage card edits (older exports predate them).
  function ensurePluckConfig(p) {
    if (!p.pluck) p.pluck = {};
    var pk = p.pluck;
    if (pk.strokeMs === undefined) pk.strokeMs = 0;
    if (pk.minStrikePct === undefined) pk.minStrikePct = 0;
    if (pk.fretToPluckMs === undefined) pk.fretToPluckMs = 0;
    if (pk.muteSource === undefined) pk.muteSource = 'auto';
    if (pk.muteHoldMs === undefined) pk.muteHoldMs = 60;
    if (pk.liftMuteOnNoteOff === undefined) pk.liftMuteOnNoteOff = false;
    if (pk.liftEngage === undefined) pk.liftEngage = 'lowerToPlay';
    if (!p.midi) p.midi = {};
    if (p.midi.noteExecutionDelayMs === undefined) p.midi.noteExecutionDelayMs = 0;
    if (p.midi.strumLeadMs === undefined) p.midi.strumLeadMs = 0;
  }

  // The grattage gesture + delays + mute behaviour, configured ONCE for the whole
  // instrument (common to every string). Per-string tabs below only carry wiring +
  // the physical angles.
  function pluckGlobalCard() {
    var p = GMB.state.profile, pk = p.pluck, midi = p.midi;
    var hasLift = anyRole('strumLift');

    // Geste & délais — le mouvement commun à toutes les cordes.
    var gesture = h('div.card.inset', [
      h('h3', 'Geste & délais'),
      h('div.grid2', [
        GMB.field('Durée du geste (ms)', GMB.input(pk, 'strokeMs', { type: 'number', min: 0, max: 2000 }),
          '0 = chaque servo garde son propre réglage'),
        GMB.field('Profondeur mini (%)', GMB.input(pk, 'minStrikePct', { type: 'number', min: 0, max: 100 }),
          'plancher d’attaque pour les notes douces (0 = par servo)'),
        GMB.field('Délai frette → grattage (ms)', GMB.input(pk, 'fretToPluckMs', { type: 'number', min: 0, max: 1000 }),
          'attente après la mise en place de la frette, avant de gratter'),
        GMB.field('Latence Note On → son (ms)', GMB.input(midi, 'noteExecutionDelayMs', { type: 'number', min: 0, max: 2000 }),
          'latence fixe pour un rendu régulier')
      ])
    ]);

    // Étouffement — ce qui coupe la note au Note Off.
    var muteRows = [
      GMB.field('Source', GMB.input(pk, 'muteSource', {
        type: 'select', options: [
          { value: 'auto', label: 'Auto (servo mute si présent)' },
          { value: 'plectrum', label: 'Plectre — se pose sur la corde' },
          { value: 'damper', label: 'Servo mute dédié' },
          { value: 'lift', label: 'Levage — pose le plectre' },
          { value: 'none', label: 'Aucun (laisse sonner)' }
        ], onChange: drawStep
      }), 'le plectre peut muter sans servo dédié')
    ];
    if (pk.muteSource !== 'none')
      muteRows.push(GMB.field('Tenue de l’étouffement (ms)', GMB.input(pk, 'muteHoldMs',
        { type: 'number', min: 0, max: 2000 }), 'durée d’appui avant retour au repos'));
    if (hasLift && pk.liftEngage !== 'raiseToPlay')
      muteRows.push(GMB.field('Le levage étouffe aussi', GMB.input(pk, 'liftMuteOnNoteOff', { type: 'checkbox' }),
        'pose le plectre sur la corde au Note Off, en plus'));
    var muteBlock = h('div.card.inset', [h('h3', 'Étouffement (Note Off)'), h('div.grid2', muteRows)]);

    // Levage — sens d’engagement + anticipation (seulement si un strumLift existe).
    var liftBlock = null;
    if (hasLift) {
      var raise = pk.liftEngage === 'raiseToPlay';
      liftBlock = h('div.card.inset', [
        h('h3', 'Levage'),
        h('div.grid2', [
          GMB.field('Sens', GMB.input(pk, 'liftEngage', {
            type: 'select', options: [
              { value: 'lowerToPlay', label: 'Abaisse pour jouer (repos = plectre écarté)' },
              { value: 'raiseToPlay', label: 'Lève pour jouer (repos = plectre posé → étouffe)' }
            ], onChange: drawStep
          }), (raise
            ? 'repos = plectre sur la corde ; à la note il lève, tient, puis redescend étouffer'
            : 'repos = plectre écarté ; à la note il abaisse pour frapper puis relève') +
            ' — recalibre les angles repos/actif du levage si tu changes de sens'),
          GMB.field('Avance (ms)', GMB.input(midi, 'strumLeadMs', { type: 'number', min: 0, max: 2000 }),
            'engage le levage en avance — plectre en place pile à la frappe')
        ])
      ]);
    }

    return h('div.card', [
      h('div.card-head', [h('h3', 'Grattage — commun à toutes les cordes'),
        h('span.muted', 'un seul réglage pour tout l’instrument')]),
      gesture, muteBlock, liftBlock
    ]);
  }

  function stepPluck(body) {
    var p = GMB.state.profile;
    ensurePluckConfig(p);
    body.appendChild(h('div.note-box',
      'Plucking (grattage): the plectrum / strum servo that sounds the string, plus an ' +
      'optional strum lift (lowers the plucker onto the string for a stroke) and a damper ' +
      '(mutes the string). Le geste et les délais se règlent une seule fois ci-dessous ' +
      '(communs à toutes les cordes) ; les onglets par corde ne portent que le câblage et ' +
      'les angles.'));

    body.appendChild(pluckGlobalCard());
    body.appendChild(armToolbar());
    body.appendChild(testBench('Plucking test bench', [
      { label: 'Pluck each open string', build: pluckStringsSteps },
      { label: 'Sweep pluck servos', build: pluckServoSweepSteps },
      anyRole('strum') ? { label: 'Strum stroke (down/up)', build: strumAltSteps } : null,
      anyRole('strumLift') ? { label: 'Test strum lifts', build: function () { return roleSweepSteps('strumLift', 'lift'); } } : null,
      anyRole('damper') ? { label: 'Test dampers', build: function () { return roleSweepSteps('damper', 'mute'); } } : null
    ]));

    body.appendChild(stringTabs());
    var striker = strikerFor(activeStr);

    // Plucker / striker for this string (wiring shown in Advanced only).
    if (striker) {
      var sk = [
        angleSlider(striker, 'restUs', 'Rest angle', 'plectrum off the string'),
        angleSlider(striker, 'activeUs', 'Strike angle', 'how deep the plectrum rakes the string'),
        GMB.field('Reverse direction', GMB.input(striker, 'inverted', { type: 'checkbox' }))
      ];
      // Per-string strum: the stroke shaping (alternate up/down, up-stroke angle,
      // stroke time, minimum strike depth) is the mechanical difference between a
      // strum servo and an individual pick, so surface it as first-class controls.
      var strumBlock = null;
      if (striker.function === 'strum') {
        strumBlock = h('div.card.inset', [
          h('h3', 'Strum stroke'),
          h('div.grid2', [
            GMB.field('Alternate up/down strokes', GMB.input(striker, 'alternateDirection',
              { type: 'checkbox' }), 'each strike alternates direction'),
            angleSlider(striker, 'activeAltUs', 'Up-stroke angle', '0 = mirror the down-stroke about rest'),
            GMB.field('Stroke time (ms)', GMB.input(striker, 'strokeMs',
              { type: 'number', min: 0, max: 2000 }), '0 = use travel time'),
            GMB.field('Min strike depth (µs)', GMB.input(striker, 'minStrikeUs',
              { type: 'number', min: 0, max: 3000 }), 'so soft notes still catch (0 = velocity only)')
          ]),
          h('div.row', [testServoBtn('Down-stroke', striker, true),
            testPulseBtn('Up-stroke', striker, 'activeAltUs', 'Servo → up-stroke')])
        ]);
      }
      // Plectrum-as-mute: the plectrum rests AGAINST the string at Note Off to damp
      // it with no dedicated damper servo. Surfaced when the global mute source uses
      // the plectrum, or in Advanced mode. The toggle parks muteUs between rest and
      // strike (a light touch on the string); the slider fine-tunes the contact.
      var muteBlock = null;
      if (p.pluck.muteSource === 'plectrum' || GMB.isAdvanced()) {
        var muteOn = (striker.muteUs | 0) > 0;
        var muteToggle = h('input', { type: 'checkbox', checked: muteOn });
        muteToggle.addEventListener('change', function () {
          striker.muteUs = muteToggle.checked
            ? Math.round((striker.restUs + striker.activeUs) / 2) : 0;
          GMB.markDirty();
          drawStep();
        });
        var muteInner = [GMB.field('Plectre-étouffoir', muteToggle,
          'le plectre se pose sur la corde au Note Off pour l’étouffer (sans servo mute)')];
        if (muteOn) {
          muteInner.push(angleSlider(striker, 'muteUs', 'Mute angle', 'plectre posé sur la corde'));
          muteInner.push(h('div.row', [testPulseBtn('Test mute', striker, 'muteUs', 'Servo → mute')]));
        }
        muteBlock = h('div.card.inset', [h('h3', 'Étouffoir (plectre)'), h('div.grid2', muteInner)]);
      }
      var advRows = [];
      if (GMB.isAdvanced()) {
        advRows = servoSourceEditor(striker).concat([
          GMB.field('Pulse min (µs)', GMB.input(striker, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
          GMB.field('Pulse max (µs)', GMB.input(striker, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
          GMB.field('Travel (ms)', GMB.input(striker, 'travelMs', { type: 'number', min: 0, max: 2000 })),
          GMB.field('Settle (ms)', GMB.input(striker, 'settleMs', { type: 'number', min: 0, max: 2000 })),
          GMB.field('Cut PWM at rest', GMB.input(striker, 'disableAtRest', { type: 'checkbox' })),
          GMB.field('Enabled', GMB.input(striker, 'enabled', { type: 'checkbox', onChange: drawStep }))
        ]).concat(striker.function === 'strum' ? []
          : [GMB.field('Alternate stroke', GMB.input(striker, 'alternateDirection', { type: 'checkbox' }))]);
      }
      body.appendChild(h('div.card', [
        h('div.card-head', [h('h3', 'Plucker · string ' + (activeStr + 1) + ' (' + striker.function + ')'),
          GMB.button('Remove', function () { removeServo(striker); drawStep(); }, 'ghost')]),
        h('div.grid2', sk),
        strumBlock,
        muteBlock,
        advRows.length ? h('div.grid3', advRows) : null,
        h('div.row', [testServoBtn('Test rest', striker, false), testServoBtn('Test strike', striker, true),
          playNoteBtn(activeStr, 0, '▶ Pluck open')])
      ]));
    } else {
      body.appendChild(h('div.card', [h('h3', 'Plucker · string ' + (activeStr + 1)),
        h('p.muted', 'This string has no plucker — it cannot sound.'),
        GMB.button('+ Add plucker', function () { ensureStriker(activeStr); drawStep(); }, 'primary')]));
    }

    // Optional per-string actuators (strum lift, damper). This is their home, so the
    // add controls are always offered here (not gated behind Advanced mode).
    var lift = perStringServo(activeStr, 'strumLift');
    var damp = perStringServo(activeStr, 'damper');
    var hasStriker = !!striker;
    var opt = [];
    var liftHints = p.pluck.liftEngage === 'raiseToPlay'
      ? { rest: 'baissé — plectre posé sur la corde (repos = étouffe)',
          active: 'levé — plectre au plan de frappe (jeu)' }
      : { rest: 'levé — plectre écarté de la corde (repos)',
          active: 'baissé — plectre engagé pour la frappe' };
    if (lift) opt.push(actuatorBlock('Strum lift', lift, liftHints));
    else opt.push(h('div.row', [
      h('span.muted', 'Strum lift — lowers the plucker onto the string for a stroke, then raises it.'),
      hasStriker
        ? GMB.button('+ Add strum lift', function () { addRoleServo('strumLift', activeStr); drawStep(); }, 'ghost')
        : h('span.muted', '(add a plucker first)')
    ]));
    if (damp) opt.push(actuatorBlock('Damper', damp,
      { rest: 'off the string', active: 'muting the string' }));
    else opt.push(h('div.row', [
      h('span.muted', 'Damper — presses the string to mute it.'),
      GMB.button('+ Add damper', function () { addRoleServo('damper', activeStr); drawStep(); }, 'ghost')
    ]));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Optional actuators · string ' + (activeStr + 1)),
        h('span.muted', GMB.isAdvanced() ? 'wiring (incl. direct GPIO) below' : 'switch to Advanced for wiring')]),
      opt
    ]));

    if (GMB.isAdvanced() || auxServos().length) body.appendChild(auxCard());
  }

  // ---- Step 4: MIDI (compact; full CC editor is the MIDI tab) ---------------

  function stepMidi(body) {
    var p = GMB.state.profile;
    body.appendChild(h('div.grid2', [
      GMB.field('Global MIDI channel', GMB.input(p.midi, 'globalChannel', { type: 'number', min: 0, max: 15 })),
      GMB.field('Omni (all channels)', GMB.input(p.midi, 'omni', { type: 'checkbox' })),
      GMB.field('Sustain pedal', GMB.input(p.midi, 'sustainPedal', { type: 'checkbox' })),
      GMB.field('Velocity curve', GMB.input(p.midi, 'velocityCurve',
        { type: 'select', options: ['linear', 'soft', 'hard', 'exponential'] }))
    ]));
    body.appendChild(h('div.card', [
      h('h3', 'String / fret selection (CC)'),
      h('p.muted', 'CC20 selects the string and CC21 the fret before a Note On (General-MIDI-Boop ' +
        'tablature). Configure the full selection behaviour on the MIDI tab.'),
      h('div.row', [
        GMB.button('Open MIDI tab', function () { location.hash = '#midi'; }, 'ghost')
      ])
    ]));
  }

  // ---- Step 5: Power / current management -----------------------------------

  function stepPower(body) {
    var p = GMB.state.profile;
    if (!p.power) p.power = { maxConcurrentMoves: 3, staggerMs: 8 };
    body.appendChild(h('p.muted',
      'Limit PCA9685 in-rush current. Idle fingers cut their PWM (per servo), only one ' +
      'finger presses per string at a time, and the governor staggers how many servos start ' +
      'moving together — important when a chord re-frets several strings at once.'));
    body.appendChild(h('div.grid2', [
      GMB.field('Max servos moving at once', GMB.input(p.power, 'maxConcurrentMoves',
        { type: 'number', min: 1, max: 32 }), 'lower = gentler on the power supply'),
      GMB.field('Stagger between starts (ms)', GMB.input(p.power, 'staggerMs',
        { type: 'number', min: 0, max: 200 }), '0 disables staggering'),
      GMB.field('Note execution delay (ms)', GMB.input(p.midi, 'noteExecutionDelayMs',
        { type: 'number', min: 0, max: 2000 }), 'fixed reception → sound latency'),
      GMB.field('Strum lead (ms)', GMB.input(p.midi, 'strumLeadMs',
        { type: 'number', min: 0, max: 2000 }), 'lower the strum lift early (0 = off)')
    ]));
  }

  // ---- Step 6: Test (whole instrument) --------------------------------------

  function stepTest(body) {
    var p = GMB.state.profile;
    body.appendChild(h('div.note-box',
      'Full instrument test. Arm the mechanics, then run a group test — play every open ' +
      'string, sweep every finger, sweep every plucker, run a scale on the active string, ' +
      'or test everything end-to-end. Stop halts the sequence immediately.'));

    body.appendChild(armToolbar());
    body.appendChild(testBench('Full instrument test', [
      { label: 'Play all open strings', build: pluckStringsSteps },
      { label: 'Sweep all fingers', build: allFretsSteps },
      { label: 'Sweep all pluckers', build: pluckServoSweepSteps },
      { label: 'Scale on string ' + (activeStr + 1), build: function () { return scaleSteps(activeStr); } },
      { label: 'Test everything', build: everythingSteps }
    ]));

    body.appendChild(stringTabs());
    var rows = p.strings.map(function (s, i) {
      return h('div.row', [
        h('span', 'String ' + (i + 1) + ' (' + GMB.noteName(s.openNote) + ')'),
        GMB.button('Open (fret 0)', function () {
          GMB.api.testNote({ channel: 0, note: s.openNote, velocity: 100, durationMs: 400 })
            .catch(function () { GMB.toast('Arm the instrument first.', 'warn'); });
        }, 'ghost'),
        GMB.button('Fret 5', function () {
          GMB.api.testNote({ channel: 0, note: s.openNote + 5, velocity: 100, durationMs: 400 })
            .catch(function () {});
        }, 'ghost')
      ]);
    });
    body.appendChild(h('div.card', [h('div.card-head', [h('h3', 'Per-string quick play')]), rows]));
    body.appendChild(h('div.row', [GMB.button('STOP (panic)', function () { GMB.doPanic && GMB.doPanic(); }, 'danger')]));
  }

  // ---- Step 7: Validation ---------------------------------------------------

  function stepValidation(body) {
    var issues = GMB.validateProfile(GMB.state.profile);
    if (!issues.length) {
      body.appendChild(h('div.pill.ok', 'No problems found — ready to save.'));
    } else {
      issues.forEach(function (is) {
        body.appendChild(h('div.pill.' + (is.level === 'error' ? 'error' : 'warn'),
          (is.field ? is.field + ' — ' : '') + is.message));
      });
    }
    body.appendChild(h('div.row', [GMB.button('Save & publish', function () { GMB.saveProfile(); }, 'primary')]));
  }

  // Client-side pre-check (the firmware ProfileValidator is authoritative).
  GMB.validateProfile = function (p) {
    var out = [];
    var anyPca = false, direct = 0;
    var pcaUsed = {}, fingerKey = {};
    p.servos.forEach(function (s, i) {
      if (!s.enabled) return;
      if (s.source === 'pca') {
        anyPca = true;
        if (s.pcaBoard > 7) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'PCA board must be 0..7' });
        if (s.channel > 15) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'PCA channel must be 0..15' });
        var k = s.pcaBoard + ':' + s.channel;
        if (pcaUsed[k]) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'PCA ' + k + ' used twice' });
        pcaUsed[k] = true;
      } else { direct++; if (s.gpio < 0) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'direct servo needs a GPIO' }); }
      if (s.function === 'finger') {
        var claim = function (fret, label) {
          if (fret < 1 || fret > 24) {
            out.push({ level: 'error', field: 'servos[' + i + ']', message: label + ' fret must be 1..24' });
            return;
          }
          var fk = s.stringIndex + '/' + fret;
          if (fingerKey[fk]) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'string ' + s.stringIndex + ' fret ' + fret + ' has two fingers' });
          fingerKey[fk] = true;
        };
        claim(s.fret, 'finger');
        if (s.fretB >= 0) {  // geared / paired finger
          if (s.fretB === s.fret) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'geared finger frets must differ' });
          else claim(s.fretB, 'geared side-B');
          if (s.activeBUs < s.pulseMinUs || s.activeBUs > s.pulseMaxUs)
            out.push({ level: 'error', field: 'servos[' + i + ']', message: 'geared side-B pulse outside pulse min/max' });
        }
        // Guard-rail warnings: a finger that never really presses, or a geared
        // neutral that fails to lift both sides.
        if (s.fretB >= 1) {
          var glo = Math.min(s.activeUs, s.activeBUs), ghi = Math.max(s.activeUs, s.activeBUs);
          if (!(s.restUs > glo && s.restUs < ghi))
            out.push({ level: 'warning', field: 'servos[' + i + ']', message: 'string ' + s.stringIndex + ' fret ' + s.fret + ': geared neutral should sit between press A and press B' });
        } else if (Math.abs(GMB.usToAngle(s, s.activeUs) - GMB.usToAngle(s, s.restUs)) < 5) {
          out.push({ level: 'warning', field: 'servos[' + i + ']', message: 'string ' + s.stringIndex + ' fret ' + s.fret + ': contact and rest angle are nearly equal — the finger may not press' });
        }
      }

    });
    if (direct > 8) out.push({ level: 'error', field: 'servos', message: 'at most 8 direct-GPIO servos (LEDC channels)' });
    var hasPin = function (sig) { return p.pins.some(function (a) { return a.signal === sig && a.gpio >= 0; }); };
    // When automatic pin assignment is on and no pins are set yet, the backend wires
    // SDA/SCL/OE on save (see ProfileStorage import), so don't flag them as missing
    // — only require them when the user manages pins manually (audit G11).
    var autoPins = p.board && p.board.automaticPinAssignment && (!p.pins || p.pins.length === 0);
    if (anyPca && !autoPins && (!hasPin('SDA') || !hasPin('SCL') || !hasPin('SERVO_OE')))
      out.push({ level: 'error', field: 'pins',
        message: 'SDA, SCL and SERVO_OE are required for PCA servos (or enable automatic pin assignment)' });
    p.strings.forEach(function (s, i) {
      if (!s.enabled) return;
      if (!strikerFor(i)) out.push({ level: 'error', field: 'string ' + i, message: 'no plucker/strum servo' });
      // A strum lift only makes sense paired with a striker to lift (mirrors firmware).
      if (perStringServo(i, 'strumLift') && !strikerFor(i))
        out.push({ level: 'error', field: 'string ' + i, message: 'strum lift has no plucker/strum servo to lift' });
      if (s.maxFret > 0 && GMB.availableFrets(p, i).length === 0)
        out.push({ level: 'warning', field: 'string ' + i, message: 'no finger servo — only the open string plays' });
    });
    if (p.power && p.power.maxConcurrentMoves < 1)
      out.push({ level: 'error', field: 'power', message: 'at least one servo must be allowed to move' });
    return out;
  };

  GMB.views.wizard = { render: render };
})(window);
