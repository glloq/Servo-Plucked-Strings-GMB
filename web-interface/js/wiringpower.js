/*
 * wiringpower.js — "Power & safety" sub-tab of the Wiring & GPIO page.
 *
 * The live counterpart of hardware/POWER_AND_SAFETY.md: it shows the reference
 * power-distribution + safety circuit AS IT APPLIES to the current profile, and
 * lets the builder DECLARE what is physically fitted (profile.hardware — the
 * HardwareNotes block the firmware stores and round-trips, documentation-only):
 *
 *   • Safety chain card — derived facts (/OE GPIO, hardware E-stop + contact
 *     wiring) next to the declarations (pull-up, gated enable stage, contactor,
 *     fuses), each with its ✓/⚠ status.
 *   • Power tree SVG — PSU → main fuse → master switch → E-stop contactor →
 *     star distribution → one fused branch + bulk cap per PCA9685 (and the
 *     direct-GPIO rail), plus the ESP32 with its /OE safety interface and the
 *     E-stop button's three contacts. Undeclared elements draw DASHED so what
 *     is still missing is visible at a glance.
 *   • Current & supply estimator — from fleet-typical per-servo currents and
 *     the governor caps: per-branch worst case, fuse guide, bulk-cap suggestion
 *     (C ≈ I·Δt/ΔV), PSU requirement, and a wire voltage-drop calculator.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;
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
  function hex2(n) { return '0x' + n.toString(16).toUpperCase(); }

  function estopPin(p) {
    return (p.pins || []).filter(function (x) { return x.signal === 'ESTOP'; })[0] || null;
  }

  // ---- branch model ---------------------------------------------------------
  // One power branch per PCA9685 (bus, address) + one for the direct-GPIO rail.
  function branches(p, m) {
    var out = m.boards.map(function (b) {
      var n = 0;
      (m.byBoard[b.key] || []).forEach(function (l) { n += l.length; });
      return { kind: 'pca', bus: b.bus, board: b.board, servos: n,
        label: 'PCA ' + hex2(0x40 + b.board) + (m.useBus1 ? ' · b' + b.bus : '') };
    });
    if (m.direct.length) out.push({ kind: 'direct', servos: m.direct.length, label: 'Direct rail' });
    return out;
  }

  // Worst-case concurrent starters on a branch, honouring the governor caps
  // (0 = no limit). The global cap bounds the whole instrument, so a single
  // branch can never see more than it either.
  function concurrentOn(p, n) {
    var pw = p.power || {};
    var c = n;
    if (pw.maxConcurrentPerBoard > 0) c = Math.min(c, pw.maxConcurrentPerBoard);
    if (pw.maxConcurrentMoves > 0) c = Math.min(c, pw.maxConcurrentMoves);
    return c;
  }
  function branchWorstA(p, hw, n) {
    var c = concurrentOn(p, n);
    return (c * hw.servoStallMa + (n - c) * hw.servoIdleMa) / 1000;
  }

  // ---- safety chain card ----------------------------------------------------
  function statusRow(ok, sev, text, extra) {
    var cls = ok ? 'ok' : (sev === 'error' ? 'error' : 'warn');
    var mark = ok ? '✓' : (sev === 'error' ? '✖' : '⚠');
    return h('div.ps-row', [h('span.pill.mini.' + cls, mark), h('span', text),
      extra ? h('span.muted', ' — ' + extra) : null]);
  }
  function declRow(hw, key, label, hint) {
    var row = h('label.inline.ps-decl', [
      GMB.input(hw, key, { type: 'checkbox', onChange: function () { GMB.render(); } }),
      h('span', label)]);
    return h('div', [row, hint ? h('div.ps-hint.muted', hint) : null]);
  }

  function safetyCard(p, hw, m) {
    var es = estopPin(p);
    var kids = [h('div.card-head', [h('h2', 'Safety chain'),
      h('span.muted', 'reference circuit: hardware/POWER_AND_SAFETY.md · sheet 02')])];

    // Derived facts (read-only — configured elsewhere).
    if (m.usePca) {
      kids.push(statusRow(m.oe >= 0, 'error',
        m.oe >= 0 ? '/OE command GPIO assigned (SERVO_OE = GPIO' + m.oe + ')'
                  : '/OE command GPIO unassigned — the profile cannot be armed',
        m.oe >= 0 ? null : 'assign it in the GPIO pins sub-tab'));
      if (m.splitOe) kids.push(statusRow(m.oe2 >= 0, 'error',
        m.oe2 >= 0 ? 'Second-bus /OE assigned (SERVO_OE2 = GPIO' + m.oe2 + ')'
                   : 'Second-bus /OE (SERVO_OE2) unassigned'));
    }
    kids.push(statusRow(!!es && es.gpio >= 0, 'warning',
      es ? (es.gpio >= 0 ? 'Hardware E-stop declared (ESTOP = GPIO' + es.gpio + ', ' +
              (p.board.estopNormallyClosed ? 'NC contact — fail-safe' : 'NO contact — legacy') + ')'
            : 'Hardware E-stop declared but its GPIO is unassigned')
         : 'No hardware E-stop declared',
      es && es.gpio >= 0 ? null : 'declare it in the GPIO pins sub-tab (Emergency stop input)'));
    if (es && es.gpio >= 0 && !p.board.estopNormallyClosed)
      kids.push(statusRow(false, 'warning',
        'NO contact wiring: a cut wire silently disables the E-stop input',
        'prefer the normally-closed loop'));

    // Physical declarations — tick as the machine is built.
    kids.push(h('h3', 'Fitted on the machine'));
    if (m.usePca) {
      kids.push(declRow(hw, 'oePullup', '/OE pull-up to 3.3 V fitted (mandatory)',
        'The PCA9685 pulls /OE DOWN internally: a floating /OE bus means outputs ENABLED. ' +
        'The external pull-up keeps every output off with the ESP32 absent, resetting or unplugged.'));
      kids.push(declRow(hw, 'oeGate', 'Gated /OE enable stage fitted (recommended)',
        'Two-transistor non-inverting stage: the E-stop chain’s spare NC contact can then ' +
        'physically forbid enabling, even from a live but buggy ESP32.'));
    }
    kids.push(declRow(hw, 'estopCutsPower', 'E-stop drops the servo-rail contactor (K1)',
      'The only stop that also covers direct-GPIO servos and works with the firmware dead. ' +
      'The button switches the DC-rated contactor’s coil, never the servo current itself.'));
    kids.push(declRow(hw, 'mainFuse', 'Main fuse (F0) on the servo rail'));
    kids.push(declRow(hw, 'branchFuses', 'One fuse per branch (F1…Fn) at the distribution block',
      'A wiring fault then blows one string group instead of the instrument, and the firmware ' +
      'degrades just those strings (readyDegraded).'));

    var missing = [];
    if (m.usePca && !hw.oePullup) missing.push('/OE pull-up');
    if (!hw.estopCutsPower) missing.push('power-cut contactor');
    if (!hw.mainFuse) missing.push('main fuse');
    kids.push(missing.length
      ? h('div.pill.warn', 'Still to fit before stringing the instrument: ' + missing.join(', ') + '.')
      : h('div.pill.ok', 'Safety chain declared complete — verify it with the Commissioning checklist.'));
    return h('div.card', kids);
  }

  // ---- power tree SVG -------------------------------------------------------
  var BR_W = 128, BR_GAP = 16;

  function powerSvg(p, hw, m) {
    var br = branches(p, m);
    var es = estopPin(p);
    var CH_X = 60;                      // power chain spine x
    var chain = [
      { key: 'f0', label: 'F0 main fuse', fitted: hw.mainFuse },
      { key: 's1', label: 'S1 master switch', fitted: true },
      { key: 'k1', label: 'K1 E-stop contactor', fitted: hw.estopCutsPower }
    ];
    var CH_TOP = 86, CH_STEP = 46;
    var distY = CH_TOP + chain.length * CH_STEP + 18;
    var brTop = distY + 34;
    var brX0 = 24;
    var brRight = brX0 + Math.max(1, br.length) * (BR_W + BR_GAP) - BR_GAP;
    // The /OE bus runs BELOW the branch boxes (each board taps down onto it).
    var oeBusY = brTop + 64 + 26;
    // Right zone: E-stop + ESP32 + /OE interface.
    var rzX = Math.max(brRight + 40, 470);
    var W = rzX + 350, HH = oeBusY + 44;

    var root = svg('svg', { class: 'wire-svg', viewBox: '0 0 ' + W + ' ' + HH,
      preserveAspectRatio: 'xMidYMid meet', role: 'group',
      style: 'min-width:' + Math.min(W, 900) + 'px',
      'aria-label': 'Power distribution and safety chain' });

    function box(x, y, w, hh, cls, missing, title, sub) {
      var g = svg('g');
      g.appendChild(svg('rect', { class: cls + (missing ? ' ps-missing' : ''), x: x, y: y, width: w, height: hh, rx: 8 }));
      g.appendChild(svg('text', { class: 'wire-title' + (cls === 'wire-psu' || cls === 'wire-esp' ? ' light' : ''),
        x: x + 10, y: y + 20, text: title }));
      if (sub) g.appendChild(svg('text', { class: 'wire-sub' + (cls === 'wire-psu' || cls === 'wire-esp' ? ' light' : ''),
        x: x + 10, y: y + 36, text: sub }));
      root.appendChild(g);
      return g;
    }
    function line(x1, y1, x2, y2, cls, missing) {
      root.appendChild(svg('line', { class: 'wire-rail ' + cls + (missing ? ' ps-missing' : ''),
        x1: x1, y1: y1, x2: x2, y2: y2 }));
    }
    function label(x, y, text, cls, anchor) {
      root.appendChild(svg('text', { class: cls || 'wire-sub', x: x, y: y,
        'text-anchor': anchor || null, text: text }));
    }

    // PSU and the vertical chain.
    box(24, 12, 168, 54, 'wire-psu', false, 'Servo PSU', '5–6 V · separate');
    line(CH_X, 66, CH_X, distY, 'vplus');
    chain.forEach(function (c, i) {
      var y = CH_TOP + i * CH_STEP;
      root.appendChild(svg('rect', { class: 'ps-chain' + (c.fitted ? '' : ' ps-missing'),
        x: CH_X - 11, y: y - 11, width: 22, height: 22, rx: 5 }));
      label(CH_X + 18, y + 4, c.label + (c.fitted ? '' : ' — not declared'),
        c.fitted ? 'wire-sub' : 'wire-sub ps-warn');
    });

    // Distribution bar + branches.
    line(brX0, distY, Math.max(brRight, CH_X + 30), distY, 'vplus');
    label(Math.max(brRight, CH_X + 30) + 8, distY + 4, 'star distribution · single GND tie');
    br.forEach(function (b, i) {
      var x = brX0 + i * (BR_W + BR_GAP), cx = x + BR_W / 2;
      line(cx, distY, cx, brTop, 'vplus');
      // Branch fuse tick.
      root.appendChild(svg('rect', { class: 'ps-chain' + (hw.branchFuses ? '' : ' ps-missing'),
        x: cx - 8, y: distY + 8, width: 16, height: 14, rx: 4 }));
      var g = box(x, brTop, BR_W, 64, b.kind === 'pca' ? 'wire-board' : 'wire-board direct', false,
        b.label, b.servos + ' servo' + (b.servos > 1 ? 's' : ''));
      g.appendChild(svg('title', null,
        'F' + (i + 1) + (hw.branchFuses ? '' : ' (not declared)') + ' + bulk capacitor, then ' + b.label));
      label(x + 10, brTop + 52, 'F' + (i + 1) + ' · C' + (i + 1),
        hw.branchFuses ? 'wire-sub' : 'wire-sub ps-warn');
    });
    if (!br.length) label(brX0, brTop + 12, 'No servos configured yet — branches appear here.');

    // Right zone: E-stop button, ESP32, /OE interface.
    var esX = rzX, esY = 12;
    box(esX, esY, 220, 50, 'wire-board', !(es && es.gpio >= 0) && !hw.estopCutsPower,
      'E-STOP (NC, latching)', 'twist / pull to release');
    // NC1 → K1 coil (label sits by the E-stop box so it never crosses the chain).
    var k1y = CH_TOP + 2 * CH_STEP;
    line(esX, esY + 25, CH_X + 11, k1y, 'gnd', !hw.estopCutsPower);
    label(esX - 8, esY + 18, 'NC #1 → K1 coil',
      hw.estopCutsPower ? 'wire-sub' : 'wire-sub ps-warn', 'end');

    var espY = 96;
    box(esX, espY, 220, 58, 'wire-esp', false, 'ESP32-S3', 'logic · 3.3 V');
    // NC2 → ESTOP input.
    line(esX + 110, esY + 50, esX + 110, espY, 'oe2', !(es && es.gpio >= 0));
    label(esX + 118, (esY + 50 + espY) / 2 + 3,
      'NC #2 → ESTOP' + (es && es.gpio >= 0 ? ' (GPIO' + es.gpio + ')' : ' — not declared'),
      es && es.gpio >= 0 ? 'wire-sub' : 'wire-sub ps-warn');

    if (m.usePca) {
      var ifY = espY + 88;
      box(esX, ifY, 220, 50, 'wire-board', !hw.oePullup,
        '/OE interface', (hw.oePullup ? 'pull-up 10 kΩ → 3.3 V' : 'pull-up NOT declared') +
          (hw.oeGate ? ' · gated stage' : ''));
      line(esX + 60, espY + 58, esX + 60, ifY, 'oe');
      label(esX + 66, (espY + 58 + ifY) / 2 + 3,
        'SERVO_OE' + (m.oe >= 0 ? ' (GPIO' + m.oe + ')' : ' — unassigned'),
        m.oe >= 0 ? 'wire-sub' : 'wire-sub ps-warn');
      if (hw.oeGate) {
        line(esX + 190, esY + 50, esX + 190, ifY, 'gnd');
        label(esX + 196, (esY + 50 + ifY) / 2, 'NC #3 gates enabling', 'wire-sub');
      }
      // /OE bus below the branch boxes; the interface drops onto it and every
      // PCA branch taps down from its board.
      line(esX + 110, ifY + 50, esX + 110, oeBusY, 'oe', !hw.oePullup);
      line(brX0, oeBusY, esX + 110, oeBusY, 'oe', !hw.oePullup);
      br.forEach(function (b, i) {
        if (b.kind !== 'pca') return;
        var cx = brX0 + i * (BR_W + BR_GAP) + BR_W / 2;
        line(cx, brTop + 64, cx, oeBusY, 'oe', !hw.oePullup);
      });
      label(brX0, oeBusY + 16, '/OE bus → every PCA (LOW = outputs on; the pull-up keeps them OFF by default)',
        hw.oePullup ? 'wire-sub' : 'wire-sub ps-warn');
    }

    return root;
  }

  // ---- current & supply estimator ------------------------------------------
  function fmtA(a) { return (Math.round(a * 100) / 100) + ' A'; }

  function estimatorCard(p, hw, m) {
    var br = branches(p, m);
    var totalServos = br.reduce(function (s, b) { return s + b.servos; }, 0);
    // Local (non-persisted) calculator inputs.
    var calc = estimatorCard.calc || (estimatorCard.calc = { railV: 6, dtMs: 1, dv: 0.3, lenM: 1, mm2: 0.75 });

    var kids = [h('div.card-head', [h('h2', 'Current & supply estimate'),
      h('span.muted', 'from fleet-typical servo currents + the governor caps — confirm at the bench')])];

    kids.push(h('div.grid', [
      GMB.field('Idle current (mA/servo)', GMB.input(hw, 'servoIdleMa',
        { type: 'number', min: 0, max: 5000, coerce: Number, onChange: function () { GMB.render(); } }),
        'PWM held, no motion'),
      GMB.field('Moving current (mA/servo)', GMB.input(hw, 'servoMoveMa',
        { type: 'number', min: 0, max: 10000, coerce: Number, onChange: function () { GMB.render(); } })),
      GMB.field('Stall / peak (mA/servo)', GMB.input(hw, 'servoStallMa',
        { type: 'number', min: 0, max: 20000, coerce: Number, onChange: function () { GMB.render(); } }),
        'datasheet worst case — sizing uses this')
    ]));

    if (br.length) {
      var pw = p.power || {};
      var rows = br.map(function (b, i) {
        var c = concurrentOn(p, b.servos);
        var worst = branchWorstA(p, hw, b.servos);
        var capUf = Math.round((c * hw.servoStallMa / 1000) * (calc.dtMs / 1000) / calc.dv * 1e6);
        return h('tr', [
          h('td', b.label), h('td', String(b.servos)), h('td', '≤ ' + c),
          h('td', fmtA(worst)),
          h('td', 'F' + (i + 1) + ' ≥ ' + fmtA(worst * 1.25)),
          h('td.cap-uf', '≈ ' + capUf.toLocaleString() + ' µF')
        ]);
      });
      kids.push(h('table.cap-table', [
        h('thead', h('tr', [h('th', 'Branch'), h('th', 'Servos'), h('th', 'Start at once'),
          h('th', 'Worst case'), h('th', 'Fuse guide'), h('th', 'Bulk cap (I·Δt/ΔV)')])),
        h('tbody', rows)
      ]));
      var g = totalServos;
      if (pw.maxConcurrentMoves > 0) g = Math.min(g, pw.maxConcurrentMoves);
      var psuWorst = (g * hw.servoStallMa + (totalServos - g) * hw.servoIdleMa) / 1000;
      kids.push(h('p', [h('strong', 'PSU: '),
        'worst case ' + fmtA(psuWorst) + ' (' + g + ' of ' + totalServos +
        ' servos starting together under the governor) → choose ≥ ',
        h('strong', fmtA(psuWorst * 1.3)), ' at ' + calc.railV + ' V. ',
        h('span.muted', 'The governor spreads the peaks but is no substitute for a properly sized supply.')]));
      kids.push(h('p.muted', 'Fuse guide = 1.25 × branch worst case — pick the next standard rating and stay ' +
        'below the branch wiring’s ampacity. Cap suggestion uses Δt/ΔV below; the classic micro-servo ' +
        'table (1000–10000 µF) is only a starting point.'));
    } else {
      kids.push(h('p.muted', 'No servos configured yet — set the instrument up first.'));
    }

    // Assumptions + wire-drop calculator (ephemeral inputs).
    var mkNum = function (obj, key, step) {
      return GMB.input(obj, key, { type: 'number', min: 0.01, step: step || 0.1, coerce: Number,
        onChange: function () { GMB.render(); } });
    };
    var worstBranchA = br.length ? Math.max.apply(null, br.map(function (b) { return branchWorstA(p, hw, b.servos); })) : 0;
    var rOhm = 0.0175 * 2 * calc.lenM / calc.mm2;   // copper, out + return
    var dropV = rOhm * worstBranchA;
    kids.push(h('h3', 'Assumptions & wire drop'));
    kids.push(h('div.grid', [
      GMB.field('Rail voltage (V)', mkNum(calc, 'railV')),
      GMB.field('PSU response Δt (ms)', mkNum(calc, 'dtMs', 0.1),
        'how long the cap ALONE bridges the step before the PSU reacts — stiff bench SMPS ~0.1–0.5 ms, soft supply / long leads 1–5 ms'),
      GMB.field('Allowed sag ΔV (V)', mkNum(calc, 'dv', 0.05)),
      GMB.field('Branch wire length (m)', mkNum(calc, 'lenM'), 'one way — return is counted'),
      GMB.field('Wire section (mm²)', mkNum(calc, 'mm2', 0.05))
    ]));
    if (worstBranchA > 0) {
      var pct = calc.railV > 0 ? dropV / calc.railV * 100 : 0;
      kids.push(h('p', ['Worst branch ' + fmtA(worstBranchA) + ' over ' + calc.lenM + ' m of ' +
        calc.mm2 + ' mm² copper → drop ≈ ', h('strong', (Math.round(dropV * 100) / 100) + ' V (' +
        (Math.round(pct * 10) / 10) + '%)'), pct > 5
          ? h('span.pill.mini.warn', ' > 5% — thicker/shorter wire or a bigger cap')
          : h('span.pill.mini.ok', ' ok (< 5%)')]));
    }
    return h('div.card', kids);
  }

  // ---- view -----------------------------------------------------------------
  function render(host) {
    var p = GMB.state.profile;
    var hw = GMB.ensureHardware(p);
    var m = GMB.wiringModel(p);

    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Power & safety'),
        h('span.muted', 'the reference circuit applied to this instrument')]),
      h('p.muted', 'Distribution and safety chain of hardware/POWER_AND_SAFETY.md, derived from the current ' +
        'configuration. Tick each element as it is physically fitted — undeclared elements draw dashed in the ' +
        'tree. These declarations are saved with the profile and drive no runtime behaviour: the hardware they ' +
        'describe matters precisely when the firmware cannot act.')
    ]));

    host.appendChild(safetyCard(p, hw, m));

    host.appendChild(h('div.card.wire-card', [
      h('div.wire-toolbar', [h('span.muted', 'Power tree — dashed = not declared yet')]),
      h('div.wire-scroll', powerSvg(p, hw, m))
    ]));

    host.appendChild(estimatorCard(p, hw, m));
  }

  GMB.views.wiringPower = { render: render };
})(window);
