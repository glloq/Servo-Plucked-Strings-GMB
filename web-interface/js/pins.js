/*
 * pins.js — GPIO pin assignment grid (spec section 11).
 *
 * Colour categories: Green=recommended / Yellow=caution (advanced only) /
 * Red=reserved (never selectable) / Grey=used. Per-signal candidate lists are
 * filtered by capability (STEP needs fast output, HOME needs input+interrupt,
 * SDA/SCL need I2C...). An "Assign automatically" button reproduces the
 * recommended profile; validation reports conflicts with an explanation and a
 * suggested replacement pin.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var board = null;

  function render(host) {
    // Clear first: this view can re-enter itself once the board profile resolves
    // (and is embedded in the Wiring & GPIO page), so the async pass must not
    // stack real cards under the "Loading…" placeholder.
    host.innerHTML = '';
    var p = GMB.state.profile;
    if (!board) {
      GMB.api.getBoard(p.board.profile).then(function (b) { board = b; render(host); });
      host.appendChild(h('div.card', 'Loading board profile…'));
      return;
    }

    // Controls.
    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Pin assignment — ' + board.displayName),
        h('span.muted', GMB.isAdvanced() ? 'Advanced: manual assignment + caution pins' : 'Simplified: recommended pins only')]),
      h('div.form-grid', [
        GMB.field('ESP32 board', boardSelect(host), 'the pin map, diagram and validation adapt to the board')
      ]),
      h('div.toolbar', [
        h('label.inline', [GMB.input(p.board, 'automaticPinAssignment', { type: 'checkbox' }), h('span', 'Automatic pin assignment')]),
        h('label.inline', [GMB.input(p.board, 'reserveUsb', { type: 'checkbox', onChange: function () { validate(); } }),
          h('span', 'Reserve native-USB pins')]),
        h('span.spacer'),
        GMB.button('Assign automatically', autoAssign, 'primary'),
        GMB.button('Validate', validate)
      ])
    ]));

    // Board diagram — the selected ESP32 with its used pins highlighted.
    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Board pinout'),
        h('span.muted', board.layout ? 'physical header layout — used pins highlighted' : 'schematic (pin order by number)')]),
      h('div.esp-scroll', boardDiagram()),
      h('div.esp-legend', [
        legend('recommended', 'Recommended'), legend('caution', 'Caution'),
        legend('reserved', 'Reserved / input-only'), legend('used', 'Used'),
        h('span.legend-item', [h('span.swatch.esp-sw-power'), h('span', 'Power / GND')])
      ])
    ]));

    // Legend + grid.
    host.appendChild(h('div.card', [
      h('h2', 'Board GPIO map'),
      h('div.legend', [
        legend('recommended', 'Recommended'),
        legend('caution', 'Caution (advanced)'),
        legend('reserved', 'Reserved / incompatible'),
        legend('used', 'Used')
      ]),
      h('div#pin-grid.pin-grid')
    ]));

    // Signal assignment list.
    host.appendChild(h('div.card', [
      h('h2', 'Signals'),
      h('p.muted', 'Each signal only offers GPIOs compatible with it. Reserved pins are never listed.'),
      h('div#signal-list.signal-list')
    ]));

    host.appendChild(h('div.card', [h('h2', 'Validation'), h('div#pin-errors', h('div.pill.ok', 'Not checked yet.'))]));

    drawGrid();
    drawSignals();
    validate();
  }

  function legend(cls, label) { return h('span.legend-item', [h('span.swatch.' + cls), h('span', label)]); }

  // Which GPIO each signal currently uses.
  function usedMap(exceptSignal) {
    var m = {};
    GMB.state.profile.pins.forEach(function (a) {
      if (a.signal !== exceptSignal && a.gpio >= 0) m[a.gpio] = a.signal;
    });
    return m;
  }

  function pinCategory(cap, used) {
    if (used[cap.gpio]) return 'used';
    if (cap.reserved || cap.preference === 'reserved') return 'reserved';
    if (cap.usb && GMB.state.profile.board.reserveUsb) return 'reserved';
    return cap.preference; // recommended | caution
  }

  function drawGrid() {
    var grid = document.getElementById('pin-grid');
    grid.innerHTML = '';
    var used = usedMap();
    board.pins.forEach(function (cap) {
      var cat = pinCategory(cap, used);
      var cell = h('div.pin-cell.' + cat, { title: (cap.note || '') + (used[cap.gpio] ? ('  [' + used[cap.gpio] + ']') : '') }, [
        h('span.pin-gpio', 'GPIO' + cap.gpio),
        h('span.pin-tag', used[cap.gpio] ? used[cap.gpio] : catLabel(cap, cat))
      ]);
      grid.appendChild(cell);
    });
  }

  function catLabel(cap, cat) {
    if (cat === 'reserved') { if (cap.usb) return 'USB'; if (cap.strapping) return 'strap'; if (cap.onboardPeripheral) return 'onboard'; return 'reserved'; }
    if (cat === 'caution') return 'caution';
    return 'free';
  }

  // Board signals for a servo-per-fret instrument: just the PCA9685 I2C bus and
  // its /OE safety line. Every finger/plucker is a PCA channel or a direct GPIO
  // configured per servo in the Setup wizard (not a board-level signal here).
  function signalSpecs() {
    var specs = [
      { signal: 'SDA', kind: 'sda', label: 'I2C bus 0 SDA' },
      { signal: 'SCL', kind: 'scl', label: 'I2C bus 0 SCL' }
    ];
    // The second I2C bus signals appear once a PCA board is placed on bus 1 (the
    // config wizard adds SDA2/SCL2 to the profile); they can then be assigned here.
    var pins = GMB.state.profile.pins || [];
    var has = function (sig) { return pins.some(function (x) { return x.signal === sig; }); };
    if (has('SDA2') || has('SCL2')) {
      specs.push({ signal: 'SDA2', kind: 'sda', label: 'I2C bus 1 SDA (SDA2)' });
      specs.push({ signal: 'SCL2', kind: 'scl', label: 'I2C bus 1 SCL (SCL2)' });
    }
    specs.push({ signal: 'SERVO_OE', kind: 'servoOe', label: has('SERVO_OE2') ? 'PCA9685 /OE bus 0 (safety)' : 'PCA9685 /OE (safety)' });
    if (has('SERVO_OE2')) specs.push({ signal: 'SERVO_OE2', kind: 'servoOe', label: 'PCA9685 /OE bus 1 (OE2)' });
    return specs;
  }

  function currentGpio(signal) {
    var a = GMB.state.profile.pins.filter(function (x) { return x.signal === signal; })[0];
    return a ? a.gpio : -1;
  }

  function setGpio(signal, kind, gpio) {
    var pins = GMB.state.profile.pins;
    var a = pins.filter(function (x) { return x.signal === signal; })[0];
    if (!a) { a = { signal: signal, kind: kind, gpio: -1 }; pins.push(a); }
    a.gpio = gpio;
    a.kind = kind;
    GMB.markDirty();
  }

  // Candidate GPIOs for a signal (spec 11.3): compatible, not
  // reserved, not used elsewhere. Caution pins only surface in advanced mode.
  function candidates(kind, signal) {
    var reserveUsb = GMB.state.profile.board.reserveUsb;
    var used = usedMap(signal);
    var wantKind = GMB.SIGNAL_KIND[kind] || 'generic';
    return board.pins.filter(function (cap) {
      if (used[cap.gpio]) return false;
      if (cap.reserved || cap.preference === 'reserved') return false;
      if (cap.usb && reserveUsb) return false;
      if (cap.preference === 'caution' && !GMB.isAdvanced()) return false;
      return GMB.pinSupports(cap, wantKind);
    });
  }

  function drawSignals() {
    var list = document.getElementById('signal-list');
    list.innerHTML = '';
    signalSpecs().forEach(function (spec) {
      var cur = currentGpio(spec.signal);
      var cands = candidates(spec.kind, spec.signal);
      var sel = h('select');
      sel.appendChild(h('option', { value: -1, selected: cur < 0 }, '— unassigned —'));
      // Keep the current pin visible even if it is a caution pin, so advanced
      // choices survive a mode switch.
      var seen = {};
      cands.forEach(function (cap) {
        seen[cap.gpio] = true;
        sel.appendChild(h('option', { value: cap.gpio, selected: cap.gpio === cur },
          'GPIO' + cap.gpio + (cap.preference === 'caution' ? ' (caution)' : '')));
      });
      if (cur >= 0 && !seen[cur]) {
        sel.appendChild(h('option', { value: cur, selected: true }, 'GPIO' + cur + ' (current)'));
      }
      sel.addEventListener('change', function () {
        setGpio(spec.signal, spec.kind, Number(sel.value));
        drawGrid(); drawSignals(); validate();
      });
      list.appendChild(h('div.signal-row', [
        h('span.signal-name', spec.label),
        h('span.signal-kind', spec.kind.toUpperCase()),
        sel
      ]));
    });
  }

  function autoAssign() {
    var p = GMB.state.profile;
    GMB.api.autoPins({
      stringCount: p.instrument.stringCount, useI2cServos: true,
      globalEnable: true, servoSafetyOe: true, reserveUsb: p.board.reserveUsb
    }).then(function (res) {
      if (res.errors && res.errors.length) {
        GMB.toast('Auto-assign could not place every signal.', 'warn');
      } else {
        GMB.toast('Pins assigned automatically.', 'ok');
      }
      p.pins = res.pins;
      GMB.markDirty();
      drawGrid(); drawSignals(); validate();
    });
  }

  // POST /api/pins/validate takes the FULL profile and returns
  // { ok, issues:[{field,message,severity}] }. The firmware answers 422 (with
  // the issues in the body) when there is a blocking error, and 200 otherwise —
  // so issues can arrive via either the resolve or the reject path.
  function validate() {
    var p = GMB.state.profile;
    GMB.api.validatePins(p).then(function (res) {
      renderIssues((res && res.issues) || []);
    }).catch(function (e) {
      var body = e && e.body;
      if (body && body.issues) { renderIssues(body.issues); return; }
      var box = document.getElementById('pin-errors');
      if (box) { box.innerHTML = ''; box.appendChild(h('div.pill.error', 'Validation failed: ' + ((body && body.error) || e.message))); }
    });
  }

  function renderIssues(issues) {
    var box = document.getElementById('pin-errors');
    if (!box) return;
    box.innerHTML = '';
    if (!issues.length) { box.appendChild(h('div.pill.ok', 'All pins valid — no conflicts.')); return; }
    var blocking = issues.filter(function (i) { return i.severity !== 'warning'; });
    if (!blocking.length) box.appendChild(h('div.pill.ok', 'No blocking conflicts (warnings only).'));
    issues.forEach(function (e) {
      var warn = e.severity === 'warning';
      box.appendChild(h('div.err-item', [
        h('div.err-head', [h('strong', e.field || 'issue'),
          h('span.pill.mini.' + (warn ? 'warn' : 'error'), warn ? 'warning' : 'error')]),
        h('div.err-reason', e.message)
      ]));
    });
  }

  // ---- ESP32 board selector -------------------------------------------------
  function boardSelect(host) {
    var p = GMB.state.profile;
    var sel = h('select');
    (GMB.boardList ? GMB.boardList() : []).forEach(function (b) {
      sel.appendChild(h('option', { value: b.id, selected: b.id === p.board.profile }, b.name));
    });
    if (p.board.profile) sel.value = p.board.profile;
    sel.addEventListener('change', function () {
      p.board.profile = sel.value;
      board = null;        // force a re-fetch of the newly chosen board profile
      GMB.markDirty();
      render(host);        // re-render the whole page with the new board
    });
    return sel;
  }

  // ---- graphical pinout -----------------------------------------------------
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, kids) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    });
    (function add(kids) {
      if (kids == null) return;
      if (Array.isArray(kids)) { kids.forEach(add); return; }
      if (kids.nodeType) { el.appendChild(kids); return; }
      el.appendChild(document.createTextNode(String(kids)));
    })(kids);
    return el;
  }

  // GPIO -> short label of what uses it (a board signal, or a direct-GPIO servo).
  function usedGpioMap() {
    var p = GMB.state.profile, m = {};
    (p.pins || []).forEach(function (a) { if (a.gpio >= 0) m[a.gpio] = a.signal; });
    (p.servos || []).forEach(function (s) {
      if (s.source === 'gpio' && s.gpio >= 0 && !m[s.gpio])
        m[s.gpio] = (s.stringIndex >= 0 ? 'S' + (s.stringIndex + 1) + '·' : '') + s.function;
    });
    return m;
  }

  // A board's physical header order, or a schematic two-column fallback (by GPIO#).
  function layoutFor(b) {
    if (b.layout && b.layout.length) return b.layout;
    var gs = b.pins.map(function (p) { return p.gpio; }).sort(function (a, c) { return a - c; });
    var half = Math.ceil(gs.length / 2), out = [];
    gs.forEach(function (g, i) { out.push({ side: i < half ? 'L' : 'R', label: 'IO' + g, gpio: g, power: false }); });
    return out;
  }

  function pinCat(pinDef, cap, used) {
    if (pinDef.power || pinDef.gpio == null) return 'power';
    if (used) return 'used';
    if (!cap) return 'reserved';
    if (cap.reserved || cap.preference === 'reserved' || !cap.output) return 'reserved';
    return cap.preference;   // recommended | caution
  }

  function boardDiagram() {
    var b = board, used = usedGpioMap();
    var capByGpio = {}; b.pins.forEach(function (p) { capByGpio[p.gpio] = p; });
    var layout = layoutFor(b);
    var left = layout.filter(function (x) { return x.side === 'L'; });
    var right = layout.filter(function (x) { return x.side === 'R'; });
    var n = Math.max(left.length, right.length);
    var ROW = 22, BY = 30, BX = 176, BW = 168, PAD = 16;
    var bodyH = PAD + n * ROW + 12;
    var VBW = 512, VBH = BY + bodyH + 34;

    var root = svg('svg', { class: 'esp-svg', viewBox: '0 0 ' + VBW + ' ' + VBH,
      preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': b.displayName + ' pinout' });
    // Antenna hint + module body + USB connector.
    root.appendChild(svg('rect', { class: 'esp-ant', x: BX + BW / 2 - 26, y: 8, width: 52, height: 16, rx: 3 }));
    root.appendChild(svg('rect', { class: 'esp-body', x: BX, y: BY, width: BW, height: bodyH, rx: 10 }));
    root.appendChild(svg('rect', { class: 'esp-usb', x: BX + BW / 2 - 17, y: BY + bodyH - 4, width: 34, height: 13, rx: 2 }));
    root.appendChild(svg('text', { class: 'esp-usb-lbl', x: BX + BW / 2, y: BY + bodyH + 20, 'text-anchor': 'middle', text: 'USB' }));

    function drawPin(pd, side, i) {
      var isL = side === 'L', y = BY + PAD + i * ROW;
      var cap = pd.gpio != null ? capByGpio[pd.gpio] : null;
      var u = pd.gpio != null ? used[pd.gpio] : null;
      var cat = pinCat(pd, cap, u);
      var nubX = isL ? BX - 12 : BX + BW;
      root.appendChild(svg('rect', { class: 'esp-nub ' + cat, x: nubX, y: y - 6, width: 12, height: 12, rx: 2 }));
      root.appendChild(svg('text', { class: 'esp-pinlabel', x: isL ? BX + 7 : BX + BW - 7, y: y + 4,
        'text-anchor': isL ? 'start' : 'end', text: pd.label }));
      if (u) root.appendChild(svg('text', { class: 'esp-use', x: isL ? BX - 18 : BX + BW + 18, y: y + 4,
        'text-anchor': isL ? 'end' : 'start', text: u }));
      var tip = pd.gpio != null ? ('GPIO' + pd.gpio + (u ? ' — ' + u : (cap ? ' — ' + cat : ''))) : pd.label;
      root.appendChild(svg('title', null, tip));
    }
    left.forEach(function (pd, i) { drawPin(pd, 'L', i); });
    right.forEach(function (pd, i) { drawPin(pd, 'R', i); });
    return root;
  }

  GMB.views.pins = { render: render, reset: function () { board = null; } };
})(window);
