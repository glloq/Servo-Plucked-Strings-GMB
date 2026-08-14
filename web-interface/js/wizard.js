/*
 * wizard.js — the instrument DESIGNER and its guided calibration.
 *
 * Design rule (UX audit): a creation screen only shows the decisions the software
 * cannot take by itself. The user describes the MECHANICS of their machine — how
 * the frets are actuated, how the string is played, how it is stopped — and the
 * software derives everything else: which servos exist, which PCA9685 board and
 * channel each one lands on, the I²C topology, the timing and the MIDI mapping.
 * Anything derivable stays hidden until the user explicitly asks to change it.
 *
 * The physical machine has two independent halves per string, and the flow
 * mirrors that split so each can be calibrated and tested on its own:
 *
 *   • FRETS   — one finger servo per fret position; it presses the string against
 *               the fret. Step "Frets".
 *   • STRINGS — the plectrum / strum servo that sounds the string, plus the
 *               optional descent servo and damper. Step "Strings".
 *
 * ONE ordered flow (GMB.views.setup — a main page):
 *
 *     Instrument -> Frets -> Strings -> Test -> Finish
 *
 * i.e. DESIGN the instrument, calibrate what was generated, test it, then check
 * and apply. MIDI, timing, the servo-start governor, GPIO, I²C and SysEx are not
 * steps: they have recommended values the firmware uses on its own and live in
 * the gear menu for the day someone needs them.
 *
 * Every actuator step carries an Arm control and a "test bench" that drives ONE
 * servo or a whole GROUP (sweep every fret of a string, pluck every string, test
 * everything…) through the shared GMB.testRunner sequencer, with a live status
 * line and a Stop button.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  // The creation flow: five steps, each of them a question about the instrument
  // rather than about the firmware.
  var STEP_DEFS = {
    builder:  { label: 'Instrument', fn: stepBuilder },
    frets:    { label: 'Frets',      fn: stepFrets },
    strings:  { label: 'Strings',    fn: stepStrings },
    test:     { label: 'Test',       fn: stepTest },
    finish:   { label: 'Finish',     fn: stepFinish }
  };
  var FLOWS = {
    setup: ['builder', 'frets', 'strings', 'test', 'finish']
  };
  // Old step ids kept working (deep links, docs, the screenshot tool).
  var STEP_ALIASES = { plucking: 'strings', validation: 'finish', midi: 'builder', power: 'builder' };
  var flowStep = { setup: 0 };        // current step index
  var flowHost = { setup: null };     // mount element
  var currentFlow = 'setup';          // which flow a bare drawStep() targets

  var activeStr = 0;        // per-string steps show one string at a time
  var expandedFrets = {};   // Frets step: which fret rows show their servo editor

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
      out.push(Object.assign(servoIdentity(sv), { kind: 'servo', index: idx, active: true,
        us: sv[key] | 0, after: 450, label: 'S' + (strIdx + 1) + ' fret ' + f }));
      out.push(Object.assign(servoIdentity(sv), { kind: 'servo', index: idx, active: false,
        us: sv.restUs | 0, after: 250 }));
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
      out.push(Object.assign(servoIdentity(sv), { kind: 'servo', index: idx, active: false,
        us: sv.restUs | 0, after: 80, label: 'rest' }));
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
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: true,
        us: sk.activeUs | 0, after: 220, label: 'string ' + (i + 1) + ' strike' }));
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: false,
        us: sk.restUs | 0, after: 350 }));
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
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: true,
        us: sk.activeUs | 0, after: 220, label: 'S' + (i + 1) + ' down' }));
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: false,
        us: sk.restUs | 0, after: 180 }));
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: true,
        us: up | 0, after: 220, label: 'S' + (i + 1) + ' up' }));
      out.push(Object.assign(servoIdentity(sk), { kind: 'servo', index: idx, active: false,
        us: sk.restUs | 0, after: 300 }));
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
      out.push(Object.assign(servoIdentity(sv), { kind: 'servo', index: idx, active: true,
        us: sv.activeUs | 0, after: 300, label: 'string ' + (i + 1) + ' ' + verb }));
      out.push(Object.assign(servoIdentity(sv), { kind: 'servo', index: idx, active: false,
        us: sv.restUs | 0, after: 300 }));
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

  // A live configuration health line, visible on EVERY step rather than only on
  // the last one (UX audit 14): the user always knows whether what they are
  // building is currently valid, and one click takes them to the details.
  function healthBar(flowKey) {
    var issues = GMB.validateProfile(GMB.state.profile);
    var errors = issues.filter(function (i) { return i.level === 'error'; }).length;
    var warns = issues.length - errors;
    var cls = errors ? 'bad' : (warns ? 'warn' : 'good');
    return h('button.healthbar.' + cls, {
      type: 'button',
      title: 'Go to the final check',
      onclick: function () { goto(flowKey, FLOWS[flowKey].indexOf('finish')); }
    }, [
      h('span.hb-dot', { 'aria-hidden': 'true' }, errors ? '🔴' : (warns ? '🟡' : '🟢')),
      h('span', errors ? (errors + ' error' + (errors > 1 ? 's' : '')) : 'No error'),
      warns ? h('span.muted', '· ' + warns + ' recommendation' + (warns > 1 ? 's' : '')) : null,
      h('span.spacer'),
      h('span.muted', 'see the check →')
    ]);
  }

  // Render a flow's stepper + body + nav into `host`.
  function renderFlow(host, flowKey) {
    if (!host) return;
    GMB.testRunner.stop();   // never leave a sequence running across a full re-render
    flowHost[flowKey] = host;
    currentFlow = flowKey;
    var steps = FLOWS[flowKey];
    if (flowStep[flowKey] >= steps.length) flowStep[flowKey] = 0;
    var step = flowStep[flowKey];
    host.innerHTML = '';
    host.appendChild(healthBar(flowKey));
    host.appendChild(h('div.card.wizard-card', [
      h('div.stepper', { role: 'tablist', 'aria-label': 'Configuration steps' },
        steps.map(function (id, i) {
          var d = STEP_DEFS[id];
          return h('button.step' + (i === step ? '.active' : '') + (i < step ? '.done' : ''),
            { role: 'tab', 'aria-selected': i === step ? 'true' : 'false',
              onclick: function () { goto(flowKey, i); } },
            [h('span.step-num', String(i + 1)), h('span.step-label', d.label)]);
        })),
      h('div.wizard-body', { id: bodyId(flowKey) }),
      h('div.wizard-nav', [
        step > 0 ? GMB.button('Back', function () { goto(flowKey, step - 1); }, 'ghost') : null,
        h('span.spacer'),
        h('span.muted', 'Step ' + (step + 1) + ' / ' + steps.length),
        h('span.spacer'),
        step < steps.length - 1
          ? GMB.button('Next: ' + STEP_DEFS[steps[step + 1]].label,
              function () { goto(flowKey, step + 1); }, 'primary')
          : null
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
    // Disclosures inside a step redraw the STEP, not the whole page, so opening
    // "Advanced" never scrolls the user back to the top.
    GMB.setRedraw(function () { drawStep(flowKey); });
    body.innerHTML = '';
    var id = FLOWS[flowKey][flowStep[flowKey]];
    STEP_DEFS[id].fn(body);
    var bar = flowHost[flowKey] && flowHost[flowKey].querySelector('.healthbar');
    if (bar) flowHost[flowKey].replaceChild(healthBar(flowKey), bar);
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
    var damper = !!perStringServo(i, 'damper'), lift = !!perStringServo(i, 'strumLift');
    // How the string is STOPPED at Note Off, read back from the mechanics that
    // are actually wired (the designer's third question).
    var stop = 'ring';
    if (damper) stop = 'damper';
    else if (lift && p.pluck && p.pluck.liftMuteOnNoteOff) stop = 'lift';
    else if (striker && (striker.muteUs | 0) > 0) stop = 'plectrum';
    return {
      fretting: fretting, gearThreshold: gt,
      sounding: striker && striker.function === 'strum' ? 'strum' : 'pluck',
      alternate: !!(striker && striker.alternateDirection),
      stop: stop, lift: lift, damper: damper
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
      alternate: modeOf(specs.map(function (s) { return s.alternate; }), true),
      stop: modeOf(specs.map(function (s) { return s.stop; }), 'ring'),
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
  // True when the strings do not all share the same value for a derived field —
  // the designer then shows "mixed" instead of pretending one card is selected.
  function stringsDisagree(field) {
    var vals = GMB.state.profile.strings.map(function (_, i) { return deriveStringSpec(i)[field]; });
    return vals.some(function (v) { return v !== vals[0]; });
  }
  // Set the global fretting mechanism. Fretting is an instrument-wide choice (there
  // is no per-string fretting control — only per-string *sounding*), so choosing it
  // clears any per-string fretting override derived from a loaded profile, keeping
  // the global card authoritative.
  // The mechanical spec is DERIVED from the servo list, and any entry point may
  // be the first one to need it — the Advanced-hardware panels are reachable
  // without ever opening the designer.
  function ensureBuilder() {
    var p = GMB.state.profile;
    if (builder === null || builderRef !== p) { builder = deriveSpec(); builderRef = p; }
    return builder;
  }

  function setGlobalFretting(v) {
    builder.global.fretting = v;
    clearOverrides(['fretting']);
    autoGenerate();
    drawStep();
  }
  // Drop per-string overrides for the given fields: an instrument-wide mechanical
  // choice must be authoritative, otherwise a card looks selected while some
  // strings quietly keep the old mechanism.
  function clearOverrides(fields) {
    Object.keys(builder.perString).forEach(function (i) {
      fields.forEach(function (f) { delete builder.perString[i][f]; });
      if (!Object.keys(builder.perString[i]).length) delete builder.perString[i];
    });
  }

  // ---- the three designer questions ------------------------------------------
  // "How is the string played?" — one card per mechanism, mapped onto the servo
  // role (pluck / strum) and the stroke style (single or alternating).
  function setGlobalMotion(motion) {
    var g = builder.global;
    g.sounding = motion === 'strum' ? 'strum' : 'pluck';
    g.alternate = motion !== 'single';
    clearOverrides(['sounding']);
    autoGenerate();
    applyStrokeStyle();
    drawStep();
  }
  function currentMotion() {
    var g = builder.global;
    return g.sounding === 'strum' ? 'strum' : (g.alternate ? 'alternate' : 'single');
  }
  // "How is the string stopped?" — this is the only place the mute policy is
  // chosen; the per-string calibration then just adjusts the angles.
  function setGlobalStop(v) {
    var g = builder.global, p = GMB.state.profile;
    g.stop = v;
    g.damper = (v === 'damper');
    g.lift = (v === 'lift');
    clearOverrides(['lift', 'damper']);
    ensurePluckConfig(p);
    p.pluck.muteSource = ({ ring: 'none', plectrum: 'plectrum', damper: 'damper', lift: 'lift' })[v] || 'auto';
    p.pluck.liftMuteOnNoteOff = (v === 'lift');
    autoGenerate();
    applyStopPositions();
    drawStep();
  }
  // Seed / clear the plectrum's own mute position so the chosen stop mechanism is
  // immediately usable (the user only fine-tunes the angle afterwards).
  function applyStopPositions() {
    var p = GMB.state.profile;
    p.strings.forEach(function (_, i) {
      var sk = strikerFor(i);
      if (!sk) return;
      var wantPlectrumMute = effectiveStop(i) === 'plectrum';
      if (wantPlectrumMute && !((sk.muteUs | 0) > 0)) sk.muteUs = sk.restUs;
      if (!wantPlectrumMute) sk.muteUs = 0;
    });
    GMB.markDirty();
  }
  // Push the chosen stroke style onto every striker. buildStringServos only seeds
  // NEW servos, so an existing calibrated plectrum needs this explicit pass —
  // and an up-stroke is only ever seeded INSIDE the pulse window (the firmware
  // refuses an implicit out-of-window mirror).
  function applyStrokeStyle() {
    GMB.state.profile.strings.forEach(function (_, i) {
      var sk = strikerFor(i);
      if (!sk) return;
      var alt = effectiveSpec(i).alternate;
      sk.alternateDirection = !!alt;
      if (alt && !(sk.activeAltUs > 0)) {
        var mirror = 2 * sk.restUs - sk.activeUs;
        sk.activeAltUs = Math.max(sk.pulseMinUs || 500, Math.min(sk.pulseMaxUs || 2500, mirror));
      }
    });
    GMB.markDirty();
  }
  function effectiveStop(i) {
    var o = builder.perString[i] || {};
    if (o.damper) return 'damper';
    if (o.damper === false && builder.global.stop === 'damper') return 'ring';
    return builder.global.stop;
  }

  // The effective spec for string i (global merged with its overrides).
  function effectiveSpec(i) {
    var p = GMB.state.profile, g = builder.global, o = builder.perString[i] || {};
    return {
      maxFret: p.strings[i].maxFret,
      fretting: o.fretting || g.fretting,
      gearThreshold: g.gearThreshold,
      sounding: o.sounding || g.sounding,
      alternate: o.alternate !== undefined ? o.alternate : g.alternate,
      lift: o.lift !== undefined ? o.lift : (g.lift || g.stop === 'lift'),
      damper: o.damper !== undefined ? o.damper : (g.damper || g.stop === 'damper'),
      board: i
    };
  }
  function previewServos() {
    var p = GMB.state.profile;
    ensureBuilder();
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
    // A board is a (bus, address) pair (audit 7): kept servos already carry their
    // own i2cBus verbatim, so the overlay only applies to NEWLY generated servos,
    // and only when the address maps to ONE bus — an address wired on both buses
    // (bus0/0x40 + bus1/0x40) must never drag everything onto one of them.
    var prior = p.servos.slice();
    var addrBus = {};  // PCA address -> which buses carry it in the committed wiring
    prior.forEach(function (s) {
      if (s.source !== 'pca') return;
      var m = addrBus[s.pcaBoard] || (addrBus[s.pcaBoard] = {});
      m[s.i2cBus === 1 ? 1 : 0] = true;
    });
    p.servos = GMB.buildInstrument(effectiveSpec, p.strings, p.servos).concat(aux);
    p.servos.forEach(function (s) {
      if (s.source !== 'pca' || prior.indexOf(s) >= 0) return;  // kept: bus untouched
      var m = addrBus[s.pcaBoard];
      if (m && m[1] && !m[0]) s.i2cBus = 1;  // address lives ONLY on bus 1
    });
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

  // Load a type preset: tuning + GM tags + chromatic+pluck wiring. The rebuild is
  // DIFFERENTIAL (audit 6): every servo whose mechanical identity survives keeps
  // its full calibration and wiring — re-clicking the current preset on a
  // calibrated instrument changes NOTHING. Only when actuators would actually
  // disappear (fewer strings / structural change) does an explicit confirm ask
  // before dropping them; cancelling restores the profile untouched.
  function applyPreset(type, force) {
    var p = GMB.state.profile, t = TUNINGS[type];
    var snap = {
      type: p.instrument.type, gmProgram: p.instrument.gmProgram,
      typeId: p.instrument.typeId, hostname: p.network.hostname,
      strings: p.strings, stringCount: p.instrument.stringCount,
      builder: builder, builderRef: builderRef
    };
    p.instrument.type = type;
    // Starting from the welcome screen there is nothing to preserve: give the
    // instrument the template's name rather than leaving the demo one on it.
    if (force) p.instrument.name = cap(type);
    if (GM_PROGRAM[type]) p.instrument.gmProgram = GM_PROGRAM[type];
    if (TYPE_ID[type]) p.instrument.typeId = TYPE_ID[type];
    p.network.hostname = 'gmb-' + type;
    if (t) {
      p.strings = t.notes.map(function (n) { return { enabled: true, openNote: n, maxFret: t.maxFret }; });
      p.instrument.stringCount = t.notes.length;
      builder = { global: { fretting: 'chromatic', gearThreshold: 6, sounding: 'pluck',
        alternate: true, stop: 'ring', lift: false, damper: false, wiring: 'perString' },
        perString: {} };
      builderRef = p;
      var aux = p.servos.filter(function (s) { return s.function === 'aux'; });
      var before = p.servos.filter(function (s) { return s.function !== 'aux'; });
      var rebuilt = GMB.buildInstrument(effectiveSpec, p.strings, p.servos);
      // mergeBuilderServos returns the SAME objects for surviving servos, so an
      // identity count tells exactly how many calibrated actuators would vanish.
      var kept = 0;
      rebuilt.forEach(function (s) { if (before.indexOf(s) >= 0) kept++; });
      var dropped = before.length - kept;
      if (dropped > 0 && !force &&
          !confirm('Switching to the ' + cap(type) + ' preset removes ' + dropped +
                   ' calibrated actuator(s) whose string/position no longer exists.' +
                   '\n\nContinue?')) {
        p.instrument.type = snap.type;
        p.instrument.gmProgram = snap.gmProgram;
        p.instrument.typeId = snap.typeId;
        p.network.hostname = snap.hostname;
        p.strings = snap.strings;
        p.instrument.stringCount = snap.stringCount;
        builder = snap.builder;
        builderRef = snap.builderRef;
        drawStep();
        return;
      }
      p.servos = rebuilt.concat(aux);
      ensureBusPins();   // a preset is single-bus: drop any stale SDA2/SCL2/OE2 pins
      syncSelection();
      GMB.markDirty();
      drawStep();
      GMB.toast('Loaded ' + type + ' — existing calibrations kept, new positions ' +
                'use defaults.', 'ok');
      return;
    }
    drawStep();
    GMB.toast('Loaded ' + type + '.', 'ok');
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

  // A physical PCA9685 is identified by (i2cBus, address) — the SAME model the
  // firmware uses (ServoBank::board() = i2cBus*8 + pcaBoard). Keying the UI on the
  // address alone collapsed bus0/0x40 and bus1/0x40 into one row and let a bus
  // change drag both physical boards along (audit 7).
  function distinctPcaUnits() {
    var seen = {}, out = [];
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source !== 'pca') return;
      var bus = s.i2cBus === 1 ? 1 : 0, k = bus + ':' + s.pcaBoard;
      if (!(k in seen)) { seen[k] = 1; out.push({ bus: bus, board: s.pcaBoard }); }
    });
    return out.sort(function (a, b) { return a.bus - b.bus || a.board - b.board; });
  }
  function anyBus1() { return GMB.state.profile.servos.some(function (s) { return s.source === 'pca' && s.i2cBus === 1; }); }
  // Move ONE physical board (bus, address) to the other bus. Refused when the
  // destination bus already carries a board at the same address — two boards can
  // never share an address on one bus.
  function setUnitBus(unit, bus) {
    bus = bus ? 1 : 0;
    if (bus === unit.bus) return true;
    var clash = GMB.state.profile.servos.some(function (s) {
      return s.source === 'pca' && s.pcaBoard === unit.board &&
             (s.i2cBus === 1 ? 1 : 0) === bus;
    });
    if (clash) {
      GMB.toast('Bus ' + bus + ' already has a PCA at 0x' +
                (0x40 + unit.board).toString(16) +
                ' — re-address one of the boards first.', 'error');
      return false;
    }
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca' && s.pcaBoard === unit.board &&
          (s.i2cBus === 1 ? 1 : 0) === unit.bus)
        s.i2cBus = bus;
    });
    ensureBusPins();
    GMB.markDirty();
    return true;
  }
  // The second-bus signals (SDA2/SCL2) exist in the profile iff a board is on bus 1.
  // Their default GPIO comes from the BOARD PROFILE only — never a hard-coded
  // number: e.g. GPIO38 is free on a DevKitC-1 v1.0 but is the RGB LED on v1.1,
  // so a wrong revision-blind fallback would silently fight an on-board device.
  // No recommendation on the profile -> the pin is left unassigned (-1) and the
  // GPIO sub-tab / wiring checks flag it until the user picks one.
  function ensureBusPins() {
    var p = GMB.state.profile;
    p.pins = p.pins || [];
    var has = function (sig) { return p.pins.some(function (x) { return x.signal === sig; }); };
    if (anyBus1()) {
      var R = rec();
      if (!has('SDA2')) p.pins.push({ signal: 'SDA2', kind: 'sda', gpio: R.SDA2 != null ? R.SDA2 : -1 });
      if (!has('SCL2')) p.pins.push({ signal: 'SCL2', kind: 'scl', gpio: R.SCL2 != null ? R.SCL2 : -1 });
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
        // Board-profile default only (no hard-coded pin) — unassigned when absent.
        var R = rec();
        p.pins.push({ signal: 'SERVO_OE2', kind: 'servoOe', gpio: R.SERVO_OE2 != null ? R.SERVO_OE2 : -1 });
      }
    } else {
      p.pins = p.pins.filter(function (x) { return x.signal !== 'SERVO_OE2'; });
    }
    GMB.markDirty();
  }
  // Distribute the boards evenly across the two buses (first half → bus 0).
  function autoSplitBuses() {
    var units = distinctPcaUnits(), half = Math.ceil(units.length / 2);
    units.forEach(function (u, i) { setUnitBus(u, i >= half ? 1 : 0); });
  }
  function setSecondBus(on) {
    if (on) { if (!anyBus1()) autoSplitBuses(); }
    else {
      // Merging everything onto bus 0 is impossible when both buses carry a
      // board at the SAME address — they would collapse into one phantom board.
      var units = distinctPcaUnits();
      var clash = units.some(function (u) {
        return u.bus === 1 && units.some(function (v) {
          return v.bus === 0 && v.board === u.board;
        });
      });
      if (clash) {
        GMB.toast('Cannot merge onto one bus: both buses carry a PCA at the same ' +
                  'address — re-address one of the boards first.', 'error');
        return;
      }
      GMB.state.profile.servos.forEach(function (s) { if (s.source === 'pca') s.i2cBus = 0; });
      ensureBusPins(); GMB.markDirty();
    }
  }

  // The Builder's I²C-bus control: a toggle, per-board bus pickers and auto-split.
  // One row per PHYSICAL board — a (bus, address) pair — so bus0/0x40 and
  // bus1/0x40 show as the two distinct components they are (audit 7).
  function busTopology() {
    var boards = distinctPcaUnits();
    var two = anyBus1();
    var R = rec();
    var toggle = h('input', { type: 'checkbox', checked: two });
    toggle.addEventListener('change', function () { setSecondBus(toggle.checked); drawStep(); });
    var kids = [h('label.inline.builder-opt', [toggle,
      h('span', 'Use a second I²C bus — split the PCA9685 boards across the ESP32-S3’s two I²C controllers ' +
        '(Wire + Wire1) to cut bus traffic and refresh the servos faster on large instruments')])];
    if (two) {
      var n0 = boards.filter(function (u) { return u.bus === 0; }).length;
      kids.push(h('div.bus-grid', boards.map(function (u) {
        var sel = GMB.input({ v: u.bus }, 'v', { type: 'select', coerce: Number,
          options: [{ value: 0, label: 'Bus 0' }, { value: 1, label: 'Bus 1' }],
          onChange: function (v) { setUnitBus(u, Number(v)); drawStep(); } });
        return h('div.bus-board', [h('span.bus-board-id', 'PCA #' + u.board + ' · 0x' + (0x40 + u.board).toString(16)), sel]);
      })));
      // Defaults shown come from the BOARD PROFILE (revision-aware) — a board with
      // no recommendation leaves the pin unassigned until the GPIO sub-tab sets it.
      var gpName = function (g) { return g != null ? 'GPIO' + g : 'unassigned'; };
      kids.push(h('div.row', [
        GMB.button('Auto-split evenly', function () { autoSplitBuses(); drawStep(); }, 'ghost'),
        h('span.muted', 'Bus 0: ' + n0 + ' · Bus 1: ' + (boards.length - n0) + ' board(s). ' +
          'Assign the SDA2 / SCL2 pins in the GPIO sub-tab (Wiring & GPIO) (board default ' +
          gpName(R.SDA2) + ' / ' + gpName(R.SCL2) + ').')
      ]));
      var oeToggle = h('input', { type: 'checkbox', checked: hasOe2() });
      oeToggle.addEventListener('change', function () { setSplitOe(oeToggle.checked); drawStep(); });
      kids.push(h('label.inline.builder-opt', [oeToggle,
        h('span', 'Separate the /OE safety line per bus (adds SERVO_OE2, board default ' +
          gpName(R.SERVO_OE2) + ') — otherwise both buses share the single /OE line')]));
    }
    return h('div.bus-topology', kids);
  }

  // PCA9685 channel usage per (bus, board) + direct-GPIO count vs firmware limits.
  function capacityReport() {
    var preview = previewServos().concat(auxServos());
    // A kept preview servo carries its own i2cBus verbatim; only FRESHLY generated
    // ones need the committed board→bus overlay, and only when the address maps to
    // a single bus — an address wired on both buses stays where each servo says
    // (audit 7: the old address-only table folded bus0/0x40 onto bus1/0x40).
    var addrBus = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source !== 'pca') return;
      var m = addrBus[s.pcaBoard] || (addrBus[s.pcaBoard] = {});
      m[s.i2cBus === 1 ? 1 : 0] = true;
    });
    var byKey = {}, direct = 0;
    preview.forEach(function (s) {
      if (s.source === 'gpio') { direct++; return; }
      var m = addrBus[s.pcaBoard];
      var bus = s.i2cBus === 1 ? 1 : (m && m[1] && !m[0] ? 1 : 0);
      var k = bus + ':' + s.pcaBoard;
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

  // ---- what the chosen mechanics will produce (the designer's live answer) ----
  // The user describes the machine; this tells them, in their own vocabulary,
  // what the software just generated for them.
  function mechanicsSummary() {
    var p = GMB.state.profile;
    var preview = previewServos();
    var count = function (fn) { return preview.filter(function (s) { return s.function === fn; }).length; };
    var boards = {};
    preview.forEach(function (s) { if (s.source === 'pca') boards[(s.i2cBus === 1 ? 1 : 0) + ':' + s.pcaBoard] = 1; });
    var nBoards = Object.keys(boards).length;
    var items = [
      [p.strings.length, p.strings.length > 1 ? 'strings' : 'string'],
      [count('finger'), count('finger') === 1 ? 'finger servo' : 'finger servos'],
      [count('pluck') + count('strum'), 'plectrum' + (count('pluck') + count('strum') === 1 ? '' : 's')]
    ];
    if (count('strumLift')) items.push([count('strumLift'), 'descent servo' + (count('strumLift') === 1 ? '' : 's')]);
    if (count('damper')) items.push([count('damper'), 'damper' + (count('damper') === 1 ? '' : 's')]);
    items.push([nBoards, 'PCA9685 board' + (nBoards === 1 ? '' : 's') + ' needed']);
    return h('div.mech-summary', items.map(function (it) {
      return h('div.ms-item', [h('strong', String(it[0])), h('span', it[1])]);
    }));
  }

  function stepBuilder(body) {
    var p = GMB.state.profile;
    var g = ensureBuilder().global;
    var strings = p.strings;

    // ---- 1. identity: a starting point and a name ---------------------------
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

    // ---- 2. strings & tuning -------------------------------------------------
    // Changing the string count or a max fret re-generates the wiring
    // DIFFERENTIALLY: servos that still exist mechanically keep their full
    // calibration + wiring; only new positions get defaults.
    body.appendChild(builderSection('Strings & tuning', [
      h('div.row', [
        GMB.field('Number of strings', GMB.input(p.instrument, 'stringCount',
          { type: 'number', min: 1, max: 6,
            onChange: function (v) { setStringCount(v); autoGenerate(); drawStep(); } }))
      ]),
      h('div.string-rows', strings.map(function (s, i) { return stringRow(s, i); })),
      h('p.muted', 'Structure changes keep every existing servo’s calibration and ' +
        'wiring; only newly added positions start from defaults.')
    ]));

    // ---- 3. the mechanics: the three questions only the builder can answer ---
    var maxF = Math.max.apply(null, strings.map(function (s) { return s.maxFret; }).concat([0]));
    var nFret = function (kind) { return fingerCountForFretting(kind, g.gearThreshold, strings); };
    var frettingCards = [
      radioCard(g.fretting === 'chromatic', 'One servo per fret',
        'Every fret of every string gets its own finger. The most direct build, and ' +
        'the one that plays anything.', nFret('chromatic') + ' servos',
        function () { setGlobalFretting('chromatic'); }),
      radioCard(g.fretting === 'geared', 'One servo for two frets',
        'A geared finger presses one of two neighbouring frets depending on which ' +
        'way it turns. Halves the servo count on the low frets.',
        nFret('geared') + ' servos', function () { setGlobalFretting('geared'); }),
      radioCard(g.fretting === 'open', 'Open strings only',
        'No fingers at all — each string only plays its open note.', '0 servos',
        function () { setGlobalFretting('open'); }),
      radioCard(g.fretting === 'custom', 'Custom',
        'Keep the fret wiring exactly as it is; nothing is regenerated. Pick this ' +
        'when you laid the fingers out by hand.', null,
        function () { setGlobalFretting('custom'); })
    ];
    var frettingKids = [h('div.radio-row', frettingCards)];
    if (g.fretting === 'geared') {
      frettingKids.push(h('div.row', [
        GMB.field('Pair the frets up to', GMB.input(g, 'gearThreshold', {
          type: 'number', min: 2, max: Math.max(2, maxF),
          onChange: function () { autoGenerate(); drawStep(); } }),
          'frets above this stay on their own servo')
      ]));
    }
    if (stringsDisagree('fretting'))
      frettingKids.push(h('div.pill.warn', 'Your strings currently use different fret mechanisms — ' +
        'picking one above applies it to all of them.'));
    body.appendChild(builderSection('How are the frets actuated?', frettingKids,
      'the servos are generated from this answer'));

    var motion = currentMotion();
    var soundKids = [h('div.radio-row', [
      radioCard(motion === 'single', 'Single pick',
        'One plectrum per string, striking in one direction and coming back to rest.',
        null, function () { setGlobalMotion('single'); }),
      radioCard(motion === 'alternate', 'Back-and-forth pick',
        'The plectrum strikes down, then up on the next note — faster repeats, no ' +
        'return travel between them.', 'recommended',
        function () { setGlobalMotion('alternate'); }),
      radioCard(motion === 'strum', 'Strum, up and down',
        'A strumming arm sweeping across the string in both directions, with an ' +
        'optional descent servo to lift it clear.', null,
        function () { setGlobalMotion('strum'); })
    ])];
    if (stringsDisagree('sounding') || stringsDisagree('alternate'))
      soundKids.push(h('div.pill.warn', 'Your strings currently play differently from one another — ' +
        'picking one above applies it to all of them.'));
    body.appendChild(builderSection('How is the string played?', soundKids));

    var stopKids = [h('div.radio-row', [
      radioCard(g.stop === 'ring', 'Let it ring',
        'Nothing stops the string; it decays on its own. Nothing extra to build.',
        null, function () { setGlobalStop('ring'); }),
      radioCard(g.stop === 'plectrum', 'The plectrum itself',
        'At Note Off the plectrum leans back onto the string and damps it. No extra ' +
        'servo needed.', null, function () { setGlobalStop('plectrum'); }),
      radioCard(g.stop === 'damper', 'A damper',
        'A dedicated felt/foam servo per string presses the string to stop it.',
        '+' + strings.length + ' servos', function () { setGlobalStop('damper'); }),
      radioCard(g.stop === 'lift', 'A descent servo',
        'The servo that lowers the plectrum stays leaning on the string to mute it.',
        '+' + strings.length + ' servos', function () { setGlobalStop('lift'); })
    ])];
    if (stringsDisagree('stop'))
      stopKids.push(h('div.pill.warn', 'Your strings currently stop differently from one another — ' +
        'picking one above applies it to all of them.'));
    body.appendChild(builderSection('How is the string stopped?', stopKids));

    // ---- 4. what the software decided for you --------------------------------
    var boardName = ((GMB.boardList ? GMB.boardList() : [])
      .filter(function (b) { return b.id === (p.board && p.board.profile); })[0] || {}).name ||
      (p.board && p.board.profile) || 'unknown';
    body.appendChild(builderSection('Your instrument', [
      mechanicsSummary(),
      GMB.summaryLine('Controller', boardName, 'Change',
        function () { GMB.openSettings && GMB.openSettings('hardware'); }),
      GMB.summaryLine('Wiring', 'generated automatically', 'View',
        function () { GMB.navigate('hardware'); }),
      GMB.summaryLine('MIDI', 'automatic', 'Configure MIDI…',
        function () { GMB.openSettings && GMB.openSettings('midi'); }),
      GMB.summaryLine('Timing & power', 'recommended values', 'Adjust…',
        function () { GMB.openSettings && GMB.openSettings('hardware'); }),
      GMB.disclosure('builder-advanced', 'Advanced options', function () {
        return [
          h('p.muted', 'Everything here has a working default. You only need it when ' +
            'the hardware does not match the recommended build.'),
          h('div.toolbar', [
            GMB.button('Advanced hardware (board, GPIO, I²C, power)…', function () {
              GMB.openSettings && GMB.openSettings('hardware');
            }, 'ghost')
          ]),
          h('div.danger-zone', [
            h('h4', 'Danger zone'),
            h('p.muted', 'Rebuilds every servo from the chosen mechanics: all calibrated ' +
              'angles, directions, timings and PCA/GPIO assignments go back to factory ' +
              'defaults. There is no undo.'),
            GMB.button('Reset wiring & calibration to defaults', function () {
              if (!confirm('Rebuild ALL servos from the chosen mechanics?\n\nEvery ' +
                           'calibrated angle, direction, timing and PCA/GPIO assignment ' +
                           'will be replaced by factory defaults.')) return;
              var aux = p.servos.filter(function (s) { return s.function === 'aux'; });
              p.servos = GMB.buildInstrument(effectiveSpec, p.strings, []).concat(aux);
              ensureBusPins();
              syncSelection();
              GMB.markDirty();
              drawStep();
              GMB.toast('Wiring and calibration reset to defaults.', 'warn');
            }, 'danger')
          ])
        ];
      })
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
        // The main page is 'setup' since the UI redesign — the old 'wizard' check
        // meant a WROOM-32/DevKit board profile arriving async never refreshed the
        // GPIO picker, leaving the S3 fallback pinout on screen (audit 4 P2.4).
        if (b && b.pins) { boardModel = b; if (GMB.state.current === 'setup') drawStep(); }
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
      // Caution pins are offered (the user explicitly opened the manual wiring
      // editor) but stay labelled as such below.
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
  // Mechanical identity of a servo for live tests: the firmware resolves it
  // against the ACTIVE profile instead of trusting the draft's array index,
  // which drifts as soon as the draft's servo list is edited (audit 5 P0).
  function servoIdentity(sv) {
    var id = { function: sv.function, stringIndex: sv.stringIndex };
    if (sv.function === 'finger' && sv.fret >= 1) id.fret = sv.fret;
    // Output binding: the firmware refuses the test when the draft's wiring
    // differs from the active servo's (audit 6 — same identity, drifted output).
    id.source = sv.source === 'gpio' ? 'gpio' : 'pca';
    if (id.source === 'gpio') id.gpio = sv.gpio | 0;
    else { id.i2cBus = sv.i2cBus || 0; id.pcaBoard = sv.pcaBoard | 0; id.channel = sv.channel | 0; }
    return id;
  }

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
      if (idx >= 0) {
        var payload = servoIdentity(sv);
        payload.index = idx; payload.active = true; payload.us = sv[key] | 0;
        GMB.api.testServo(payload).catch(function () {});
      }
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

  // Where a servo is plugged in, in one line: "PCA #2 · CH7" or "GPIO18".
  function wiringText(sv) {
    if (sv.source === 'gpio') return sv.gpio >= 0 ? ('GPIO' + sv.gpio) : 'no GPIO assigned';
    var bus = anyBus1() ? ('bus ' + (sv.i2cBus === 1 ? 1 : 0) + ' · ') : '';
    return bus + 'PCA #' + (sv.pcaBoard | 0) + ' · CH' + (sv.channel | 0);
  }
  // Per-servo wiring: a one-line SUMMARY of what the software already assigned,
  // and the full editor only when the user asks for it (UX audit 3). Board, bus
  // and channel are decisions the generator makes; a calibration screen should
  // not open with them (they used to be the first thing on every fret).
  //
  // NEVER mutates the servo's source — the old pcaPinRow silently converted a
  // direct-GPIO servo to PCA just by OPENING its editor (audit 4 P1.1); mixing
  // PCA and direct GPIO is a supported feature.
  var wiringKeys = [];              // stable disclosure keys, one per servo object
  function wiringKey(sv) {
    var i = wiringKeys.indexOf(sv);
    if (i < 0) { i = wiringKeys.length; wiringKeys.push(sv); }
    return 'wiring:' + i;
  }
  function wiringRow(sv) {
    var ok = sv.source === 'gpio' ? sv.gpio >= 0 : (sv.channel >= 0 && sv.channel <= 15);
    var key = wiringKey(sv);
    var open = GMB.isDisclosed(key);
    return h('div.wiring-block', [
      GMB.summaryLine('Wiring', wiringText(sv), open ? 'Done' : 'Change…',
        function () { GMB.setDisclosed(key, !open); drawStep(); }, ok),
      open ? h('div.disclosure-body', h('div.grid2', servoSourceEditor(sv))) : null
    ]);
  }

  // "The servo turns the wrong way? [Invert]" — a verb the builder understands,
  // instead of a checkbox called "Reverse rotation direction" (UX audit 3).
  function invertRow(sv, what) {
    return h('div.invert-row', [
      h('span.muted', 'The ' + (what || 'servo') + ' moves the wrong way?'),
      GMB.button(sv.inverted ? 'Inverted ✓ — undo' : 'Invert', function () {
        sv.inverted = !sv.inverted;
        GMB.markDirty();
        drawStep();
      }, sv.inverted ? 'ghost' : 'ghost')
    ]);
  }

  function testServoBtn(label, sv, active) {
    return GMB.button(label, function () {
      var idx = servoIndexOf(sv);
      if (idx < 0) return;
      // Send the DRAFT pulse (activeUs/restUs read at click time) so an unsaved
      // calibration angle previews live, instead of the currently-active profile's.
      var us = (active ? sv.activeUs : sv.restUs) | 0;
      var payload = servoIdentity(sv);
      payload.index = idx; payload.active = active; payload.us = us;
      GMB.api.testServo(payload).then(function () {
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
      var payload = servoIdentity(sv);
      payload.index = idx; payload.active = true; payload.us = sv[key] | 0;
      GMB.api.testServo(payload).then(function () {
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

    // Calibrating ONE fret: the two positions the builder has to find with their
    // own eyes (rest and press), a live test, and a jump to the next fret. The
    // wiring is a one-line summary and the gearing / fine timing sit behind
    // "Advanced" — a fret editor used to open on PCA board, I²C bus and channel
    // before showing a single angle (UX audit 3).
    var hasAdjacent = (fret + 1 <= p.strings[strIdx].maxFret) || (fret - 1 >= 1 && !fingerFor(strIdx, fret - 1));
    var syncRest = function () { sv.restUs = Math.round((sv.activeUs + sv.activeBUs) / 2); };
    var angles = geared ? [
      angleStepper(sv, 'activeUs', 'Press · fret ' + sv.fret, 'presses fret ' + sv.fret, syncRest),
      angleStepper(sv, 'activeBUs', 'Press · fret ' + sv.fretB, 'presses fret ' + sv.fretB, syncRest)
    ] : [
      angleStepper(sv, 'restUs', 'Rest position', 'finger lifted off the string'),
      angleStepper(sv, 'activeUs', 'Press position', 'finger pressing the fret')
    ];

    var detail = [h('div.grid2', angles)];
    detail.push(geared
      ? h('div.row', [
          testPulseBtn('Test fret ' + sv.fret, sv, 'activeUs', 'Servo → fret ' + sv.fret),
          testPulseBtn('Test fret ' + sv.fretB, sv, 'activeBUs', 'Servo → fret ' + sv.fretB),
          testPulseBtn('→ rest', sv, 'restUs', 'Servo → rest (midpoint)'),
          playNoteBtn(strIdx, sv.fret, '▶ Play ' + sv.fret),
          playNoteBtn(strIdx, sv.fretB, '▶ Play ' + sv.fretB),
          nextFretBtn(strIdx, fret)])
      : h('div.row', [
          testServoBtn('→ rest', sv, false),
          testServoBtn('Test', sv, true),
          playNoteBtn(strIdx, fret),
          nextFretBtn(strIdx, fret)]));
    detail.push(invertRow(sv, 'finger'));
    detail.push(wiringRow(sv));
    detail.push(GMB.disclosure('fret-adv:' + strIdx + ':' + fret, 'Advanced', function () {
      var gearToggle = h('input', { type: 'checkbox', checked: geared, disabled: !geared && !hasAdjacent });
      gearToggle.addEventListener('change', function () { setGeared(sv, gearToggle.checked, strIdx); drawStep(); });
      return [
        h('label.inline.builder-opt', [gearToggle,
          h('span', 'This servo drives 2 frets (geared)' +
            (!geared && !hasAdjacent ? ' — no free adjacent fret' : ''))]),
        h('div.grid2', [
          GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 5000 }),
            'time to move between rest and press'),
          GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 5000 }),
            'pause once the finger has arrived')
        ]),
        h('div.row', [GMB.button('Remove this finger servo', function () {
          if (!confirm('Remove the finger servo on fret ' + fret + '? The fret becomes unplayable.')) return;
          removeServo(sv); drawStep();
        }, 'danger-ghost')])
      ];
    }));
    return h('div.fret-line-wrap', [line, h('div.fret-detail', detail)]);
  }

  // "Next →": close this fret, open the next equipped one on the same string, so
  // calibration is a walk rather than a hunt.
  function nextFretBtn(strIdx, fret) {
    var s = GMB.state.profile.strings[strIdx];
    var next = -1;
    for (var f = fret + 1; f <= s.maxFret; f++) {
      var sv = fingerFor(strIdx, f);
      if (sv && (!isGeared(sv) || sv.fret === f)) { next = f; break; }
    }
    if (next < 0) return null;
    return GMB.button('Next fret →', function () {
      expandedFrets[strIdx + ':' + fret] = false;
      expandedFrets[strIdx + ':' + next] = true;
      drawStep();
    }, 'primary');
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
      'One string at a time: tap a fret, then find its two positions with the − / + ' +
      'buttons — the finger lifted off the string, and the finger pressing it. Play ' +
      'the note to check, then move on to the next fret.'));

    body.appendChild(armToolbar());
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

    body.appendChild(GMB.disclosure('frets-bench', 'Group tests…', function () {
      return testBench('Fret test bench', [
        { label: 'Sweep this string', build: function () { return fretSweepSteps(activeStr); } },
        { label: 'Sweep all strings', build: allFretsSteps },
        { label: 'All fingers to rest', build: function () { return allRestSteps(activeStr); } }
      ]);
    }));
  }

  // ---- shared plucking configuration ----------------------------------------

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

  // ---- Step: Strings — the plectrum, and only the extras that exist ---------
  //
  // Progressive disclosure applied to what used to be the densest screen of the
  // interface (UX audit 4): it opened with the wiring, then twenty-three fields
  // covering strokes, travel, settle, mute source, mute hold, descent servo,
  // engagement mode and damper — whether or not the instrument had any of those
  // mechanisms. Now it shows the two plectrum positions, the movement type, and
  // one "+ Add…" button per optional actuator. A mechanism that is not fitted
  // takes exactly one line.

  function stepStrings(body) {
    var p = GMB.state.profile;
    ensurePluckConfig(p);
    ensureBuilder();
    body.appendChild(h('div.note-box',
      'One string at a time: find the plectrum’s resting position against the ' +
      'string and the end of its stroke, then listen. Add a damper or a descent ' +
      'servo only if your instrument has one.'));

    body.appendChild(armToolbar());
    body.appendChild(stringTabs());
    ensureStriker(activeStr);
    var striker = strikerFor(activeStr);
    var sN = ' · string ' + (activeStr + 1);

    // ---- Plectrum ------------------------------------------------------------
    var plectrumAngles = [
      angleStepper(striker, 'restUs', 'Rest position', 'plectrum resting against the string'),
      angleStepper(striker, 'activeUs', 'End of stroke', 'how far it sweeps past the string')
    ];
    if (striker.alternateDirection) {
      plectrumAngles.push(angleStepper(striker, 'activeAltUs', 'End of the return stroke',
        'the other side of rest — strokes alternate'));
    }
    var plectrumKids = [h('div.grid2', plectrumAngles)];
    var plectrumTests = [
      testPulseBtn('Test stroke', striker, 'activeUs', 'Servo → stroke end'),
      striker.alternateDirection
        ? testPulseBtn('Test return stroke', striker, 'activeAltUs', 'Servo → return stroke') : null,
      testServoBtn('→ rest', striker, false),
      playNoteBtn(activeStr, 0, '▶ Play the open string')
    ];
    plectrumKids.push(h('div.row', plectrumTests));

    // Movement type — the per-string form of the designer's "how is the string
    // played?" question, so a single string can differ from the rest.
    var motionBtn = function (label, alt, strum) {
      var on = !!striker.alternateDirection === alt && (striker.function === 'strum') === strum;
      return h('button.chip-radio' + (on ? '.selected' : ''), {
        type: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: function () {
          striker.function = strum ? 'strum' : 'pluck';
          striker.alternateDirection = alt;
          if (alt && !(striker.activeAltUs > 0)) {
            var mirror = 2 * striker.restUs - striker.activeUs;
            striker.activeAltUs = Math.max(striker.pulseMinUs || 500,
              Math.min(striker.pulseMaxUs || 2500, mirror));
          }
          GMB.markDirty();
          drawStep();
        }
      }, label);
    };
    plectrumKids.push(h('div.field', [
      h('span.field-label', 'Movement'),
      h('div.chip-radios', [
        motionBtn('Single stroke', false, false),
        motionBtn('Back and forth', true, false),
        motionBtn('Strum', true, true)
      ])
    ]));
    plectrumKids.push(invertRow(striker, 'plectrum'));
    plectrumKids.push(wiringRow(striker));
    plectrumKids.push(GMB.disclosure('pluck-motion:' + activeStr, 'Movement settings', function () {
      return [
        h('p.muted', 'Recommended values already work. Change them only if the ' +
          'plectrum is too slow, too violent, or misses soft notes.'),
        h('div.grid2', [
          GMB.field('Travel (ms)', GMB.input(striker, 'travelMs', { type: 'number', min: 0, max: 5000 }),
            'time to sweep between two positions'),
          GMB.field('Settle (ms)', GMB.input(striker, 'settleMs', { type: 'number', min: 0, max: 5000 }),
            'pause after a move before the next action')
        ]),
        h('div.grid2', [
          GMB.field('Stroke duration (ms) — all strings', GMB.input(p.pluck, 'strokeMs',
            { type: 'number', min: 0, max: 2000 }),
            'time held at the stroke end before returning — 0 = each servo’s travel time'),
          GMB.field('Minimum strike depth (%) — all strings', GMB.input(p.pluck, 'minStrikePct',
            { type: 'number', min: 0, max: 100 }),
            'soft notes still sweep at least this share of the stroke — 0 = off')
        ])
      ];
    }));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Plectrum' + sN),
        h('span.muted', GMB.noteName(p.strings[activeStr].openNote))]),
      plectrumKids
    ]));

    // ---- Optional actuators: one line each until they exist ------------------
    var lift = perStringServo(activeStr, 'strumLift');
    var damper = perStringServo(activeStr, 'damper');
    var optKids = [];

    if (!damper && !lift) {
      optKids.push(h('p.muted', 'Nothing else is fitted on this string. Add an ' +
        'actuator here if your build has one.'));
    }

    // Damper.
    if (damper) {
      optKids.push(h('div.opt-actuator', [
        h('div.card-head', [h('h4', 'Damper'), h('span.spacer'),
          GMB.button('Remove', function () {
            if (!confirm('Remove the damper on string ' + (activeStr + 1) + '?')) return;
            removeServo(damper); drawStep();
          }, 'danger-ghost')]),
        h('div.grid2', [
          angleStepper(damper, 'restUs', 'Rest position', 'damper clear of the string'),
          angleStepper(damper, 'activeUs', 'Damping position', 'damper pressed on the string')
        ]),
        h('div.row', [testServoBtn('→ rest', damper, false), testServoBtn('Test', damper, true)]),
        invertRow(damper, 'damper'),
        wiringRow(damper),
        GMB.disclosure('damper-adv:' + activeStr, 'Movement settings', function () {
          return h('div.grid2', [
            GMB.field('Travel (ms)', GMB.input(damper, 'travelMs', { type: 'number', min: 0, max: 5000 }),
              'time to reach the string')
          ]);
        })
      ]));
    } else {
      optKids.push(h('div.row', [GMB.button('+ Add a damper', function () {
        addRoleServo('damper', activeStr);
        if (p.pluck.muteSource === 'none' || p.pluck.muteSource === 'auto') p.pluck.muteSource = 'damper';
        drawStep();
      }, 'ghost')]));
    }

    // Descent servo.
    if (lift) {
      var raise = p.pluck.liftEngage === 'raiseToPlay';
      optKids.push(h('div.opt-actuator', [
        h('div.card-head', [h('h4', 'Descent servo'), h('span.spacer'),
          GMB.button('Remove', function () {
            if (!confirm('Remove the descent servo on string ' + (activeStr + 1) + '?')) return;
            removeServo(lift); drawStep();
          }, 'danger-ghost')]),
        h('div.grid2', [
          angleStepper(lift, 'restUs', 'Rest position',
            raise ? 'plectrum ON the string (mutes at rest)' : 'plectrum clear of the string'),
          angleStepper(lift, 'activeUs', 'Playing position',
            raise ? 'plectrum raised to let the string ring' : 'plectrum lowered onto the string')
        ]),
        h('div.row', [testServoBtn('→ rest', lift, false), testServoBtn('Test', lift, true)]),
        invertRow(lift, 'descent servo'),
        wiringRow(lift),
        GMB.disclosure('lift-adv:' + activeStr, 'Movement settings', function () {
          return [
            h('div.grid2', [
              GMB.field('Travel (ms)', GMB.input(lift, 'travelMs', { type: 'number', min: 0, max: 5000 }),
                'time to lower/raise the plectrum'),
              GMB.field('Engage delay (ms)', GMB.input(lift, 'engageDelayMs',
                { type: 'number', min: 0, max: 5000 }), 'extra pause once lowered before the stroke')
            ]),
            GMB.field('Which end plays — all strings', GMB.input(p.pluck, 'liftEngage', {
              type: 'select',
              options: [
                { value: 'lowerToPlay', label: 'Lower to play (rests clear of the string)' },
                { value: 'raiseToPlay', label: 'Raise to play (rests ON the string, muting)' }
              ],
              onChange: drawStep
            }))
          ];
        })
      ]));
    } else {
      optKids.push(h('div.row', [GMB.button('+ Add a descent servo', function () {
        addRoleServo('strumLift', activeStr); drawStep();
      }, 'ghost')]));
    }
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Extras' + sN), h('span.muted', 'optional actuators')]),
      optKids
    ]));

    // ---- How the note stops --------------------------------------------------
    // Chosen once in the designer; here it is a statement of fact, plus the one
    // angle the mechanism needs and the escape hatch to change the policy.
    var stopLabel = {
      none: 'it rings until it decays', plectrum: 'the plectrum leans back on the string',
      damper: 'the damper presses the string', lift: 'the descent servo leans on the string',
      auto: 'automatic (damper if one is fitted)'
    }[p.pluck.muteSource] || String(p.pluck.muteSource);
    var stopKids = [GMB.summaryLine('At Note Off', stopLabel, 'Change…', function () {
      goto('setup', FLOWS.setup.indexOf('builder'));
    })];
    if (p.pluck.muteSource === 'plectrum' || (p.pluck.muteSource === 'auto' && !damper)) {
      if (!((striker.muteUs | 0) > 0)) striker.muteUs = striker.restUs;
      stopKids.push(h('div.grid2', [
        angleStepper(striker, 'muteUs', 'Muting position', 'plectrum leaning on the string')
      ]));
      stopKids.push(h('div.row', [
        testPulseBtn('Test muting', striker, 'muteUs', 'Servo → mute position'),
        testServoBtn('→ rest', striker, false)
      ]));
    }
    stopKids.push(GMB.disclosure('mute-adv', 'Advanced', function () {
      return [
        GMB.field('Mute hold (ms)', GMB.input(p.pluck, 'muteHoldMs',
          { type: 'number', min: 0, max: 5000 }),
          'how long the mute stays on the string after it has physically reached it'),
        GMB.field('Also lean the descent servo on the string at Note Off',
          GMB.input(p.pluck, 'liftMuteOnNoteOff', { type: 'checkbox' }),
          'a descent servo that doubles as a damper')
      ];
    }));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Stopping the note'), h('span.muted', 'all strings')]),
      stopKids
    ]));

    body.appendChild(GMB.disclosure('strings-bench', 'Group tests…', function () {
      return testBench('String test bench', [
        { label: 'Pluck each open string', build: pluckStringsSteps },
        { label: 'Sweep every plectrum', build: pluckServoSweepSteps },
        anyRole('damper') ? { label: 'Sweep every damper',
          build: function () { return roleSweepSteps('damper', 'damp'); } } : null,
        anyRole('strumLift') ? { label: 'Sweep every descent servo',
          build: function () { return roleSweepSteps('strumLift', 'lower'); } } : null
      ]);
    }));
  }

  // ---- Timing & power (NOT a creation step) ---------------------------------
  //
  // Chord synchronisation, the fixed-time FIFO, the fret→strum delay and the
  // servo-start governor all have working defaults the firmware applies on its
  // own. No first instrument should require a decision on any of them (UX audit
  // 5), so this panel lives in ⚙ → Advanced hardware, behind a three-way
  // "Responsiveness" preset that covers what most builders actually want.

  function ensureTimingConfig(p) {
    if (!p.power) p.power = {};
    if (p.power.maxConcurrentMoves === undefined) p.power.maxConcurrentMoves = 3;
    if (p.power.maxConcurrentPerBoard === undefined) p.power.maxConcurrentPerBoard = 0;
    if (p.power.staggerMs === undefined) p.power.staggerMs = 8;
    ensurePluckConfig(p);
  }

  // The three presets, in the language of the result rather than the mechanism.
  var RESPONSIVENESS = {
    fast:     { noteExecutionDelayMs: 0,  fretToPluckMs: 0,  maxConcurrentMoves: 0, staggerMs: 0 },
    balanced: { noteExecutionDelayMs: 0,  fretToPluckMs: 0,  maxConcurrentMoves: 3, staggerMs: 8 },
    limited:  { noteExecutionDelayMs: 40, fretToPluckMs: 10, maxConcurrentMoves: 2, staggerMs: 20 }
  };
  function currentResponsiveness(p) {
    var keys = Object.keys(RESPONSIVENESS);
    for (var i = 0; i < keys.length; i++) {
      var r = RESPONSIVENESS[keys[i]];
      if ((p.midi.noteExecutionDelayMs | 0) === r.noteExecutionDelayMs &&
          (p.pluck.fretToPluckMs | 0) === r.fretToPluckMs &&
          (p.power.maxConcurrentMoves | 0) === r.maxConcurrentMoves &&
          (p.power.staggerMs | 0) === r.staggerMs) return keys[i];
    }
    return 'custom';
  }
  function applyResponsiveness(p, key) {
    var r = RESPONSIVENESS[key];
    if (!r) return;
    p.midi.noteExecutionDelayMs = r.noteExecutionDelayMs;
    p.pluck.fretToPluckMs = r.fretToPluckMs;
    p.power.maxConcurrentMoves = r.maxConcurrentMoves;
    p.power.staggerMs = r.staggerMs;
    GMB.markDirty();
  }
  // A recommendation computed from the rig itself: more servos on one PCA board
  // means more in-rush current to stagger.
  function recommendedGovernor() {
    var byBoard = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source !== 'pca') return;
      var k = (s.i2cBus === 1 ? 1 : 0) + ':' + s.pcaBoard;
      byBoard[k] = (byBoard[k] || 0) + 1;
    });
    var boards = Object.keys(byBoard).length;
    var total = GMB.state.profile.servos.length;
    if (total <= 8) return { moves: 0, note: 'small rig — no limit needed' };
    if (boards <= 2) return { moves: 3, note: total + ' servos on ' + boards + ' board(s)' };
    return { moves: 4, note: total + ' servos on ' + boards + ' boards' };
  }

  function timingPanel(body) {
    var p = GMB.state.profile;
    ensureTimingConfig(p);
    var cur = currentResponsiveness(p);
    var card = function (key, title, desc) {
      return radioCard(cur === key, title, desc, null, function () {
        applyResponsiveness(p, key);
        GMB.redraw();
      });
    };
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Responsiveness'),
        h('span.muted', cur === 'custom' ? 'custom values' : 'preset')]),
      h('p.muted', 'How the instrument trades latency against a calm power supply. ' +
        'The firmware already synchronises the notes of a chord on one strike deadline; ' +
        'this only shapes what happens around it.'),
      h('div.radio-row', [
        card('fast', 'Fast', 'No added delay, every servo free to start at once. ' +
          'Needs a supply that can take the in-rush.'),
        card('balanced', 'Balanced', 'Recommended. At most 3 servos start together, ' +
          '8 ms apart, with no added latency.'),
        card('limited', 'Limited power supply', 'Staggers harder and buys 40 ms of ' +
          'buffer so a weak 5 V rail never browns out.')
      ]),
      cur === 'custom' ? h('div.pill.warn', 'These values do not match any preset — ' +
        'see the exact numbers below.') : null,
      GMB.disclosure('timing-exact', 'Exact values', function () {
        var pw = p.power;
        var recg = recommendedGovernor();
        return [
          h('h3', 'Timing'),
          h('div.grid2', [
            GMB.field('Global action delay (ms)', GMB.input(p.midi, 'noteExecutionDelayMs',
              { type: 'number', min: 0, max: 2000, onChange: GMB.redraw }),
              'fixed-time FIFO buffer — reception → sound latency'),
            GMB.field('Fret → strum delay (ms)', GMB.input(p.pluck, 'fretToPluckMs',
              { type: 'number', min: 0, max: 1000, onChange: GMB.redraw }),
              'wait after the finger is seated before the plectrum strikes'),
            GMB.field('Strum lead (ms)', GMB.input(p.midi, 'strumLeadMs',
              { type: 'number', min: 0, max: 2000 }), 'lower the strum lift early (0 = off)')
          ]),
          h('h3', 'Servo-start governor'),
          h('p.muted', 'A servo peaks its current in the first milliseconds of a move. ' +
            'The governor staggers how many START together so a chord re-fretting many ' +
            'strings does not brown out the 5–6 V rail. Recommended for this ' +
            'instrument: ' + (recg.moves ? recg.moves + ' at once' : 'no limit') +
            ' (' + recg.note + ').'),
          h('div.grid3', [
            GMB.field('Max at once — whole instrument', GMB.input(pw, 'maxConcurrentMoves',
              { type: 'number', min: 0, max: 32, onChange: GMB.redraw }), '0 = no overall cap'),
            GMB.field('Max at once — per PCA board', GMB.input(pw, 'maxConcurrentPerBoard',
              { type: 'number', min: 0, max: 16 }), '0 = no per-board cap'),
            GMB.field('Stagger between starts (ms)', GMB.input(pw, 'staggerMs',
              { type: 'number', min: 0, max: 200, onChange: GMB.redraw }), '0 disables staggering')
          ]),
          h('div.toolbar', [GMB.button('Use the recommended limit', function () {
            pw.maxConcurrentMoves = recg.moves;
            GMB.markDirty(); GMB.redraw();
          }, 'ghost')])
        ];
      })
    ]));
  }

  // ---- Step: Test — one button that exercises the whole instrument ----------

  // The automatic run, in the order a builder would check things by hand:
  // fingers, then plectrums, then every open string, then a few real notes.
  function autoTestSteps() {
    return allFretsSteps()
      .concat(pluckServoSweepSteps())
      .concat(pluckStringsSteps())
      .concat(everythingSteps());
  }
  // A representative fretted note per string: the middle of what is actually
  // equipped. Hard-coding fret 5 asked a maxFret=3 string for a note it cannot
  // play (UX audit 13).
  function midFret(strIdx) {
    var frets = GMB.availableFrets(GMB.state.profile, strIdx);
    if (!frets.length) return 0;
    return frets[Math.floor((frets.length - 1) / 2)];
  }

  function stepTest(body) {
    var p = GMB.state.profile;
    var issues = GMB.validateProfile(p);
    var errors = issues.filter(function (i) { return i.level === 'error'; });

    body.appendChild(h('div.note-box',
      'Arm the mechanics, then let the instrument test itself. Stop halts the ' +
      'sequence immediately, and the big STOP cuts every driver.'));
    body.appendChild(armToolbar());

    var checks = h('div.check-list', [
      h('div.check-item' + (errors.length ? '.bad' : '.good'),
        errors.length ? '✖ ' + errors.length + ' problem(s) to fix before this instrument can run'
                      : '✓ Configuration valid'),
      h('div.check-item.good', '✓ ' + p.servos.length + ' servos generated across ' +
        p.strings.length + ' string(s)')
    ]);

    var runner = testBench('Automatic test', [
      { label: 'Test the instrument automatically', build: autoTestSteps }
    ]);
    runner.classList.add('testbench-primary');

    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Instrument test')]),
      checks,
      runner,
      h('ol.test-plan', [
        h('li', 'every finger, one fret at a time'),
        h('li', 'every plectrum'),
        h('li', 'each open string, through the real note path'),
        h('li', 'a few fretted notes per string')
      ])
    ]));

    body.appendChild(GMB.disclosure('test-individual', 'Individual tests…', function () {
      var rows = p.strings.map(function (s, i) {
        var mf = midFret(i);
        return h('div.row', [
          h('span', 'String ' + (i + 1) + ' (' + GMB.noteName(s.openNote) + ')'),
          GMB.button('Open string', function () {
            GMB.api.testNote({ channel: 0, note: s.openNote, velocity: 100, durationMs: 400 })
              .catch(function () { GMB.toast('Arm the instrument first.', 'warn'); });
          }, 'ghost'),
          mf > 0 ? GMB.button('Fret ' + mf + ' (' + GMB.noteName(s.openNote + mf) + ')', function () {
            GMB.api.testNote({ channel: 0, note: s.openNote + mf, velocity: 100, durationMs: 400 })
              .catch(function () { GMB.toast('Arm the instrument first.', 'warn'); });
          }, 'ghost') : h('span.muted', 'no fretted note available')
        ]);
      });
      return [
        testBench('Group tests', [
          { label: 'Play all open strings', build: pluckStringsSteps },
          { label: 'Sweep all fingers', build: allFretsSteps },
          { label: 'Sweep all plectrums', build: pluckServoSweepSteps },
          { label: 'Scale on string ' + (activeStr + 1), build: function () { return scaleSteps(activeStr); } }
        ]),
        stringTabs(),
        h('div.card.inset', [h('h3', 'Per-string quick play'), rows])
      ];
    }));

    body.appendChild(h('div.row', [GMB.button('STOP (panic)', function () { GMB.doPanic && GMB.doPanic(); }, 'danger')]));
  }

  // ---- Step: Finish — plain-language validation, wiring recap, apply --------

  // Turn a validator issue into something a builder can act on: WHO is affected
  // (string / fret), WHAT is wrong, and — where the software can work it out —
  // a one-click fix. The raw field path stays available under "Technical
  // details" (UX audit 14).
  function humanIssue(is) {
    var p = GMB.state.profile;
    var m = /^servos\[(\d+)\]$/.exec(is.field || '');
    var out = { who: is.field || 'Configuration', what: is.message, fix: null, tech: is.field };
    if (m) {
      var sv = p.servos[Number(m[1])];
      if (sv) {
        out.who = (sv.stringIndex >= 0 ? 'String ' + (sv.stringIndex + 1) : 'Instrument') +
          (sv.function === 'finger' && sv.fret >= 1 ? ' — fret ' + sv.fret : '') +
          (sv.function !== 'finger' ? ' — ' + roleName(sv.function) : '');
        out.tech = is.field + ' (' + sv.function + ', ' +
          (sv.source === 'gpio' ? 'GPIO' + sv.gpio : 'PCA ' + sv.pcaBoard + '/CH' + sv.channel) + ')';
        if (/used twice|channel must be|board must be/.test(is.message)) {
          out.what = 'Two actuators are wired to the same PCA9685 output, or the ' +
            'channel is out of range — this one has no usable output.';
          out.fix = function () { return reassignServo(sv); };
        } else if (/needs a GPIO/.test(is.message)) {
          out.what = 'No pin is assigned to this servo.';
          out.fix = function () { return reassignServo(sv); };
        } else if (/nearly equal/.test(is.message)) {
          out.what = 'The rest and press positions are almost the same — the finger ' +
            'probably will not press the string. Calibrate it on the Frets step.';
        } else if (/geared neutral/.test(is.message)) {
          out.what = 'The geared finger’s neutral position does not sit between its ' +
            'two press positions, so one side never lifts.';
        }
      }
    } else if (/^string (\d+)$/.test(is.field || '')) {
      var si = Number(/^string (\d+)$/.exec(is.field)[1]);
      out.who = 'String ' + (si + 1);
      if (/no plucker/.test(is.message)) {
        out.what = 'Nothing can sound this string — it has no plectrum.';
        out.fix = function () { ensureStriker(si); return true; };
      } else if (/no finger servo/.test(is.message)) {
        out.what = 'No finger servo: this string only plays its open note.';
      }
    } else if (is.field === 'pins') {
      out.who = 'Wiring';
      out.what = 'The I²C signals (SDA, SCL) and the servo enable line have no GPIO yet.';
      out.fix = function () {
        var p2 = GMB.state.profile;
        p2.board = p2.board || {};
        p2.board.automaticPinAssignment = true;
        p2.pins = (p2.pins || []).filter(function (x) { return x.gpio >= 0; });
        var R = rec();
        [['SDA', 'sda'], ['SCL', 'scl'], ['SERVO_OE', 'servoOe']].forEach(function (sig) {
          if (p2.pins.some(function (x) { return x.signal === sig[0]; })) return;
          if (R[sig[0]] == null) return;
          p2.pins.push({ signal: sig[0], kind: sig[1], gpio: R[sig[0]] });
        });
        return true;
      };
    } else if (is.field === 'servos' || is.field === 'power') {
      out.who = 'Instrument';
    }
    return out;
  }
  function roleName(fn) {
    return ({ pluck: 'plectrum', strum: 'strum arm', strumLift: 'descent servo',
      damper: 'damper', aux: 'auxiliary servo', finger: 'finger' })[fn] || fn;
  }
  // Move a servo onto the first genuinely free PCA output (or give a direct
  // servo a free GPIO). Returns false when nothing is available.
  function reassignServo(sv) {
    if (sv.source === 'gpio') {
      var used = usedGpios(sv);
      var reserveUsb = GMB.state.profile.board && GMB.state.profile.board.reserveUsb;
      var pick = boardPins().filter(function (c) {
        return !used[c.gpio] && !c.reserved && c.preference !== 'reserved' &&
               !(c.usb && reserveUsb) && GMB.pinSupports(c, 'servo');
      })[0];
      if (!pick) return false;
      sv.gpio = pick.gpio;
      GMB.markDirty();
      return true;
    }
    var taken = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s === sv || s.source !== 'pca') return;
      taken[(s.i2cBus === 1 ? 1 : 0) + ':' + s.pcaBoard + ':' + s.channel] = true;
    });
    var bus = sv.i2cBus === 1 ? 1 : 0;
    for (var b = 0; b < 8; b++) {
      for (var c = 0; c < 16; c++) {
        if (taken[bus + ':' + b + ':' + c]) continue;
        sv.pcaBoard = b; sv.channel = c;
        GMB.markDirty();
        return true;
      }
    }
    return false;
  }

  // A one-glance recap of the generated harness: which board drives which string.
  function wiringRecap() {
    var p = GMB.state.profile, byBoard = {};
    p.servos.forEach(function (s) {
      if (s.source !== 'pca') return;
      var k = (s.i2cBus === 1 ? 1 : 0) + ':' + s.pcaBoard;
      var e = byBoard[k] || (byBoard[k] = { bus: s.i2cBus === 1 ? 1 : 0, board: s.pcaBoard, strings: {}, n: 0 });
      e.n++;
      if (s.stringIndex >= 0) e.strings[s.stringIndex + 1] = true;
    });
    var direct = p.servos.filter(function (s) { return s.source === 'gpio'; }).length;
    var two = anyBus1();
    var rows = Object.keys(byBoard).sort().map(function (k) {
      var e = byBoard[k];
      var list = Object.keys(e.strings).sort(function (a, b) { return a - b; });
      return h('div.recap-line', [
        h('span.recap-node', 'ESP32'), h('span.recap-arrow', '→'),
        h('span.recap-node', (two ? 'bus ' + e.bus + ' · ' : '') + 'PCA #' + e.board),
        h('span.recap-arrow', '→'),
        h('span', list.length ? ('string' + (list.length > 1 ? 's ' : ' ') + list.join(', ')) : 'shared actuators'),
        h('span.spacer'),
        h('span.muted', e.n + '/16 channels')
      ]);
    });
    if (direct) rows.push(h('div.recap-line', [
      h('span.recap-node', 'ESP32'), h('span.recap-arrow', '→'),
      h('span', direct + ' servo(s) wired straight to a GPIO')
    ]));
    return rows;
  }

  function stepFinish(body) {
    var p = GMB.state.profile;
    var issues = GMB.validateProfile(p);
    var errors = issues.filter(function (i) { return i.level === 'error'; });
    var warns = issues.filter(function (i) { return i.level !== 'error'; });

    // ---- validation, in the user's words ------------------------------------
    var vKids = [];
    if (!issues.length) {
      vKids.push(h('div.big-ok', 'Everything checks out.'));
    } else {
      issues.forEach(function (is) {
        var hi = humanIssue(is);
        var err = is.level === 'error';
        var kids = [
          h('div.issue-head', [
            h('span.issue-mark', err ? '✖' : '⚠'),
            h('strong', hi.who), h('span.spacer'),
            hi.fix ? GMB.button('Fix automatically', function () {
              if (hi.fix() === false) { GMB.toast('No free output left — free one first.', 'error'); return; }
              GMB.toast('Fixed.', 'ok');
              drawStep();
            }, 'ghost.small') : null
          ]),
          h('p.issue-text', hi.what)
        ];
        kids.push(h('details.issue-tech', [h('summary', 'Technical details'),
          h('code', (hi.tech || '') + ' — ' + is.message)]));
        vKids.push(h('div.issue.' + (err ? 'error' : 'warn'), kids));
      });
    }
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Check'),
        h('span.muted', errors.length + ' error(s) · ' + warns.length + ' recommendation(s)')]),
      vKids
    ]));

    // ---- what will be wired --------------------------------------------------
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Wiring'), h('span.spacer'),
        GMB.button('Open the wiring page', function () { GMB.navigate('hardware'); }, 'ghost')]),
      h('div.recap', wiringRecap()),
      errors.length ? h('div.pill.error', 'Conflicts remain — see the check above.')
                    : h('div.pill.ok', 'No conflict')
    ]));

    // ---- apply ---------------------------------------------------------------
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Apply')]),
      h('p.muted', 'The instrument stops, loads the new configuration, parks its ' +
        'servos and re-arms. It takes a few seconds.'),
      h('div.row', [
        GMB.button('Save and apply', function () {
          GMB.saveProfile().then(function () { drawStep(); }).catch(function () {});
        }, 'primary'),
        GMB.button('Discard changes', function () { GMB.discardChanges(); }, 'ghost')
      ]),
      GMB.state.dirty ? null : h('div.commissioning-cta', [
        h('h4', 'Before the first full power-up'),
        h('p.muted', 'Instrument configured ✓ · wiring generated ✓ · calibration done ✓ — ' +
          'the commissioning checklist walks the staged power-up (drivers off, one ' +
          'board at a time, E-stop proven) before the whole rig gets current.'),
        GMB.button('Start the commissioning procedure', function () {
          GMB.navigate('hardware');
          if (GMB.openHardwareSub) GMB.openHardwareSub('commissioning');
        }, 'primary')
      ])
    ]));
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
        // A PCA output is identified by (i2cBus, board, channel): the same
        // board+channel on the OTHER bus is a different physical chip, not a
        // conflict (audit 4 P1.2 — the firmware validator already keys on all 3).
        var k = (s.i2cBus || 0) + ':' + s.pcaBoard + ':' + s.channel;
        if (pcaUsed[k]) out.push({ level: 'error', field: 'servos[' + i + ']', message: 'PCA bus/board/channel ' + k + ' used twice' });
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

  // ---- Welcome: the first thing a brand-new install shows -------------------
  //
  // Landing on a fretboard for an instrument that does not exist yet, and asking
  // the user to find "Setup" on their own, was exactly backwards (UX audit 7).
  // Until a configuration has been applied once, the interface opens here and
  // walks straight into creating one.
  var welcomePick = false;   // true once "Use a template" has been pressed

  function welcomeView(host) {
    var p = GMB.state.profile;
    var kids = [
      h('h1.welcome-title', 'Welcome'),
      h('p.welcome-lead', 'Let’s build your instrument. You describe the machine — ' +
        'how many strings, how the frets are pressed, how the strings are played — ' +
        'and the software works out every servo, board and channel for you.')
    ];
    if (!welcomePick) {
      kids.push(h('div.welcome-actions', [
        GMB.button('Use a template', function () { welcomePick = true; GMB.render(); }, 'primary'),
        GMB.button('Create a custom instrument', function () {
          GMB.markSetupComplete();
          GMB.gotoSetupStep('builder');
        }, 'ghost')
      ]));
    } else {
      kids.push(h('p.muted', 'Pick the instrument closest to what you are building — ' +
        'you can change everything afterwards.'));
      kids.push(h('div.preset-row', ['ukulele', 'guitar', 'bass', 'mandolin', 'banjo'].map(function (t) {
        return h('button.preset-card', { type: 'button', onclick: function () {
          applyPreset(t, true);
          GMB.markSetupComplete();
          GMB.gotoSetupStep('builder');
        } }, [h('strong', cap(t)), h('span.muted', TUNINGS[t].notes.length + ' strings')]);
      })));
      kids.push(h('div.row', [GMB.button('← Back', function () { welcomePick = false; GMB.render(); }, 'ghost')]));
    }
    kids.push(h('p.welcome-skip', [
      'Already have a configured instrument on this device? ',
      h('button.linkbtn', { type: 'button', onclick: function () {
        GMB.markSetupComplete();
        GMB.navigate('fretboard');
      } }, 'Go straight to it')
    ]));
    host.appendChild(h('div.card.welcome-card', kids));
    host.appendChild(h('div.note-box', 'Currently loaded: “' + (p.instrument.name || 'unnamed') +
      '” — ' + p.strings.length + ' string(s). Creating a new instrument replaces it.'));
  }
  GMB.views.welcome = { render: welcomeView };

  // ---- panels the Settings modal hosts (not creation steps) ------------------
  // Advanced hardware: the board, the I²C topology, the PCA capacity and the
  // timing / governor. All of it is generated or defaulted; none of it belongs in
  // the creation flow (UX audit 9, 10, 11).
  GMB.hardwarePanels = {
    board: function (host) {
      var p = GMB.state.profile;
      var boardOpts = (GMB.boardList ? GMB.boardList() : []).map(function (b) {
        return { value: b.id, label: b.name };
      });
      host.appendChild(h('div.card', [
        h('div.card-head', [h('h2', 'Controller board')]),
        h('div.grid2', [
          GMB.field('ESP32 board', GMB.input(p.board, 'profile', {
            type: 'select', options: boardOpts,
            onChange: function () { GMB.markDirty(); GMB.redraw(); } }),
            'the pinout everything wires to'),
          GMB.field('Reserve the native USB pins', GMB.input(p.board, 'reserveUsb', { type: 'checkbox' }),
            'keeps the USB-serial pins free — leave on unless you need them for servos')
        ])
      ]));
    },
    i2c: function (host) {
      ensureBuilder();
      host.appendChild(h('div.card', [
        h('div.card-head', [h('h2', 'PCA9685 boards & I²C'),
          h('span.muted', 'assigned automatically')]),
        h('p.muted', 'The generator spreads the servos over as many PCA9685 boards as ' +
          'the instrument needs and keeps one board per string where it can. Change ' +
          'this only to match boards you have already addressed by hand.'),
        capacityReport(),
        busTopology()
      ]));
    },
    timing: timingPanel
  };

  // The instrument setup page (Instrument -> Frets -> Strings -> Test -> Finish).
  GMB.views.setup = {
    render: function (host) { renderFlow(host, 'setup'); },
    teardown: function () {
      flowHost.setup = null;
      GMB.setRedraw(null);
      if (GMB.midiSettings && GMB.midiSettings.teardown) GMB.midiSettings.teardown();
      if (GMB.testRunner && GMB.testRunner.stop) GMB.testRunner.stop();
    }
  };
  // Jump straight to a named step of the setup page (e.g. from the Instrument
  // view, the welcome screen or a deep link). Retired step ids still resolve.
  GMB.gotoSetupStep = function (stepId) {
    stepId = STEP_ALIASES[stepId] || stepId;
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
