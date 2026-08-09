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
 * Steps: Instrument -> Strings -> Frets -> Plucking -> MIDI -> Power -> Test ->
 * Validation. Every actuator step carries an Arm control and a "test bench" that
 * drives ONE servo or a whole GROUP (sweep every fret of a string, pluck every
 * string, test everything…) through the shared GMB.testRunner sequencer, with a
 * live status line and a Stop button. The Simplified / Advanced toggle hides the
 * wiring (source, board, channel) and fine timing in simplified mode.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var STEPS = ['Instrument', 'Strings', 'Frets', 'Plucking', 'MIDI', 'Power', 'Test', 'Validation'];
  var step = 0;
  var activeStr = 0;        // per-string steps show one string at a time
  var expandedFrets = {};   // Frets step: which fret rows show their calibration editor
  var calibratedFrets = {}; // Frets step: frets marked calibrated this session

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
    ([stepInstrument, stepStrings, stepFrets, stepPluck, stepMidi, stepPower,
      stepTest, stepValidation][step])(body);
  }

  // ---- Step 1: Instrument ---------------------------------------------------

  function applyType(type) {
    var p = GMB.state.profile;
    var t = TUNINGS[type];
    p.instrument.type = type;
    if (GM_PROGRAM[type]) p.instrument.gmProgram = GM_PROGRAM[type];
    if (TYPE_ID[type]) p.instrument.typeId = TYPE_ID[type];
    p.network.hostname = 'gmb-' + type;
    if (t) {
      p.strings = t.notes.map(function (n) { return { enabled: true, openNote: n, maxFret: t.maxFret }; });
      p.instrument.stringCount = t.notes.length;
      p.stringFretSelection.string.maximum = t.notes.length;
      p.stringFretSelection.fret.maximum = t.maxFret;
      p.stringFretSelection.string.mapping = t.notes.map(function (_, i) { return i; });
      p.servos = [];
      t.notes.forEach(function (_, i) {
        GMB.defaultStringServos(i, t.maxFret).forEach(function (s) { p.servos.push(s); });
      });
    }
    GMB.markDirty(); drawStep();
    GMB.toast('Loaded ' + type + ' defaults (frets + plucker wired per string).', 'ok');
  }

  function stepInstrument(body) {
    var p = GMB.state.profile;
    var typeSel = GMB.input(p.instrument, 'type', {
      type: 'select',
      options: ['ukulele', 'guitar', 'bass', 'mandolin', 'banjo', 'custom'],
      onChange: function (v) { if (v !== 'custom') applyType(v); }
    });
    body.appendChild(h('div.note-box',
      'Pick a type to load a tuning and a full servo wiring in one click — one finger ' +
      'servo per fret plus a plucker per string. You then calibrate the frets and the ' +
      'plucking separately in the next steps.'));
    body.appendChild(h('div.grid2', [
      GMB.field('Instrument name', GMB.input(p.instrument, 'name')),
      GMB.field('Type', typeSel, 'Loads tuning + frets + plucker wiring.'),
      GMB.field('Number of strings', GMB.input(p.instrument, 'stringCount',
        { type: 'number', min: 1, max: 6, onChange: function (v) { setStringCount(v); drawStep(); } })),
      GMB.field('Capo', GMB.input(p.instrument, 'capo', { type: 'number', min: 0, max: 24 })),
      GMB.field('Description', GMB.input(p.instrument, 'description'))
    ]));
    if (GMB.isAdvanced()) {
      body.appendChild(h('div.grid2', [
        GMB.field('GM program', GMB.input(p.instrument, 'gmProgram', { type: 'number', min: 0, max: 127 })),
        GMB.field('GMB type id', GMB.input(p.instrument, 'typeId', { type: 'number', min: 0, max: 127 })),
        GMB.field('Transpose', GMB.input(p.instrument, 'transpose', { type: 'number', min: -48, max: 48 }))
      ]));
    }
    body.appendChild(h('div.card', [
      h('h3', 'Board & network'),
      h('div.grid2', [
        GMB.field('Reserve native USB (GPIO19/20)', GMB.input(p.board, 'reserveUsb', { type: 'checkbox' })),
        GMB.field('Network mode', GMB.input(p.network, 'mode',
          { type: 'select', options: [{ value: 'accessPoint', label: 'Access point' }, { value: 'station', label: 'Wi-Fi client' }] })),
        GMB.field('AP SSID', GMB.input(p.network, 'apSsid')),
        GMB.field('Station SSID', GMB.input(p.network, 'ssid')),
        GMB.field('Hostname', GMB.input(p.network, 'hostname'))
      ])
    ]));
  }

  // ---- Step 2: Strings & tuning --------------------------------------------

  function stepStrings(body) {
    var p = GMB.state.profile;
    body.appendChild(h('p.muted',
      'Set each string’s open pitch and its highest fret. The finger servos (frets) ' +
      'and the plucker (plucking) are configured in the next two steps.'));
    p.strings.forEach(function (s, i) {
      body.appendChild(h('div.card', [
        h('div.card-head', [h('h3', 'String ' + (i + 1)),
          h('span.muted', GMB.noteName(s.openNote) + ' → ' +
            GMB.noteName(s.openNote + s.maxFret))]),
        h('div.grid2', [
          GMB.field('Enabled', GMB.input(s, 'enabled', { type: 'checkbox', onChange: drawStep })),
          GMB.field('Open note (MIDI)', GMB.input(s, 'openNote',
            { type: 'number', min: 0, max: 127, onChange: drawStep })),
          GMB.field('Max fret', GMB.input(s, 'maxFret',
            { type: 'number', min: 0, max: 24, onChange: drawStep }))
        ]),
        h('div.row', [
          GMB.button('Auto-wire fingers 1–' + s.maxFret + ' + plucker (one PCA for this string)',
            function () { autoWireString(i); GMB.toast('String ' + (i + 1) + ' wired.', 'ok'); }, 'ghost')
        ])
      ]));
    });
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

  // ---- Step 3: Frets (frettes) — finger servos only -------------------------

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
      detail.push(h('div.row', [
        testServoBtn('Test rest', sv, false),
        testServoBtn('Test contact', sv, true),
        playNoteBtn(strIdx, fret),
        GMB.button('Mark calibrated ✓', function () { markFretDone(strIdx, sv, fret); drawStep(); }, 'ghost')
      ]));
    }
    if (GMB.isAdvanced()) {
      detail.push(h('div.grid3', servoSourceEditor(sv).concat([
        GMB.field('Pulse min (µs)', GMB.input(sv, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Pulse max (µs)', GMB.input(sv, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Cut PWM at rest', GMB.input(sv, 'disableAtRest', { type: 'checkbox' }))
      ])));
    }
    return h('div.fret-line-wrap', [line, h('div.fret-detail', detail)]);
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

  // ---- Step 4: Plucking (grattage) — plucker + strum lift + damper + aux -----

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

  function stepPluck(body) {
    var p = GMB.state.profile;
    body.appendChild(h('div.note-box',
      'Plucking (grattage): the plectrum / strum servo that sounds the string, plus an ' +
      'optional strum lift (lowers the plucker onto the string for a stroke) and a damper ' +
      '(mutes the string). Calibrate each here and test one string or pluck them all from ' +
      'the test bench.'));

    body.appendChild(armToolbar());
    body.appendChild(testBench('Plucking test bench', [
      { label: 'Pluck each open string', build: pluckStringsSteps },
      { label: 'Sweep pluck servos', build: pluckServoSweepSteps },
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
      var advRows = [];
      if (GMB.isAdvanced()) {
        advRows = servoSourceEditor(striker).concat([
          GMB.field('Pulse min (µs)', GMB.input(striker, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
          GMB.field('Pulse max (µs)', GMB.input(striker, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
          GMB.field('Travel (ms)', GMB.input(striker, 'travelMs', { type: 'number', min: 0, max: 2000 })),
          GMB.field('Settle (ms)', GMB.input(striker, 'settleMs', { type: 'number', min: 0, max: 2000 })),
          GMB.field('Alternate stroke', GMB.input(striker, 'alternateDirection', { type: 'checkbox' }))
        ]);
      }
      body.appendChild(h('div.card', [
        h('div.card-head', [h('h3', 'Plucker · string ' + (activeStr + 1) + ' (' + striker.function + ')'),
          GMB.button('Remove', function () { removeServo(striker); drawStep(); }, 'ghost')]),
        h('div.grid2', sk),
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
    if (lift) opt.push(actuatorBlock('Strum lift', lift,
      { rest: 'raised — plucker off the string', active: 'lowered — plucker engaged' }));
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

  // ---- Step 5: MIDI (compact; full CC editor is the MIDI tab) ---------------

  function stepMidi(body) {
    var p = GMB.state.profile;
    body.appendChild(h('div.grid2', [
      GMB.field('Global MIDI channel', GMB.input(p.midi, 'globalChannel', { type: 'number', min: 0, max: 15 })),
      GMB.field('Omni (all channels)', GMB.input(p.midi, 'omni', { type: 'checkbox' })),
      GMB.field('Sustain pedal', GMB.input(p.midi, 'sustainPedal', { type: 'checkbox' })),
      GMB.field('Velocity curve', GMB.input(p.midi, 'velocityCurve',
        { type: 'select', options: ['linear', 'soft', 'hard', 'exponential', 'custom'] }))
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

  // ---- Step 6: Power / current management -----------------------------------

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
        { type: 'number', min: 0, max: 500 }), 'fixed reception → sound latency'),
      GMB.field('Strum lead (ms)', GMB.input(p.midi, 'strumLeadMs',
        { type: 'number', min: 0, max: 500 }), 'lower the strum lift early (0 = off)')
    ]));
  }

  // ---- Step 7: Test (whole instrument) --------------------------------------

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

  // ---- Step 8: Validation ---------------------------------------------------

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
      }

    });
    if (direct > 8) out.push({ level: 'error', field: 'servos', message: 'at most 8 direct-GPIO servos (LEDC channels)' });
    var hasPin = function (sig) { return p.pins.some(function (a) { return a.signal === sig && a.gpio >= 0; }); };
    if (anyPca && (!hasPin('SDA') || !hasPin('SCL') || !hasPin('SERVO_OE')))
      out.push({ level: 'error', field: 'pins', message: 'SDA, SCL and SERVO_OE are required for PCA servos' });
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
