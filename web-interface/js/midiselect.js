/*
 * midiselect.js — MIDI page: string/fret selection (string/fret selection spec)
 * plus the general MIDI parameters (spec 18).
 *
 * Contains: the simplified selection panel (section 14) with the GMB preset
 * button (section 3); advanced settings (CC numbers, min/max/offset, numbering,
 * order + custom mapping, timeout); a real-time MIDI monitor (section 15, via
 * midimonitor.js); and the integrated test tool (section 16) that sends
 * CC+CC+NoteOn+NoteOff and shows each step. The GMB identity & capabilities /
 * SysEx tooling lives on its own tab (see sysex.js).
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var monitor = null;

  // Is the MIDI configuration the automatic one? When it is, the panel says so in
  // one line instead of showing five controls the user never has to touch
  // (UX audit 6).
  function isAutomatic(p) {
    var sfs = p.stringFretSelection;
    return !!p.midi.omni && p.midi.velocityCurve === 'linear' &&
           (p.midi.transpose | 0) === 0 && !p.midi.sustainPedal &&
           (!sfs.enabled || (sfs.preset === 'general-midi-boop' && sfs.mode === 'hybrid'));
  }
  function setAutomatic(p) {
    p.midi.omni = true;
    p.midi.globalChannel = 0;
    p.midi.velocityCurve = 'linear';
    p.midi.transpose = 0;
    p.midi.sustainPedal = false;
    applyGmbPreset();
  }

  // MIDI settings. Hosted by the Settings modal's MIDI tab — NOT a creation step:
  // an instrument that answers on every channel with a linear velocity curve and
  // the General-Midi-Boop tablature preset is what almost everyone wants, and the
  // firmware already defaults to it.
  function renderSettings(host) {
    var p = GMB.state.profile;
    var sfs = p.stringFretSelection;
    // Re-render the settings in place (toggles that show/hide dependent fields).
    function redraw() { host.innerHTML = ''; renderSettings(host); }

    var auto = isAutomatic(p);
    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'MIDI'),
        h('span.muted', auto ? 'nothing to configure' : 'custom setup')]),
      auto
        ? h('div.pill.ok', 'Automatic — the instrument listens on every channel, ' +
            'maps notes to strings itself and understands General-Midi-Boop tablature.')
        : h('div.pill.warn', 'Custom MIDI setup — the values below are in force.'),
      auto ? null : h('div.toolbar', [GMB.button('Back to automatic', function () {
        setAutomatic(p); redraw();
      }, 'ghost')])
    ]));

    host.appendChild(GMB.disclosure('midi-params', 'MIDI parameters', function () {
      return h('div.form-grid', [
        // The firmware stores the channel zero-based; the UI never says so — it
        // shows 1–16 like every instrument and every DAW, and subtracts 1 in the
        // data layer (UX audit 6: the label said 1–16 while the input took 0–15).
        GMB.field('MIDI channel', GMB.offsetInput(p.midi, 'globalChannel', 1, { min: 1, max: 16 }),
          'the channel the instrument answers on when Omni is off'),
        GMB.field('Listen on every channel (Omni)', GMB.input(p.midi, 'omni', { type: 'checkbox' })),
        GMB.field('Velocity curve', GMB.input(p.midi, 'velocityCurve', {
          // 'custom' is intentionally omitted: no custom curve table exists yet.
          type: 'select', options: ['linear', 'soft', 'hard', 'exponential'] })),
        GMB.field('Transpose (semitones)', GMB.input(p.midi, 'transpose', { type: 'number', min: -48, max: 48 }),
          'added to the instrument transpose; both are summed'),
        GMB.field('Chord window (ms)', GMB.input(p.midi, 'chordWindowMs', { type: 'number', min: 0, max: 50 })),
        GMB.field('Sustain pedal', GMB.input(p.midi, 'sustainPedal', { type: 'checkbox', onChange: redraw })),
        p.midi.sustainPedal
          ? GMB.field('Sustain CC number', GMB.input(p.midi, 'sustainCc', { type: 'number', min: 0, max: 119 }), 'Default 64 (sustain pedal).')
          : null,
        GMB.field('More notes than strings', GMB.input(p.midi, 'saturationStrategy', {
          type: 'select', options: [
            { value: 'priorityLow', label: 'Keep lowest notes' },
            { value: 'priorityHigh', label: 'Keep highest notes' },
            { value: 'priorityFirst', label: 'Keep first-arriving' },
            { value: 'replaceOldest', label: 'Replace oldest' },
            { value: 'ignoreExtra', label: 'Ignore extra notes' },
            { value: 'monophonic', label: 'Monophonic (one note)' }]
        }), 'what happens when a chord is wider than the instrument')
      ]);
    }, { onToggle: redraw }));

    host.appendChild(GMB.disclosure('midi-selection', 'String / fret selection (tablature over CC)', function () {
      return [
        h('p.muted', 'General-Midi-Boop sends the string and the fret as two CCs ' +
          'alongside the note, so a tablature plays exactly as written instead of ' +
          'letting the controller choose a position.'),
        h('label.inline.big', [GMB.input(sfs, 'enabled', { type: 'checkbox', onChange: redraw }),
          h('span', 'Enable string/fret selection')]),
        h('div.form-grid', [
          GMB.field('System', GMB.input(sfs, 'preset', { type: 'select', options: [
            { value: 'general-midi-boop', label: 'General-Midi-Boop' }, { value: 'custom', label: 'Custom' }] })),
          GMB.field('String CC', GMB.input(sfs.string, 'ccNumber', { type: 'number', min: 0, max: 119 })),
          GMB.field('Fret CC', GMB.input(sfs.fret, 'ccNumber', { type: 'number', min: 0, max: 119 })),
          GMB.field('String numbering', GMB.input(sfs.string, 'numbering', {
            type: 'select', options: [{ value: 'oneBased', label: '1 to N' }, { value: 'zeroBased', label: '0 to N-1' }] })),
          GMB.field('String order', GMB.input(sfs.string, 'reverseOrder', {
            type: 'select', options: [{ value: false, label: 'Normal' }, { value: true, label: 'Reversed' }],
            coerce: function (v) { return v === 'true' || v === true; }, onChange: redraw })),
          GMB.field('When the CC is missing', GMB.input(sfs.validation, 'missingSelectionPolicy', {
            type: 'select', options: [
              { value: 'automaticAllocation', label: 'Choose automatically' },
              { value: 'reject', label: 'Reject' }] }))
        ]),
        h('div.toolbar', [GMB.button('Apply the General-Midi-Boop preset',
          function () { applyGmbPreset(); redraw(); }, 'primary')]),
        h('p.muted', mode_desc(sfs.mode))
      ];
    }, { onToggle: redraw }));

    host.appendChild(GMB.disclosure('midi-selection-adv', 'Selection internals (CC ranges, policies, mapping)',
      function () { return advancedPanel(sfs, p); }, { onToggle: redraw }));
  }

  // Live MIDI monitor + integrated tester. Hosted in Settings > Advanced; owns the
  // /ws/midi socket, so it must be torn down when its host is removed.
  function renderTools(host) {
    if (monitor) { monitor.close(); monitor = null; }
    var p = GMB.state.profile;
    var monHost = h('div.card', [h('div.card-head', [h('h2', 'MIDI monitor'),
      h('span.muted', 'live received events')]), h('div#monitor-host')]);
    host.appendChild(monHost);
    monitor = GMB.midiMonitor.mount(monHost.querySelector('#monitor-host'));
    host.appendChild(testTool(p));
  }

  // Legacy combined page (settings + tools).
  function render(host) { renderSettings(host); renderTools(host); }

  function mode_desc(mode) {
    return {
      automatic: 'Automatic: the controller ignores CCs and allocates strings itself.',
      explicit: 'Explicit: string & fret are forced by the incoming CCs.',
      hybrid: 'Hybrid (recommended): use CCs when valid, fall back to automatic allocation otherwise.'
    }[mode] || '';
  }

  function applyGmbPreset() {
    var p = GMB.state.profile, sfs = p.stringFretSelection;
    sfs.enabled = true;
    sfs.mode = 'hybrid';
    sfs.preset = 'general-midi-boop';
    sfs.perMidiChannel = true;
    sfs.prepareOnCompleteSelection = true;
    sfs.string.ccNumber = 20;
    sfs.string.minimum = 1;
    sfs.string.maximum = p.instrument.stringCount;
    sfs.string.offset = 0;
    sfs.string.numbering = 'oneBased';
    sfs.string.reverseOrder = false;
    sfs.string.mapping = p.strings.map(function (_, i) { return i; });
    sfs.fret.ccNumber = 21;
    sfs.fret.minimum = 0;
    sfs.fret.maximum = Math.max.apply(null, p.strings.map(function (s) { return s.maxFret; }));
    sfs.fret.offset = 0;
    sfs.validation.missingSelectionPolicy = 'automaticAllocation';
    GMB.markDirty();
    GMB.toast('General-Midi-Boop preset applied.', 'ok');
    GMB.render();
  }

  function advancedPanel(sfs, p) {
    var fields = [
      GMB.field('Selection mode', GMB.input(sfs, 'mode', {
        type: 'select', options: [
          { value: 'automatic', label: 'Automatic' }, { value: 'explicit', label: 'Explicit (CC forced)' },
          { value: 'hybrid', label: 'Hybrid' }], onChange: function () { GMB.render(); } })),
      GMB.field('Per-MIDI-channel selection', GMB.input(sfs, 'perMidiChannel', { type: 'checkbox' })),
      GMB.field('Selection timeout (ms, 5–2000)', GMB.input(sfs, 'selectionTimeoutMs', { type: 'number', min: 5, max: 2000 })),
      GMB.field('Prepare finger on complete selection', GMB.input(sfs, 'prepareOnCompleteSelection', { type: 'checkbox' })),
      GMB.field('Queue depth (≥16)', GMB.input(sfs, 'queueDepth', { type: 'number', min: 16, max: 128 }))
    ];
    var stringFields = [
      GMB.field('String CC', GMB.input(sfs.string, 'ccNumber', { type: 'number', min: 0, max: 119 })),
      GMB.field('Min value', GMB.input(sfs.string, 'minimum', { type: 'number', min: 0, max: 127 })),
      GMB.field('Max value', GMB.input(sfs.string, 'maximum', { type: 'number', min: 0, max: 127 })),
      GMB.field('Offset', GMB.input(sfs.string, 'offset', { type: 'number', min: -64, max: 63 }))
    ];
    var fretFields = [
      GMB.field('Fret CC', GMB.input(sfs.fret, 'ccNumber', { type: 'number', min: 0, max: 119 })),
      GMB.field('Min value', GMB.input(sfs.fret, 'minimum', { type: 'number', min: 0, max: 127 })),
      GMB.field('Max value', GMB.input(sfs.fret, 'maximum', { type: 'number', min: 0, max: 127 })),
      GMB.field('Offset', GMB.input(sfs.fret, 'offset', { type: 'number', min: -64, max: 63 })),
      GMB.field('Invalid value policy', GMB.input(sfs.fret, 'invalidValuePolicy', {
        type: 'select', options: [
          { value: 'reject', label: 'Reject' }, { value: 'clamp', label: 'Clamp to range' },
          { value: 'automaticFallback', label: 'Automatic fallback' }, { value: 'lastValid', label: 'Last valid value' }] }))
    ];
    var validationFields = [
      GMB.field('Note/position policy', GMB.input(sfs.validation, 'notePositionPolicy', {
        type: 'select', options: [
          { value: 'ccPriorityWithWarning', label: 'CC priority (warn on mismatch)' },
          { value: 'notePriority', label: 'Note priority (recompute fret)' },
          { value: 'strict', label: 'Strict (reject incoherent)' }] })),
      GMB.field('Missing selection policy', GMB.input(sfs.validation, 'missingSelectionPolicy', {
        type: 'select', options: [
          { value: 'automaticAllocation', label: 'Automatic allocation' }, { value: 'reject', label: 'Reject' }] })),
      GMB.field('Expired selection policy', GMB.input(sfs.validation, 'expiredSelectionPolicy', {
        type: 'select', options: [
          { value: 'automaticAllocation', label: 'Automatic allocation' }, { value: 'reject', label: 'Reject' }] }))
    ];
    var card = h('div.card', [
      h('h2', 'Advanced selection settings'),
      h('p.muted', 'Only needed when your controller does not speak General-Midi-Boop.'),
      h('div.form-grid', fields),
      h('h3', 'String selection'),
      h('div.form-grid', stringFields),
      h('h3', 'Fret selection'),
      h('div.form-grid', fretFields),
      h('h3', 'Validation'),
      h('div.form-grid', validationFields),
      h('h3', 'String order mapping'),
      mappingEditor(sfs, p)
    ]);
    return card;
  }

  // Custom logical-value -> physical-axis mapping (selection spec section 6).
  function mappingEditor(sfs, p) {
    var n = p.instrument.stringCount;
    if (!sfs.string.mapping || sfs.string.mapping.length !== n) {
      sfs.string.mapping = [];
      for (var i = 0; i < n; i++) sfs.string.mapping.push(sfs.string.reverseOrder ? (n - 1 - i) : i);
    }
    var rows = [];
    for (var v = 0; v < n; v++) {
      (function (idx) {
        var ccVal = sfs.string.numbering === 'oneBased' ? (idx + 1) : idx;
        var sel = h('select');
        for (var a = 0; a < n; a++) {
          sel.appendChild(h('option', { value: a, selected: sfs.string.mapping[idx] === a },
            'axis ' + (a + 1) + ' (' + GMB.noteName(p.strings[a].openNote) + ')'));
        }
        sel.addEventListener('change', function () { sfs.string.mapping[idx] = Number(sel.value); GMB.markDirty(); });
        rows.push(h('tr', [h('td', 'CC value ' + ccVal), h('td', '→'), h('td', sel)]));
      })(v);
    }
    return h('div.table-wrap', h('table.mini-table', [
      h('thead', h('tr', [h('th', 'MIDI value'), h('th', ''), h('th', 'Physical axis')])),
      h('tbody', rows)
    ]));
  }

  // ---- Integrated test tool (section 16) ------------------------------------
  var testCfg = { string: 1, fret: 5, note: 64, velocity: 100, channel: 0, durationMs: 400 };

  function testTool(p) {
    testCfg.string = Math.min(testCfg.string, p.instrument.stringCount);
    var log = h('div#test-log.step-log');
    var card = h('div.card#test-tool', [
      h('h2', 'Integrated test tool'),
      h('p.muted', 'Sends CC(string) + CC(fret) + Note On, then Note Off after the chosen duration, and traces each step.'),
      h('div.form-grid', [
        GMB.field('String', GMB.input(testCfg, 'string', { type: 'number', min: 1, max: p.instrument.stringCount })),
        GMB.field('Fret', GMB.input(testCfg, 'fret', { type: 'number', min: 0, max: 30 })),
        GMB.field('MIDI note', GMB.input(testCfg, 'note', { type: 'number', min: 0, max: 127 })),
        GMB.field('Velocity', GMB.input(testCfg, 'velocity', { type: 'number', min: 1, max: 127 })),
        // Displayed 1–16, sent zero-based like the firmware expects.
        GMB.field('MIDI channel', GMB.offsetInput(testCfg, 'channel', 1, { min: 1, max: 16 })),
        GMB.field('Note duration (ms)', GMB.input(testCfg, 'durationMs', { type: 'number', min: 20, max: 5000 }))
      ]),
      h('div.toolbar', [
        GMB.button('Send test', function () { runTest(p, log); }, 'primary'),
        GMB.button('Auto-fill note from string+fret', function () {
          testCfg.note = p.strings[testCfg.string - 1].openNote + testCfg.fret;
          GMB.render(); scrollToTest();
        }, 'ghost')
      ]),
      log
    ]);
    return card;
  }

  function runTest(p, log) {
    log.innerHTML = '';
    var sfs = p.stringFretSelection;
    // The firmware reads only channel/note/velocity/durationMs; the extra
    // string/fret/CC fields feed the offline mock's step trace.
    GMB.api.testNote({
      string: testCfg.string, fret: testCfg.fret,
      stringCc: sfs.string.ccNumber, fretCc: sfs.fret.ccNumber,
      note: testCfg.note, velocity: testCfg.velocity, channel: testCfg.channel, durationMs: testCfg.durationMs
    }).then(function (res) {
      if (res && res.ok === false) {
        log.appendChild(h('div.step-line.error', [h('span.step-dot'), h('strong', 'Rejected'),
          h('span.muted', ' — ' + (res.error || 'instrument not ready'))]));
        GMB.toast('Test note rejected: ' + (res.error || 'not ready'), 'warn');
        return;
      }
      // Real firmware returns { ok:true } with no trace; the mock returns steps.
      var steps = res.steps || [{ step: 'Note sent', detail: 'ch ' + (testCfg.channel + 1) +
        ', note ' + testCfg.note + ', vel ' + testCfg.velocity }];
      steps.forEach(function (s, i) {
        setTimeout(function () {
          log.appendChild(h('div.step-line', [h('span.step-dot'), h('strong', s.step),
            s.detail ? h('span.muted', ' — ' + s.detail) : null]));
        }, i * 120);
      });
      // Emit the corresponding Note Off after the chosen duration (mock stream).
      setTimeout(function () {
        GMB.injectMidi && GMB.api.mock && (function () {
          if (monitor) monitor.push({ channel: testCfg.channel + 1, type: 'noteOff', note: testCfg.note,
            value: 0, interpretation: 'release string ' + testCfg.string, t: Date.now() });
        })();
      }, testCfg.durationMs);
    }).catch(function (e) {
      var msg = (e && e.body && e.body.error) || (e && e.message) || 'error';
      log.appendChild(h('div.step-line.error', [h('span.step-dot'), h('strong', 'Error'),
        h('span.muted', ' — ' + msg)]));
      GMB.toast('Test note failed: ' + msg, 'error');
    });
  }

  function scrollToTest() {
    var el = document.getElementById('test-tool');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }

  GMB.views.midi = {
    render: render,
    teardown: function () { if (monitor) { monitor.close(); monitor = null; } }
  };
  // Split entry points for the Settings modal: settings-only (the config wizard's
  // MIDI step) and the live tools (the Advanced tab).
  GMB.midiSettings = {
    settings: renderSettings,
    tools: renderTools,
    teardown: function () { if (monitor) { monitor.close(); monitor = null; } }
  };
})(window);
