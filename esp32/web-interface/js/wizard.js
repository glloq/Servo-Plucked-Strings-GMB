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
  var board = null;    // board GPIO capability map (for direct-GPIO servo filtering)

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
    for (var i = 0; i < list.length; i++)
      if (list[i].function === 'finger' && list[i].stringIndex === strIdx && list[i].fret === fret)
        return list[i];
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
    var sfs = p.stringFretSelection;
    if (sfs && sfs.string) {
      sfs.string.maximum = n;
      sfs.string.mapping = [];
      for (var k = 0; k < n; k++) sfs.string.mapping.push(k);
    }
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

  // Validate before saving so the wizard never reports a false success on an
  // invalid config (the mock backend always "succeeds").
  function finishAndSave() {
    var issues = GMB.validateProfile(GMB.state.profile);
    var errors = issues.filter(function (i) { return i.level === 'error'; });
    if (errors.length) {
      GMB.toast(errors.length + ' problem(s) — fix them on the Validation step.', 'error');
      goto(STEPS.length - 1);
      return;
    }
    GMB.saveProfile();
  }

  function render(host) {
    // Load the board capability map once so the direct-GPIO servo picker can filter
    // to pins that can actually drive a servo (mirrors pins.js).
    if (!board && GMB.api && GMB.api.getBoard) {
      GMB.api.getBoard(GMB.state.profile.board.profile).then(function (b) {
        board = b; GMB.render();
      });
    }
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
          : GMB.button('Finish & save', finishAndSave, 'primary')
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
      var sfs = p.stringFretSelection;
      if (sfs && sfs.string && sfs.fret) {
        sfs.string.maximum = t.notes.length;
        sfs.fret.maximum = t.maxFret;
        sfs.string.mapping = t.notes.map(function (_, i) { return i; });
      }
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

  var ROLE_LABEL = {
    finger: 'Finger', pluck: 'Plucker', strum: 'Strum', strumLift: 'Strum lift',
    damper: 'Damper', sharedDamper: 'Shared damper', aux: 'Auxiliary'
  };
  function isStrikerRole(fn) { return fn === 'pluck' || fn === 'strum' || fn === 'strumLift'; }

  // Find a free (board, channel): prefer the string's own board, else any board.
  function freeSlot(preferBoard) {
    var ch = freeChannel(preferBoard);
    if (ch >= 0) return { board: preferBoard, channel: ch };
    for (var b = 0; b < 8; b++) { var c = freeChannel(b); if (c >= 0) return { board: b, channel: c }; }
    return { board: preferBoard, channel: 0 };
  }
  function addServoRole(role, strIdx) {
    var slot = freeSlot(strIdx < 0 ? 0 : strIdx);
    var opts = { pcaBoard: slot.board, channel: slot.channel };
    if (role === 'pluck' || role === 'strum') { opts.activeUs = 1700; opts.travelMs = 90; opts.settleMs = 20; }
    GMB.state.profile.servos.push(GMB.servoDefaults(role, strIdx, opts));
    GMB.markDirty();
  }
  function servosByRole(strIdx, role) {
    return GMB.state.profile.servos.filter(
      function (s) { return s.stringIndex === strIdx && s.function === role; });
  }

  // Direct-GPIO picker filtered to servo-capable, free pins (mirrors pins.js).
  function gpioSelect(sv) {
    var opts = [{ value: -1, label: '— none —' }];
    var used = {};
    GMB.state.profile.pins.forEach(function (a) { if (a.gpio >= 0) used[a.gpio] = a.signal; });
    GMB.state.profile.servos.forEach(function (s2) {
      if (s2 !== sv && s2.source === 'gpio' && s2.gpio >= 0) used[s2.gpio] = 'another servo';
    });
    if (board && board.pins) {
      board.pins.forEach(function (pin) {
        if (!GMB.pinSupports(pin, 'servo')) return;
        var t = used[pin.gpio];
        opts.push({ value: pin.gpio, label: 'GPIO ' + pin.gpio + (t ? ' (used: ' + t + ')' : '') });
      });
    } else {
      (GMB.RECOMMENDED.SERVO || []).forEach(function (g) { opts.push({ value: g, label: 'GPIO ' + g }); });
    }
    return GMB.input(sv, 'gpio', { type: 'select', options: opts, coerce: Number });
  }

  function servoSourceEditor(sv) {
    var srcSel = GMB.input(sv, 'source', {
      type: 'select', options: [{ value: 'pca', label: 'PCA9685' }, { value: 'gpio', label: 'Direct GPIO' }],
      onChange: drawStep
    });
    var fields = [GMB.field('Source', srcSel)];
    if (sv.source === 'gpio') {
      fields.push(GMB.field('GPIO', gpioSelect(sv), 'free servo-capable pins only'));
    } else {
      fields.push(GMB.field('PCA board', GMB.input(sv, 'pcaBoard', { type: 'number', min: 0, max: 7 })));
      fields.push(GMB.field('Channel', GMB.input(sv, 'channel', { type: 'number', min: 0, max: 15 })));
    }
    return fields;
  }

  // Advanced calibration; for strikers also the stroke-shaping (grattage) fields.
  function servoAdvanced(sv, striker) {
    var out = [h('div.grid3', [
      angleField('Rest angle (°)', sv, 'restUs', 'resting position'),
      GMB.field('Pulse min (µs)', GMB.input(sv, 'pulseMinUs', { type: 'number', min: 200, max: 3000 })),
      GMB.field('Pulse max (µs)', GMB.input(sv, 'pulseMaxUs', { type: 'number', min: 200, max: 3000 })),
      GMB.field('Travel (ms)', GMB.input(sv, 'travelMs', { type: 'number', min: 0, max: 2000 })),
      GMB.field('Settle (ms)', GMB.input(sv, 'settleMs', { type: 'number', min: 0, max: 2000 })),
      GMB.field('Cut PWM at rest', GMB.input(sv, 'disableAtRest', { type: 'checkbox' }))
    ])];
    if (striker) {
      out.push(h('div.grid3', [
        GMB.field('Alternate strokes', GMB.input(sv, 'alternateDirection', { type: 'checkbox' }),
          'rake up/down on successive strikes'),
        GMB.field('Up-stroke pulse (µs)', GMB.input(sv, 'activeAltUs', { type: 'number', min: 0, max: 3000 }),
          '0 = mirror the down-stroke'),
        GMB.field('Stroke time (ms)', GMB.input(sv, 'strokeMs', { type: 'number', min: 0, max: 1000 }),
          'engaged time before return (0 = travel)'),
        GMB.field('Min strike (µs)', GMB.input(sv, 'minStrikeUs', { type: 'number', min: 0, max: 3000 }),
          'floor so soft notes still catch (0 = off)'),
        GMB.field('Engage delay (ms)', GMB.input(sv, 'engageDelayMs', { type: 'number', min: 0, max: 500 }),
          'strum-lift pause before the stroke')
      ]));
    }
    return out;
  }

  // A full editor for one non-finger servo (pluck/strum/strumLift/damper/aux…).
  function actuatorEditor(sv) {
    var striker = isStrikerRole(sv.function);
    var basic = servoSourceEditor(sv).concat([
      angleField(striker ? 'Strike angle (°)' : 'Active angle (°)', sv, 'activeUs',
        striker ? 'how deep it engages the string' : 'engaged position'),
      GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' }))
    ]);
    var rows = [h('div.grid3', basic)];
    if (GMB.isAdvanced()) servoAdvanced(sv, striker).forEach(function (r) { rows.push(r); });
    rows.push(h('div.row', [
      testServoBtn('Test rest', sv, false),
      testServoBtn(striker ? 'Test strike' : 'Test active', sv, true)
    ]));
    return rows;
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
      GMB.api.testServo({ index: idx, active: active }).then(function () {
        GMB.toast('Servo ' + idx + (active ? ' → contact' : ' → rest'), 'ok');
      }).catch(function () { GMB.toast('Servo test refused (arm the instrument first).', 'warn'); });
    }, 'ghost');
  }

  function fingerRow(strIdx, fret) {
    var p = GMB.state.profile;
    var note = GMB.noteName(p.strings[strIdx].openNote + fret);
    var sv = fingerFor(strIdx, fret);
    var head = h('div.fret-head', [
      h('strong', 'Fret ' + fret), h('span.muted', note),
      sv
        ? GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')
        : GMB.button('+ Add servo', function () { addFinger(strIdx, fret); drawStep(); }, 'ghost')
    ]);
    if (!sv) return h('div.fret-row.empty', [head, h('span.muted', 'no finger — this fret is not playable')]);
    var basic = servoSourceEditor(sv).concat([
      angleField('Contact angle (°)', sv, 'activeUs', 'where the finger presses the string'),
      GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' }))
    ]);
    var rows = [head, h('div.grid3', basic)];
    if (GMB.isAdvanced()) servoAdvanced(sv, false).forEach(function (r) { rows.push(r); });
    rows.push(h('div.row', [testServoBtn('Test rest', sv, false), testServoBtn('Test contact', sv, true)]));
    return h('div.fret-row', rows);
  }

  function pcaMap(strIdx) {
    var used = {};
    GMB.state.profile.servos.forEach(function (s) {
      if (s.source === 'pca') used[s.pcaBoard + ':' + s.channel] = s;
    });
    var bd = strIdx;  // show this string's board
    var chips = [];
    for (var c = 0; c < 16; c++) {
      var s = used[bd + ':' + c];
      var cls = s ? (s.function === 'finger' ? 'used' : 'strike') : 'free';
      chips.push(h('span.chan-chip.' + cls, s ? (s.function === 'finger' ? ('f' + s.fret) : s.function.charAt(0)) : c));
    }
    return h('div.chan-map', [h('span.muted', 'PCA board ' + bd + ' channels:'),
      h('div.chan-chips', chips)]);
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

    // Per-string actuators: the striker (pluck OR strum), an optional strum-lift,
    // and an optional damper — all editable, with the grattage stroke-shaping in
    // advanced mode. Every enabled string needs a pluck or strum to sound.
    var actBlocks = [];
    var hasStriker = servosByRole(activeStr, 'pluck').length || servosByRole(activeStr, 'strum').length;
    if (!hasStriker)
      actBlocks.push(h('p.muted', '⚠ This string has no plucker/strum — it cannot sound.'));
    ['pluck', 'strum', 'strumLift', 'damper'].forEach(function (role) {
      servosByRole(activeStr, role).forEach(function (sv) {
        actBlocks.push(h('div.fret-row', [
          h('div.fret-head', [h('strong', ROLE_LABEL[role]),
            h('span.muted', sv.source === 'pca' ? ('PCA ' + sv.pcaBoard + ':' + sv.channel) : ('GPIO ' + sv.gpio)),
            GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')]),
        ].concat(actuatorEditor(sv))));
      });
    });
    var addBtns = [
      GMB.button('+ Plucker', function () { addServoRole('pluck', activeStr); drawStep(); }, 'ghost'),
      GMB.button('+ Strum', function () { addServoRole('strum', activeStr); drawStep(); }, 'ghost'),
      GMB.button('+ Strum lift', function () { addServoRole('strumLift', activeStr); drawStep(); }, 'ghost'),
      GMB.button('+ Damper', function () { addServoRole('damper', activeStr); drawStep(); }, 'ghost')
    ];
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'String actuators (pluck / strum / lift / damper)')]),
      actBlocks.length ? h('div.fret-editor', actBlocks) : h('p.muted', 'None yet.'),
      h('div.row', addBtns)
    ]));

    // Finger servos, one row per fret 1..maxFret.
    var rows = [];
    for (var f = 1; f <= s.maxFret; f++) rows.push(fingerRow(activeStr, f));
    body.appendChild(h('div.card', [
      h('div.card-head', [h('h3', 'Finger servos (one per fret)'),
        GMB.button('Auto-wire all frets', function () { autoWireString(activeStr); drawStep(); }, 'ghost')]),
      h('div.fret-editor', rows)
    ]));

    // Shared actuators (advanced): mechanisms spanning several strings.
    if (GMB.isAdvanced()) {
      var shared = [];
      ['sharedDamper', 'aux'].forEach(function (role) {
        servosByRole(-1, role).forEach(function (sv) {
          shared.push(h('div.fret-row', [
            h('div.fret-head', [h('strong', ROLE_LABEL[role]),
              GMB.button('Remove', function () { removeServo(sv); drawStep(); }, 'ghost')]),
          ].concat(actuatorEditor(sv))));
        });
      });
      body.appendChild(h('div.card', [
        h('h3', 'Shared actuators'),
        shared.length ? h('div.fret-editor', shared) : h('p.muted', 'None.'),
        h('div.row', [
          GMB.button('+ Shared damper', function () { addServoRole('sharedDamper', -1); drawStep(); }, 'ghost'),
          GMB.button('+ Auxiliary', function () { addServoRole('aux', -1); drawStep(); }, 'ghost')
        ])
      ]));
    }
  }

  // ---- Step 4: Install helper (guided per-fret calibration) -----------------

  function stepInstall(body) {
    var p = GMB.state.profile;
    body.appendChild(h('p.muted',
      'Guided setup: for each fret, press its finger, adjust the contact angle until it ' +
      'cleanly frets the string, test the note, then move on. Arm the instrument first ' +
      '(reset from the dashboard) so the servo tests can drive the hardware.'));
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
      var deg = GMB.usToAngle(sv, sv.activeUs);
      var slider = h('input.install-slider', { type: 'range', min: 0, max: 180, value: deg });
      var readout = h('span.install-deg', deg + '°');
      slider.addEventListener('input', function () {
        readout.textContent = slider.value + '°';
        sv.activeUs = GMB.angleToUs(sv, Number(slider.value));
      });
      slider.addEventListener('change', function () {
        GMB.markDirty();
        var idx = servoIndexOf(sv);
        GMB.api.testServo({ index: idx, active: true }).catch(function () {});
      });
      body2.push(h('div.grid2', servoSourceEditor(sv)));
      body2.push(GMB.field('Contact angle', h('div.install-slider-row', [slider, readout])));
      body2.push(GMB.field('Reverse direction', GMB.input(sv, 'inverted', { type: 'checkbox' })));
      body2.push(h('div.row', [
        testServoBtn('Rest', sv, false),
        testServoBtn('Press (contact)', sv, true),
        GMB.button('Play the note', function () {
          GMB.api.testNote({ channel: 0, note: s.openNote + installFret, velocity: 100, durationMs: 400 })
            .then(function () { GMB.toast('Playing ' + note, 'ok'); })
            .catch(function () { GMB.toast('Play refused (arm the instrument first).', 'warn'); });
        }, 'primary'),
        GMB.button('Save & next fret', function () {
          GMB.markDirty();
          if (installFret < s.maxFret) installFret++;
          drawStep();
        }, 'ghost')
      ]));
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
    var blocking = issues.filter(function (i) { return i.level === 'error'; });
    body.appendChild(h('div.row', [GMB.button('Save & publish', function () {
      if (blocking.length) { GMB.toast('Fix the ' + blocking.length + ' error(s) first.', 'error'); return; }
      GMB.saveProfile();
    }, 'primary')]));
  }

  // Client-side pre-check (the firmware ProfileValidator is authoritative).
  GMB.validateProfile = function (p) {
    var out = [];
    var anyPca = false, direct = 0;
    var pcaUsed = {}, fingerKey = {}, gpioUsed = {};
    // Board pins already occupy GPIOs a direct servo must not reuse.
    p.pins.forEach(function (a) { if (a.gpio >= 0) gpioUsed[a.gpio] = a.signal; });
    // Board capability lookup (if the board profile has been loaded).
    var pinCap = {};
    if (board && board.pins) board.pins.forEach(function (pin) { pinCap[pin.gpio] = pin; });
    p.servos.forEach(function (s, i) {
      if (!s.enabled) return;
      var tag = 'servos[' + i + ']';
      if (s.source === 'pca') {
        anyPca = true;
        if (s.pcaBoard > 7) out.push({ level: 'error', field: tag, message: 'PCA board must be 0..7' });
        if (s.channel > 15) out.push({ level: 'error', field: tag, message: 'PCA channel must be 0..15' });
        var k = s.pcaBoard + ':' + s.channel;
        if (pcaUsed[k]) out.push({ level: 'error', field: tag, message: 'PCA ' + k + ' used twice' });
        pcaUsed[k] = true;
      } else {
        direct++;
        if (s.gpio < 0) {
          out.push({ level: 'error', field: tag, message: 'direct servo needs a GPIO' });
        } else {
          if (gpioUsed[s.gpio] !== undefined)
            out.push({ level: 'error', field: tag, message: 'GPIO ' + s.gpio + ' already used by ' + gpioUsed[s.gpio] });
          else if (board && board.pins && (!pinCap[s.gpio] || !GMB.pinSupports(pinCap[s.gpio], 'servo')))
            out.push({ level: 'error', field: tag, message: 'GPIO ' + s.gpio + ' cannot drive a servo on this board' });
          gpioUsed[s.gpio] = 'servo ' + i;
        }
      }
      if (s.function === 'finger') {
        if (s.fret < 1 || s.fret > 24) out.push({ level: 'error', field: tag, message: 'finger fret must be 1..24' });
        else {
          if (s.stringIndex >= 0 && p.strings[s.stringIndex] && s.fret > p.strings[s.stringIndex].maxFret)
            out.push({ level: 'warning', field: tag, message: 'finger fret ' + s.fret + ' exceeds the string maxFret (unreachable)' });
          var fk = s.stringIndex + '/' + s.fret;
          if (fingerKey[fk]) out.push({ level: 'error', field: tag, message: 'string ' + s.stringIndex + ' fret ' + s.fret + ' has two fingers' });
          fingerKey[fk] = true;
        }
      }
    });
    if (direct > 8) out.push({ level: 'error', field: 'servos', message: 'at most 8 direct-GPIO servos (LEDC channels)' });
    var hasPin = function (sig) { return p.pins.some(function (a) { return a.signal === sig && a.gpio >= 0; }); };
    if (anyPca && (!hasPin('SDA') || !hasPin('SCL') || !hasPin('SERVO_OE')))
      out.push({ level: 'error', field: 'pins', message: 'SDA, SCL and SERVO_OE are required for PCA servos' });
    p.strings.forEach(function (s, i) {
      if (!s.enabled) return;
      // Validate the PASSED profile (not the global state): check its own servos.
      var hasStrike = p.servos.some(function (sv) {
        return sv.enabled && (sv.function === 'pluck' || sv.function === 'strum') && sv.stringIndex === i;
      });
      if (!hasStrike) out.push({ level: 'error', field: 'string ' + i, message: 'no plucker/strum servo' });
      if (s.maxFret > 0 && GMB.availableFrets(p, i).length === 0)
        out.push({ level: 'warning', field: 'string ' + i, message: 'no finger servo — only the open string plays' });
    });
    if (p.power && p.power.maxConcurrentMoves < 1)
      out.push({ level: 'error', field: 'power', message: 'at least one servo must be allowed to move' });
    if (p.power && p.power.staggerMs > 2000)
      out.push({ level: 'error', field: 'power', message: 'stagger must be <= 2000 ms' });
    return out;
  };

  GMB.views.wizard = { render: render };
})(window);
