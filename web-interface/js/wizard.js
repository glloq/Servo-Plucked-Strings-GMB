/*
 * wizard.js — first-configuration assistant for a SERVO-PER-FRET instrument.
 *
 * The physical machine has two independent halves per string, and the wizard now
 * mirrors that split so each can be configured, calibrated and tested on its own:
 *
 *   • FRETS — one dedicated finger servo per fret position; it presses the string
 *            against the fret. Step "Frets".
 *   • PLUCK — the plectrum / strum servo that sounds the string, plus the optional
 *            strum-lift and damper. Step "Plucking".
 *
 * ONE complete SETUP flow (GMB.views.setup — a main page) walks the whole
 * creation of an instrument in order, so nothing is split across pages/modals:
 *
 *     Instrument (Builder) -> Frets -> Plucking -> MIDI -> Timing -> Test -> Validation
 *
 * i.e. define the instrument (identity, strings, mechanics, board, wiring), then
 * calibrate what you defined (finger servos, then strikers), then its MIDI
 * behaviour and timing, then test it and save. Only device connectivity (Wi-Fi)
 * and the diagnostic tools (SysEx / MIDI monitor) stay in the gear modal — they
 * are not part of the instrument.
 *
 * Every actuator step carries an Arm control and a "test bench" that drives ONE
 * servo or a whole GROUP (sweep every fret of a string, pluck every string, test
 * everything…) through the shared GMB.testRunner sequencer, with a live status
 * line and a Stop button. The Simplified / Advanced toggle hides the wiring
 * (source, board, channel) and fine timing in simplified mode.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  // One unified SETUP flow over the step functions (UI redesign): the complete,
  // ordered creation of an instrument on a single main page — define, calibrate,
  // MIDI, timing, test, save — so no instrument setting is split across a page and
  // a modal. The gear modal keeps only device Wi-Fi and the diagnostic tools.
  var STEP_DEFS = {
    builder:    { label: 'Instrument', fn: stepBuilder },
    midi:       { label: 'MIDI',       fn: stepMidiSettings },
    power:      { label: 'Timing',     fn: stepPower },
    validation: { label: 'Validation', fn: stepValidation },
    frets:      { label: 'Frets',      fn: stepFrets },
    plucking:   { label: 'Plucking',   fn: stepPluck },
    test:       { label: 'Test',       fn: stepTest }
  };
  var FLOWS = {
    setup: ['builder', 'frets', 'plucking', 'midi', 'power', 'test', 'validation']
  };
  var flowStep = { setup: 0 };        // current step index
  var flowHost = { setup: null };     // mount element
  var currentFlow = 'setup';          // which flow a bare drawStep() targets

  var activeStr = 0;        // per-string steps show one string at a time
  var expandedFrets = {};   // Frets step: which fret rows show their servo editor

  // Full MIDI settings (params + string/fret selection) as a config-wizard step;
  // the live monitor + integrated tester stay in the Settings > Advanced tab.
  function stepMidiSettings(body) {
    if (GMB.midiSettings && GMB.midiSettings.settings) GMB.midiSettings.settings(body);
    else body.appendChild(h('div.note-box', 'MIDI settings module not loaded.'));
  }

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
    // Seed the contact model: rest = contact against the string (90°), and sweep ±20°
    // for the alternating down/up strokes.
    GMB.state.profile.servos.push(
      GMB.servoDefaults('pluck', strIdx,
        { pcaBoard: board, channel: ch < 0 ? 0 : ch, restUs: 1500, activeUs: 1720,
          activeAltUs: 1280, alternateDirection: true, travelMs: 90, settleMs: 20 }));
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

  function bodyId(flowKey) { return flowKey + '-wizard-body'; }

  // Render a flow's stepper + body + nav into `host`. Same UI for both flows; only
  // the step list, the current index and the mount element differ.
  function renderFlow(host, flowKey) {
    if (!host) return;
    GMB.testRunner.stop();   // never leave a sequence running across a full re-render
    flowHost[flowKey] = host;
    currentFlow = flowKey;
    var steps = FLOWS[flowKey];
    if (flowStep[flowKey] >= steps.length) flowStep[flowKey] = 0;
    var step = flowStep[flowKey];
    host.innerHTML = '';
    host.appendChild(h('div.card.wizard-card', [
      h('div.stepper', steps.map(function (id, i) {
        var d = STEP_DEFS[id];
        return h('button.step' + (i === step ? '.active' : '') + (i < step ? '.done' : ''),
          { onclick: function () { goto(flowKey, i); } },
          [h('span.step-num', String(i + 1)), h('span.step-label', d.label)]);
      })),
      h('div.wizard-body', { id: bodyId(flowKey) }),
      h('div.wizard-nav', [
        GMB.button('Back', function () { goto(flowKey, step - 1); }, 'ghost'),
        h('span.spacer'),
        h('span.muted', 'Step ' + (step + 1) + ' / ' + steps.length),
        h('span.spacer'),
        step < steps.length - 1
          ? GMB.button('Next', function () { goto(flowKey, step + 1); }, 'primary')
          : GMB.button('Save & publish', function () { GMB.saveProfile(); }, 'primary')
      ])
    ]));
    drawStep(flowKey);
  }

  function goto(flowKey, i) {
    var steps = FLOWS[flowKey];
    if (i >= 0 && i < steps.length) { flowStep[flowKey] = i; renderFlow(flowHost[flowKey], flowKey); }
  }

  // Redraw just the current step's body. Bare calls (from field onChange handlers)
  // target the flow last rendered / interacted, i.e. the one on screen.
  function drawStep(flowKey) {
    flowKey = flowKey || currentFlow;
    GMB.testRunner.stop();   // any config edit / step change cancels a running test
    var body = document.getElementById(bodyId(flowKey));
    if (!body) return;
    currentFlow = flowKey;
    body.innerHTML = '';
    var id = FLOWS[flowKey][flowStep[flowKey]];
    STEP_DEFS[id].fn(body);
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
    // Global gear threshold = the widest threshold among the strings that are
    // actually geared (default 6 when none are geared). Deriving only from geared
    // strings keeps the committed threshold intact — a chromatic string's nominal 6
    // must not inflate a "frets 1-2 geared" instrument to 6.
    var gearedGts = specs.filter(function (s) { return s.fretting === 'geared' && s.gearThreshold > 0; })
      .map(function (s) { return s.gearThreshold; });
    var global = {
      fretting: modeOf(specs.map(function (s) { return s.fretting; }), 'chromatic'),
      gearThreshold: gearedGts.length ? Math.max.apply(null, gearedGts) : 6,
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
    autoGenerate();
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
  function applyBuilder(force) {
    var p = GMB.state.profile;
    var overwrite = p.strings.some(function (_, i) {
      return deriveStringSpec(i).fretting === 'custom' && effectiveSpec(i).fretting !== 'custom';
    });
    if (overwrite && !force && !confirm('Some strings have hand-edited wiring. Replace it with the chosen mechanics?'))
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

  // Keep the servo wiring in sync with the mechanics automatically (the Simplified
  // creation path has no explicit "Generate" button). Skipped when a string uses
  // hand-edited 'custom' wiring — that is only regenerated from the Advanced
  // "Generate wiring" button, so a manual layout is never silently overwritten.
  function autoGenerate() {
    var custom = GMB.state.profile.strings.some(function (_, i) {
      return effectiveSpec(i).fretting === 'custom';
    });
    if (custom) return;
    applyBuilder(true);
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

  // One compact string row: open note + max fret (+ the resulting top note).
  function stringRow(s, i) {
    return h('div.string-row', [
      h('span.sr-idx', 'String ' + (i + 1)),
      h('label.sr-cell', [h('span.muted', 'open'),
        GMB.input(s, 'openNote', { type: 'number', min: 0, max: 127, onChange: drawStep })]),
      h('span.sr-note', GMB.noteName(s.openNote)),
      h('label.sr-cell', [h('span.muted', 'max fret'),
        GMB.input(s, 'maxFret', { type: 'number', min: 0, max: 24,
          onChange: function () { autoGenerate(); drawStep(); } })]),
      h('span.muted', '→ ' + GMB.noteName(s.openNote + s.maxFret))
    ]);
  }

  // ---- I²C bus topology (creation): assign PCA boards to bus 0 or bus 1 -------
  // The ESP32-S3 has two hardware I²C controllers; splitting the PCA boards over
  // both buses halves the traffic and refreshes the servos faster on large rigs.

  // Recommended pin map for the current board (board-aware SDA2/SCL2/OE2 defaults).
  function rec() {
    var id = GMB.state.profile.board && GMB.state.profile.board.profile;
    return (GMB.recommendedFor && GMB.recommendedFor(id)) || GMB.RECOMMENDED || {};
  }

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
      var R = rec();
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
        var R = rec();
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
    var R = rec();
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
          'Assign the SDA2 / SCL2 pins in the GPIO sub-tab (Wiring & GPIO) (default GPIO' +
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
    var strings = p.strings;

    // Instrument identity + presets. A preset produces a working instrument and the
    // wiring is (re)generated automatically — the mechanics live per-servo on the
    // Frets / Plucking steps.
    var TYPES = ['ukulele', 'guitar', 'bass', 'mandolin', 'banjo'];
    var presets = TYPES.map(function (t) {
      return h('button.preset-card' + (p.instrument.type === t ? '.selected' : ''),
        { type: 'button', onclick: function () { applyPreset(t); } },
        [h('strong', cap(t)), h('span.muted', TUNINGS[t].notes.length + ' strings')]);
    });
    presets.push(h('button.preset-card' + (TYPES.indexOf(p.instrument.type) < 0 ? '.selected' : ''),
      { type: 'button', onclick: function () { p.instrument.type = 'custom'; GMB.markDirty(); drawStep(); } },
      [h('strong', 'Custom'), h('span.muted', 'your own')]));
    body.appendChild(builderSection('Instrument', [
      h('p.muted', 'Pick a starting point and name your instrument.'),
      h('div.preset-row', presets),
      h('div.grid2', [GMB.field('Instrument name', GMB.input(p.instrument, 'name'))])
    ]));

    // Strings & tuning. Changing the string count or a max fret re-generates the
    // wiring automatically.
    body.appendChild(builderSection('Strings & tuning', [
      h('div.row', [
        GMB.field('Number of strings', GMB.input(p.instrument, 'stringCount',
          { type: 'number', min: 1, max: 6,
            onChange: function (v) { setStringCount(v); autoGenerate(); drawStep(); } }))
      ]),
      h('div.string-rows', strings.map(function (s, i) { return stringRow(s, i); }))
    ]));

    // Board — which ESP32 everything wires to.
    var boardOpts = (GMB.boardList ? GMB.boardList() : []).map(function (b) {
      return { value: b.id, label: b.name };
    });
    body.appendChild(builderSection('Board', [
      h('div.grid2', [
        GMB.field('ESP32 board', GMB.input(p.board, 'profile', {
          type: 'select', options: boardOpts,
          onChange: function () { GMB.markDirty(); drawStep(); } }),
          'the pinout everything wires to — the full map is on the Wiring & GPIO page'),
        GMB.field('Reserve native USB (GPIO19/20)', GMB.input(p.board, 'reserveUsb', { type: 'checkbox' }))
      ]),
      h('p.muted', 'Wi-Fi / hostname live in the gear menu (⚙ Network) — they belong to the device, not the instrument.')
    ]));
  }

  // ---- direct-GPIO pin picker (same rules as the GPIO sub-tab) --------------

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

  // A precise angle control bound to sv[key]: a degree number box flanked by −/+
  // buttons (1° steps). Touch-friendly and exact where a slider is not. Every change
  // drives the servo to that pulse (when armed) so the target angle previews live.
  function angleStepper(sv, key, label, hint, onAfter) {
    var input = h('input.angle-num', { type: 'number', min: 0, max: 180, step: 1,
      value: GMB.usToAngle(sv, sv[key]) });
    function apply() {
      var d = Math.max(0, Math.min(180, Math.round(Number(input.value) || 0)));
      input.value = d;
      sv[key] = GMB.angleToUs(sv, d);
      if (onAfter) onAfter();
      GMB.markDirty();
      var idx = servoIndexOf(sv);
      if (idx >= 0) GMB.api.testServo({ index: idx, active: true, us: sv[key] | 0 }).catch(function () {});
    }
    input.addEventListener('change', apply);
    function bump(delta) { input.value = (Number(input.value) || 0) + delta; apply(); }
    var row = h('div.angle-stepper', [
      GMB.button('−', function () { bump(-1); }, 'ghost'),
      input, h('span.angle-unit', '°'),
      GMB.button('+', function () { bump(1); }, 'ghost')
    ]);
    return label ? GMB.field(label, row, hint) : row;
  }

  // Per-servo PCA address + output pin pickers. The mechanism runs everything on
  // PCA9685 boards, so a servo just needs its board (0x40–0x47) and channel (0–15).
  function pcaPinRow(sv) {
    var boards = [], pins = [];
    for (var b = 0; b < 8; b++) boards.push({ value: b, label: 'PCA ' + b + ' · 0x' + (0x40 + b).toString(16) });
    for (var c = 0; c < 16; c++) pins.push({ value: c, label: 'pin ' + c });
    if (sv.source !== 'pca') sv.source = 'pca';
    return h('div.grid2', [
      GMB.field('PCA board', GMB.input(sv, 'pcaBoard',
        { type: 'select', options: boards, coerce: Number, onChange: GMB.markDirty })),
      GMB.field('PCA pin', GMB.input(sv, 'channel',
        { type: 'select', options: pins, coerce: Number, onChange: GMB.markDirty }))
    ]);
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

  // ---- Step: Frets — finger-servo calibration only --------------------------

  // A clickable fret strip for the active string: which frets carry a finger servo
  // (geared marked ⚙), tap one to open its editor below.
  function fretCoverage(strIdx) {
    var s = GMB.state.profile.strings[strIdx];
    var chips = [];
    for (var f = 1; f <= s.maxFret; f++) {
      (function (fret) {
        var key = strIdx + ':' + fret;
        var sv = fingerFor(strIdx, fret);
        var cls = !sv ? 'none' : (isGeared(sv) ? 'geared' : 'equipped');
        if (expandedFrets[key]) cls += ' current';
        chips.push(h('button', {
          class: 'fret-chip ' + cls,
          title: sv ? (isGeared(sv) ? 'geared servo — tap to adjust' : 'has a servo — tap to adjust')
                    : 'no servo yet',
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
        h('span.lg', [h('span.fret-chip.mini.equipped'), 'has servo']),
        h('span.lg', [h('span.fret-chip.mini.geared'), 'geared']),
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

    // A fret with no servo yet: one tap adds one and opens its editor.
    if (!sv) {
      return h('div.fret-line.empty', [id, h('span.spacer'),
        GMB.button('Add servo', function () {
          addFinger(strIdx, fret); expandedFrets[strIdx + ':' + fret] = true; drawStep();
        }, 'ghost')]);
    }
    var geared = isGeared(sv);
    // Side-B fret of a geared servo: it is adjusted on its side-A (owner) row.
    if (geared && sv.fret !== fret) {
      return h('div.fret-line', [id,
        h('span.muted', '↳ paired with fret ' + sv.fret + ' on one geared servo'),
        h('span.spacer'),
        GMB.button('Adjust on fret ' + sv.fret, function () {
          expandedFrets[strIdx + ':' + sv.fret] = true; drawStep();
        }, 'ghost')]);
    }

    var ekey = strIdx + ':' + fret;
    var open = !!expandedFrets[ekey];
    var badge = geared
      ? (GMB.usToAngle(sv, sv.activeUs) + '° / ' + GMB.usToAngle(sv, sv.activeBUs) + '°')
      : (GMB.usToAngle(sv, sv.activeUs) + '°');
    var line = h('div.fret-line', [
      id,
      geared ? h('span.pill.mini', 'geared') : null,
      h('span.spacer'),
      h('span.muted.fret-angle-badge', badge),
      GMB.button(open ? 'Adjust ▾' : 'Adjust ▸', function () { expandedFrets[ekey] = !open; drawStep(); }, 'ghost')
    ]);
    if (!open) return line;

    // The servo div — everything for this fret's servo in one place: whether it gears
    // two frets, its PCA board + pin, the angle(s) + rotation direction, and a live
    // test. A geared servo shows BOTH press angles; its rest sits at their midpoint
    // automatically (both fingers lifted).
    var hasAdjacent = (fret + 1 <= p.strings[strIdx].maxFret) || (fret - 1 >= 1 && !fingerFor(strIdx, fret - 1));
    var gearToggle = h('input', { type: 'checkbox', checked: geared, disabled: !geared && !hasAdjacent });
    gearToggle.addEventListener('change', function () { setGeared(sv, gearToggle.checked, strIdx); drawStep(); });

    var syncRest = function () { sv.restUs = Math.round((sv.activeUs + sv.activeBUs) / 2); };
    var angles = geared ? [
      angleStepper(sv, 'activeUs', 'Angle · fret ' + sv.fret, 'press fret ' + sv.fret, syncRest),
      angleStepper(sv, 'activeBUs', 'Angle · fret ' + sv.fretB, 'press fret ' + sv.fretB, syncRest)
    ] : [
      angleStepper(sv, 'activeUs', 'Contact angle', 'finger pressing the fret'),
      angleStepper(sv, 'restUs', 'Rest angle', 'finger lifted off the string')
    ];

    var detail = [
      h('label.inline.builder-opt', [gearToggle,
        h('span', 'One servo drives 2 frets (geared)' + (!geared && !hasAdjacent ? ' — no free adjacent fret' : ''))]),
      pcaPinRow(sv),
      h('div.grid2', angles),
      GMB.field('Reverse rotation direction', GMB.input(sv, 'inverted', { type: 'checkbox' }),
        'flip the servo direction if the finger moves the wrong way')
    ];
    detail.push(geared
      ? h('div.row', [
          testPulseBtn('→ fret ' + sv.fret, sv, 'activeUs', 'Servo → fret ' + sv.fret),
          testPulseBtn('→ fret ' + sv.fretB, sv, 'activeBUs', 'Servo → fret ' + sv.fretB),
          testPulseBtn('→ rest', sv, 'restUs', 'Servo → rest (midpoint)'),
          playNoteBtn(strIdx, sv.fret, '▶ Play ' + sv.fret),
          playNoteBtn(strIdx, sv.fretB, '▶ Play ' + sv.fretB)])
      : h('div.row', [
          testServoBtn('→ rest', sv, false),
          testServoBtn('→ contact', sv, true),
          playNoteBtn(strIdx, fret)]));
    return h('div.fret-line-wrap', [line, h('div.fret-detail', detail)]);
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
      'Frets — set up each finger servo. Tap a fret to open its servo: choose whether ' +
      'one servo drives two frets (geared), its PCA board + pin, the angle(s) and the ' +
      'rotation direction. Use the − / + buttons to move the servo to the exact target ' +
      'angle, then play the note to check it.'));

    body.appendChild(armToolbar());
    body.appendChild(testBench('Fret test bench', [
      { label: 'Sweep this string', build: function () { return fretSweepSteps(activeStr); } },
      { label: 'Sweep all strings', build: allFretsSteps },
      { label: 'All fingers to rest', build: function () { return allRestSteps(activeStr); } }
    ]));

    body.appendChild(stringTabs());

    // An open-only string has no fret servos yet — offer a one-tap equip.
    if (s.maxFret > 0 && GMB.availableFrets(p, activeStr).length === 0) {
      body.appendChild(h('div.note-box', [
        'This string has no finger servos yet — it plays its open note only. ',
        GMB.button('Equip its frets', function () { equipAllFrets(activeStr); drawStep(); }, 'ghost')]));
      return;
    }

    var lines = [];
    for (var f = 1; f <= s.maxFret; f++) lines.push(fretLine(activeStr, f));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Finger servos · string ' + (activeStr + 1)),
        h('span.muted', 'tap a fret to set its servo')]),
      s.maxFret > 0 ? fretCoverage(activeStr) : null,
      s.maxFret > 0 ? h('div.fret-lines', lines)
        : h('p.muted', 'Max fret is 0 — this string plays open only (no frets).')
    ]));
  }

  // ---- Step: Plucking — plucker + strum lift + damper + aux calibration ------

  // Shared editor body for a non-finger, non-plucker actuator: rest/active angles,
  // a live test, and — in Advanced mode — the full wiring (source incl. direct GPIO)
  // plus pulse/timing. Used for strum-lift, damper and auxiliary servos so every one
  // of them can sit on a PCA channel OR a direct ESP32 GPIO, exactly like a finger.
  // A generic degree stepper bound to a plain object's key (not a servo pulse) — used
  // for the striker's derived contact / strum-amplitude angles. Same −/+ box as
  // angleStepper; the caller's onChange turns the values into servo pulses.
  function degStepper(obj, key, min, max, onChange) {
    var input = h('input.angle-num', { type: 'number', min: min, max: max, step: 1, value: obj[key] });
    function apply() {
      var v = Math.max(min, Math.min(max, Math.round(Number(input.value) || 0)));
      input.value = v; obj[key] = v; if (onChange) onChange();
    }
    input.addEventListener('change', apply);
    function bump(d) { input.value = (Number(input.value) || 0) + d; apply(); }
    return h('div.angle-stepper', [
      GMB.button('−', function () { bump(-1); }, 'ghost'),
      input, h('span.angle-unit', '°'),
      GMB.button('+', function () { bump(1); }, 'ghost')
    ]);
  }

  // The striker is set by just two numbers: the CONTACT angle (plectrum against the
  // string) and the STRUM angle (how far it sweeps to each side). The servo always
  // alternates, so the down-stroke is contact+strum and the up-stroke contact−strum.
  // Editing either number re-derives the pulses live and previews on the hardware.
  function strikerAngles(striker) {
    var st = {
      contact: GMB.usToAngle(striker, striker.restUs),
      amp: GMB.usToAngle(striker, striker.activeUs) - GMB.usToAngle(striker, striker.restUs)
    };
    if (!(st.amp > 0)) st.amp = 20;
    // The sweep must fit on BOTH sides of the contact angle, otherwise the mirrored
    // up-stroke would pin at a pulse-window extremity (the audit P0 failure mode).
    function fitAmp() {
      var room = Math.min(st.contact, 180 - st.contact);
      if (st.amp > room) st.amp = Math.max(1, Math.floor(room));
    }
    fitAmp();
    function reapply(previewDown) {
      fitAmp();
      striker.restUs = GMB.angleToUs(striker, st.contact);
      striker.activeUs = GMB.angleToUs(striker, Math.min(180, st.contact + st.amp));
      striker.activeAltUs = GMB.angleToUs(striker, Math.max(0, st.contact - st.amp));
      striker.alternateDirection = true;
      GMB.markDirty();
      var idx = servoIndexOf(striker);
      if (idx >= 0) GMB.api.testServo({ index: idx, active: true,
        us: (previewDown ? striker.activeUs : striker.restUs) | 0 }).catch(function () {});
    }
    return {
      contact: degStepper(st, 'contact', 0, 180, function () { reapply(false); }),
      amp: degStepper(st, 'amp', 1, 90, function () { reapply(true); })
    };
  }

  // Ensure a loaded/older profile carries the global plucking block and the timing
  // fields the plucking card edits (older exports predate them).
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
    // NEVER touch an existing striker's mechanical calibration here. Forcing
    // alternateDirection on a loaded profile whose activeAltUs is 0 made the firmware
    // mirror the stroke about rest (2*rest-active) — out of the pulse window on the
    // shipped non-alternating profiles, so the "up-stroke" clamped to a mechanical
    // extremity (audit P0). A striker only becomes alternating when the user
    // recalibrates it in strikerAngles(), which writes rest/active/activeAlt together.
  }

  function stepPluck(body) {
    var p = GMB.state.profile;
    ensurePluckConfig(p);
    body.appendChild(h('div.note-box',
      'Plucking — one sounding servo per string. Set the contact angle (plectrum against ' +
      'the string) and the strum angle (how far it sweeps, e.g. 20°); the servo always ' +
      'alternates its stroke direction. Choose its PCA board + pin, and — the second way ' +
      'to strum — optionally add a descent servo that lowers the plectrum onto the string ' +
      'only while it plays.'));

    body.appendChild(armToolbar());
    body.appendChild(testBench('Plucking test bench', [
      { label: 'Pluck each open string', build: pluckStringsSteps },
      { label: 'Sweep strum servos', build: pluckServoSweepSteps }
    ]));

    body.appendChild(stringTabs());
    ensureStriker(activeStr);
    var striker = strikerFor(activeStr);
    var ang = strikerAngles(striker);

    var upStroke = function () {
      var idx = servoIndexOf(striker); if (idx < 0) return;
      var us = 2 * striker.restUs - striker.activeUs;    // mirror the down-stroke about contact
      us = Math.max(striker.pulseMinUs || 500, Math.min(striker.pulseMaxUs || 2500, us));
      GMB.api.testServo({ index: idx, active: true, us: us | 0 })
        .then(function () { GMB.toast('Servo → up-stroke', 'ok'); })
        .catch(function () { GMB.toast('Arm the instrument first.', 'warn'); });
    };
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Sounding servo · string ' + (activeStr + 1)),
        h('span.muted', 'contact + strum angle, always alternating')]),
      pcaPinRow(striker),
      h('div.grid2', [
        GMB.field('Contact angle', ang.contact, 'plectrum resting against the string'),
        GMB.field('Strum angle', ang.amp, 'how far it sweeps to each side of contact (e.g. 20°)')
      ]),
      h('div.row', [
        testServoBtn('→ contact', striker, false),
        testPulseBtn('→ down-stroke', striker, 'activeUs', 'Servo → down-stroke'),
        GMB.button('→ up-stroke', upStroke, 'ghost'),
        playNoteBtn(activeStr, 0, '▶ Pluck open')
      ])
    ]));

    // Descent servo (optional) — the second way to strum: the plectrum rests OFF the
    // string and a second servo lowers it on only while the string plays.
    var lift = perStringServo(activeStr, 'strumLift');
    var descToggle = h('input', { type: 'checkbox', checked: !!lift });
    descToggle.addEventListener('change', function () {
      if (descToggle.checked && !lift) addRoleServo('strumLift', activeStr);
      else if (!descToggle.checked && lift) removeServo(lift);
      GMB.markDirty();
      drawStep();
    });
    var descKids = [h('label.inline.builder-opt', [descToggle,
      h('span', 'Add a descent servo (lowers the plectrum onto the string only while playing)')])];
    if (lift) {
      descKids.push(pcaPinRow(lift));
      descKids.push(h('div.grid2', [
        angleStepper(lift, 'restUs', 'Raised angle', 'plectrum off the string (rest)'),
        angleStepper(lift, 'activeUs', 'Lowered angle', 'plectrum on the string (to strum)')
      ]));
      descKids.push(h('div.row', [testServoBtn('→ raised', lift, false), testServoBtn('→ lowered', lift, true)]));
    }
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Descent servo · string ' + (activeStr + 1)),
        h('span.muted', 'optional')]),
      descKids
    ]));
  }

  // ---- Step: Power / current management -------------------------------------

  function stepPower(body) {
    var p = GMB.state.profile;
    if (!p.power) p.power = {};
    if (p.power.maxConcurrentMoves === undefined) p.power.maxConcurrentMoves = 3;
    if (p.power.maxConcurrentPerBoard === undefined) p.power.maxConcurrentPerBoard = 0;
    if (p.power.staggerMs === undefined) p.power.staggerMs = 8;
    ensurePluckConfig(p);

    // Timing — the two global delays that shape when every note fires.
    body.appendChild(h('div.card.inset', [
      h('h3', 'Timing'),
      h('p.muted',
        'Chords are synchronised by the firmware: the notes of a chord share one strike ' +
        'deadline that covers the slowest string’s mechanical preparation (finger ' +
        'travel + settle). The global action delay adds a fixed reception → sound ' +
        'floor on top, keeping single-note feel even; the fret → strum delay waits ' +
        'after the finger has seated a fret before the plectrum strikes.'),
      h('div.grid2', [
        GMB.field('Global action delay (ms)', GMB.input(p.midi, 'noteExecutionDelayMs',
          { type: 'number', min: 0, max: 2000 }), 'fixed-time FIFO buffer — reception → sound latency'),
        GMB.field('Fret → strum delay (ms)', GMB.input(p.pluck, 'fretToPluckMs',
          { type: 'number', min: 0, max: 1000 }), 'wait after the finger is seated before the plectrum strikes'),
        GMB.field('Strum lead (ms)', GMB.input(p.midi, 'strumLeadMs',
          { type: 'number', min: 0, max: 2000 }), 'lower the strum lift early (0 = off)')
      ])
    ]));

    // Current management — an OPTIONAL governor. A servo peaks its current in the
    // first milliseconds of a move; the governor staggers how many servos START
    // together so a chord re-fretting many strings doesn't brown out the 5–6 V rail.
    var pw = p.power;
    var limitOn = (pw.maxConcurrentMoves > 0) || (pw.maxConcurrentPerBoard > 0);
    var limitToggle = h('input', { type: 'checkbox', checked: limitOn });
    limitToggle.addEventListener('change', function () {
      if (limitToggle.checked) {
        if (!(pw.maxConcurrentMoves > 0) && !(pw.maxConcurrentPerBoard > 0)) pw.maxConcurrentMoves = 3;
      } else { pw.maxConcurrentMoves = 0; pw.maxConcurrentPerBoard = 0; }
      GMB.markDirty(); drawStep();
    });
    var cmKids = [
      h('p.muted',
        'Optional — limits PCA9685 in-rush current by staggering how many servos start ' +
        'moving at once (idle fingers already cut their PWM, and only one finger presses per ' +
        'string at a time). Turn it off to let everything move together.'),
      h('label.inline.builder-opt', [limitToggle,
        h('span', 'Limit how many servos start moving at once')])
    ];
    if (limitOn) {
      cmKids.push(h('div.grid3', [
        GMB.field('Max at once — whole instrument', GMB.input(pw, 'maxConcurrentMoves',
          { type: 'number', min: 0, max: 32 }), '0 = no overall cap'),
        GMB.field('Max at once — per PCA board', GMB.input(pw, 'maxConcurrentPerBoard',
          { type: 'number', min: 0, max: 16 }), '0 = no per-board cap (each board has its own supply)'),
        GMB.field('Stagger between starts (ms)', GMB.input(pw, 'staggerMs',
          { type: 'number', min: 0, max: 200 }), '0 disables staggering')
      ]));
    }
    body.appendChild(h('div.card.inset', [h('h3', 'Current management'), cmKids]));
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
    // The servo-start caps are optional (0 = no limit); a per-board cap can't exceed
    // a PCA9685's 16 channels.
    if (p.power && (p.power.maxConcurrentPerBoard || 0) > 16)
      out.push({ level: 'error', field: 'power', message: 'per-board concurrent moves exceeds a PCA9685 (16 channels)' });
    return out;
  };

  // The whole instrument setup is one main page (Instrument -> Frets -> Plucking ->
  // MIDI -> Timing -> Test -> Validation). Teardown releases the live MIDI socket the
  // MIDI step may hold and stops any running test sequence.
  GMB.views.setup = {
    render: function (host) { renderFlow(host, 'setup'); },
    teardown: function () {
      flowHost.setup = null;
      if (GMB.midiSettings && GMB.midiSettings.teardown) GMB.midiSettings.teardown();
      if (GMB.testRunner && GMB.testRunner.stop) GMB.testRunner.stop();
    }
  };
  // Jump straight to a named step of the setup page (e.g. from the Instrument view).
  GMB.gotoSetupStep = function (stepId) {
    var i = FLOWS.setup.indexOf(stepId);
    GMB.navigate('setup');
    if (i >= 0) { flowStep.setup = i; if (flowHost.setup) renderFlow(flowHost.setup, 'setup'); }
  };
  // Back-compat: the old "go to calibration" entry point now lands on the Frets step.
  GMB.openCalibration = function () {
    if (GMB.closeSettings) GMB.closeSettings();
    GMB.gotoSetupStep('frets');
  };
})(window);
