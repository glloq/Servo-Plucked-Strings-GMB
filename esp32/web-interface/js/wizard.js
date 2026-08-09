/*
 * wizard.js — first-configuration assistant for a SERVO-PER-FRET instrument.
 *
 * Steps: Instrument -> Strings & tuning -> Servos & frets -> Install helper ->
 * MIDI -> Power -> Test -> Validation. Each fret position has its own dedicated
 * finger servo; the Servos step and the guided Install helper let you set every
 * finger's contact angle and rotation direction, add a servo on ANY fret position
 * (gaps allowed), and test it live. The Simplified / Advanced toggle hides the
 * fine tuning (pulse window, travel/settle) in simplified mode.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var STEPS = [
    'Instrument', 'Strings', 'Servos & frets', 'Install helper',
    'MIDI', 'Power', 'Test', 'Validation'
  ];
  var step = 0;
  var activeStr = 0;   // per-string steps show one string at a time
  var installFret = 1; // Install helper: current fret being calibrated

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

  // ---- render / nav ---------------------------------------------------------

  function render(host) {
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
    var body = document.getElementById('wizard-body');
    if (!body) return;
    body.innerHTML = '';
    ([stepInstrument, stepStrings, stepServos, stepInstall, stepMidi, stepPower,
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
    GMB.toast('Loaded ' + type + ' defaults (servo-per-fret wiring).', 'ok');
  }

  function stepInstrument(body) {
    var p = GMB.state.profile;
    var typeSel = GMB.input(p.instrument, 'type', {
      type: 'select',
      options: ['ukulele', 'guitar', 'bass', 'mandolin', 'banjo', 'custom'],
      onChange: function (v) { if (v !== 'custom') applyType(v); }
    });
    body.appendChild(h('div.grid2', [
      GMB.field('Instrument name', GMB.input(p.instrument, 'name')),
      GMB.field('Type', typeSel, 'Picking a type loads a tuning + servo-per-fret wiring.'),
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
      'Set each string’s open pitch and its highest fret. The finger servos for ' +
      'the frets are wired in the next step.'));
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
          GMB.button('Auto-wire fingers 1–' + s.maxFret + ' (one PCA for this string)',
            function () { autoWireString(i); GMB.toast('String ' + (i + 1) + ' wired.', 'ok'); }, 'ghost')
        ])
      ]));
    });
  }

  // ---- Step 3: Servos & frets ----------------------------------------------

  function servoSourceEditor(sv) {
    var srcSel = GMB.input(sv, 'source', {
      type: 'select', options: [{ value: 'pca', label: 'PCA9685' }, { value: 'gpio', label: 'Direct GPIO' }],
      onChange: drawStep
    });
    var fields = [GMB.field('Source', srcSel)];
    if (sv.source === 'gpio') {
      fields.push(GMB.field('GPIO', GMB.input(sv, 'gpio', { type: 'number', min: -1, max: 48 })));
    } else {
      fields.push(GMB.field('PCA board', GMB.input(sv, 'pcaBoard', { type: 'number', min: 0, max: 7 })));
      fields.push(GMB.field('Channel', GMB.input(sv, 'channel', { type: 'number', min: 0, max: 15 })));
    }
    return fields;
  }

  // Angle (deg) editor bound to a servo's restUs / activeUs via us<->deg mapping.
  function angleField(label, sv, key, hint) {
    var proxy = { deg: GMB.usToAngle(sv, sv[key]) };
    var inp = GMB.input(proxy, 'deg', {
      type: 'number', min: 0, max: 180,
      onChange: function (v) { sv[key] = GMB.angleToUs(sv, v); GMB.markDirty(); }
    });
    return GMB.field(label, inp, hint);
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

  // A checkbox that toggles gearing on a finger (bound to sv.fretB >= 1).
  function gearedToggle(sv, strIdx) {
    var cb = h('input', { type: 'checkbox' });
    cb.checked = isGeared(sv);
    cb.addEventListener('change', function () { setGeared(sv, cb.checked, strIdx); drawStep(); });
    return GMB.field('Geared (drives a 2nd fret)', cb,
                     'one servo + a gear presses two frets — rest = both fingers up');
  }

  function fingerRow(strIdx, fret) {
    var p = GMB.state.profile;
    var note = GMB.noteName(p.strings[strIdx].openNote + fret);
    var sv = fingerFor(strIdx, fret);

    // Side-B row of a geared servo: the servo is edited on its side-A (owner) row,
    // so here we only show that this fret is covered + a live "test press B" button.
    if (sv && isGeared(sv) && sv.fret !== fret) {
      var headB = h('div.fret-head', [h('strong', 'Fret ' + fret), h('span.muted', note),
        h('span.muted', 'geared side B')]);
      return h('div.fret-row', [headB,
        h('span.muted', 'Driven by the geared servo on fret ' + sv.fret +
          ' (side B). Calibrate its “Press B” angle on that fret’s card.'),
        h('div.row', [testPulseBtn('Test press B', sv, 'activeBUs', 'Servo → press B')])]);
    }

    var head = h('div.fret-head', [
      h('strong', 'Fret ' + fret), h('span.muted', note),
      sv
        ? GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')
        : GMB.button('+ Add servo', function () { addFinger(strIdx, fret); drawStep(); }, 'ghost')
    ]);
    if (!sv) return h('div.fret-row.empty', [head, h('span.muted', 'no finger — this fret is not playable')]);
    var geared = isGeared(sv);
    var basic = servoSourceEditor(sv).concat([
      angleField(geared ? 'Press A angle (°)' : 'Contact angle (°)', sv, 'activeUs',
                 geared ? 'where side A (fret ' + sv.fret + ') presses' : 'where the finger presses the string'),
      GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' }))
    ]);
    var rows = [head, h('div.grid3', basic), h('div.grid3', [gearedToggle(sv, strIdx)])];
    if (geared) {
      rows.push(h('div.grid3', [
        GMB.field('Second fret (side B)', GMB.input(sv, 'fretB',
          { type: 'number', min: 1, max: 24, onChange: drawStep,
            coerce: function (v) { return (v === null || v === '' || v < 1) ? -1 : (v | 0); } }),
          'the other fret this servo presses'),
        angleField('Press B angle (°)', sv, 'activeBUs', 'where side B (fret ' + sv.fretB + ') presses'),
        angleField('Neutral angle (°)', sv, 'restUs', 'both fingers lifted (rest)')
      ]));
    }
    if (GMB.isAdvanced()) {
      rows.push(h('div.grid3', [
        geared ? null : angleField('Rest angle (°)', sv, 'restUs', 'finger lifted off the string'),
        GMB.field('Pulse min (µs)', GMB.input(sv, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Pulse max (µs)', GMB.input(sv, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
        GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 2000 })),
        GMB.field('Cut PWM at rest', GMB.input(sv, 'disableAtRest', { type: 'checkbox' }))
      ].filter(Boolean)));
    }
    var tests = geared
      ? [testPulseBtn('Neutral', sv, 'restUs', 'Servo → neutral'),
         testPulseBtn('Press A', sv, 'activeUs', 'Servo → press A'),
         testPulseBtn('Press B', sv, 'activeBUs', 'Servo → press B')]
      : [testServoBtn('Test rest', sv, false), testServoBtn('Test contact', sv, true)];
    rows.push(h('div.row', tests));
    return h('div.fret-row', rows);
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

  function stepServos(body) {
    var p = GMB.state.profile;
    body.appendChild(h('p.muted',
      'One servo per fret position. Frets need not be consecutive — add a servo only ' +
      'where you have one. Set each finger’s contact angle and rotation direction, and ' +
      'test it live. One PCA9685 per string is the recommended wiring.'));
    body.appendChild(stringTabs());
    var s = p.strings[activeStr];
    body.appendChild(pcaMap(activeStr));

    // Plucker / striker for this string.
    var striker = strikerFor(activeStr);
    var strikerCard;
    if (striker) {
      var sk = servoSourceEditor(striker).concat([
        angleField('Strike angle (°)', striker, 'activeUs', 'how deep the plectrum rakes the string')
      ]);
      strikerCard = h('div.card', [
        h('div.card-head', [h('h3', 'Plucker (' + striker.function + ')'),
          GMB.button('Remove', function () { removeServo(striker); drawStep(); }, 'ghost')]),
        h('div.grid3', sk),
        h('div.row', [testServoBtn('Test rest', striker, false), testServoBtn('Test strike', striker, true)])
      ]);
    } else {
      strikerCard = h('div.card', [h('h3', 'Plucker'),
        h('p.muted', 'This string has no plucker — it cannot sound.'),
        GMB.button('+ Add plucker', function () { ensureStriker(activeStr); drawStep(); }, 'primary')]);
    }
    body.appendChild(strikerCard);

    // Finger servos, one row per fret 1..maxFret.
    var rows = [];
    for (var f = 1; f <= s.maxFret; f++) rows.push(fingerRow(activeStr, f));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Finger servos'),
        GMB.button('Auto-wire all frets', function () { autoWireString(activeStr); drawStep(); }, 'ghost')]),
      h('div.fret-editor', rows)
    ]));
  }

  // ---- Step 4: Install helper (guided per-fret calibration) -----------------

  function stepInstall(body) {
    var p = GMB.state.profile;
    body.appendChild(h('p.muted',
      'Guided setup: for each fret, press its finger, adjust the contact angle until it ' +
      'cleanly frets the string, test the note, then move on. The instrument must be ' +
      'armed for the servo tests to drive the hardware.'));
    body.appendChild(h('div.toolbar', [
      GMB.button('Arm for calibration', function () {
        GMB.api.resetSystem().then(function (res) {
          if (res && res.ok === false) GMB.toast('Arm refused: ' + (res.error || 'E-stop/invalid config') + '.', 'warn');
          else GMB.toast('Armed — servo tests can now drive the hardware.', 'ok');
        }).catch(function (e) { GMB.toast('Arm failed: ' + (e && e.message || e), 'error'); });
      }, 'ghost')
    ]));
    body.appendChild(stringTabs(function () { installFret = 1; }));
    var s = p.strings[activeStr];
    if (installFret > s.maxFret) installFret = s.maxFret;
    if (installFret < 1) installFret = 1;

    var sv = fingerFor(activeStr, installFret);
    var note = GMB.noteName(s.openNote + installFret);
    var body2 = [];
    body2.push(h('div.install-head', [
      GMB.button('← Prev fret', function () { if (installFret > 1) { installFret--; drawStep(); } }, 'ghost'),
      h('div.install-title', [h('strong', 'String ' + (activeStr + 1) + ' · Fret ' + installFret),
        h('span.muted', ' → ' + note)]),
      GMB.button('Next fret →', function () { if (installFret < s.maxFret) { installFret++; drawStep(); } }, 'ghost')
    ]));

    if (!sv) {
      body2.push(h('p.muted', 'No finger servo on this fret yet.'));
      body2.push(GMB.button('+ Add a finger servo here', function () { addFinger(activeStr, installFret); drawStep(); }, 'primary'));
    } else {
      // A geared servo calibrates three positions: neutral (restUs), side-A press
      // (activeUs, fret sv.fret) and side-B press (activeBUs, fret sv.fretB). The
      // slider edits whichever side owns the fret currently shown.
      var geared = isGeared(sv);
      var sideB = geared && installFret === sv.fretB;
      var key = sideB ? 'activeBUs' : 'activeUs';
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
        GMB.api.testServo({ index: idx, active: true, us: sv[key] | 0 }).catch(function () {});
      });
      if (geared)
        body2.push(h('p.muted', 'Geared servo: one actuator presses fret ' + sv.fret +
          ' (side A) and fret ' + sv.fretB + ' (side B); neutral lifts both. Calibrating ' +
          (sideB ? 'side B (fret ' + sv.fretB + ').' : 'side A (fret ' + sv.fret + ').')));
      body2.push(h('div.grid2', servoSourceEditor(sv)));
      body2.push(GMB.field(sideB ? 'Press B angle' : (geared ? 'Press A angle' : 'Contact angle'),
        h('div.install-slider-row', [slider, readout])));
      body2.push(GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' })));
      var actions = geared
        ? [testPulseBtn('Neutral', sv, 'restUs', 'Servo → neutral'),
           testPulseBtn('Press A', sv, 'activeUs', 'Servo → press A'),
           testPulseBtn('Press B', sv, 'activeBUs', 'Servo → press B')]
        : [testServoBtn('Rest', sv, false), testServoBtn('Press (contact)', sv, true)];
      actions.push(GMB.button('Play the note', function () {
        GMB.api.testNote({ channel: 0, note: s.openNote + installFret, velocity: 100, durationMs: 400 })
          .then(function () { GMB.toast('Playing ' + note, 'ok'); })
          .catch(function () { GMB.toast('Play refused (arm the instrument first).', 'warn'); });
      }, 'primary'));
      actions.push(GMB.button('Save & next fret', function () {
        GMB.markDirty();
        if (installFret < s.maxFret) installFret++;
        drawStep();
      }, 'ghost'));
      body2.push(h('div.row', actions));
    }
    body.appendChild(h('div.card', body2));
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

  // ---- Step 7: Test ---------------------------------------------------------

  function stepTest(body) {
    var p = GMB.state.profile;
    body.appendChild(h('p.muted', 'Play a note on each string (arm the instrument first).'));
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
    body.appendChild(h('div.card', rows));
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
      if (s.maxFret > 0 && GMB.availableFrets(p, i).length === 0)
        out.push({ level: 'warning', field: 'string ' + i, message: 'no finger servo — only the open string plays' });
    });
    if (p.power && p.power.maxConcurrentMoves < 1)
      out.push({ level: 'error', field: 'power', message: 'at least one servo must be allowed to move' });
    return out;
  };

  GMB.views.wizard = { render: render };
})(window);
