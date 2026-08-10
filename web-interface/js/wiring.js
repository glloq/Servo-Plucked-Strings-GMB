/*
 * wiring.js — graphical wiring map ("Wiring" tab).
 *
 * Draws the electrical harness of the CURRENT instrument as close to the real
 * build as the profile allows, and fully adaptive: everything is derived from
 * GMB.state.profile (the same draft the wizard edits), so the picture updates
 * with every mechanical / pin / servo choice made during instrument creation.
 *
 * What it shows (SPECIFICATION.md §7 / §11 / §22, hardware/wiring/WIRING.md):
 *   • the ESP32-S3 module with its three board-level signals — I²C SDA, SCL and
 *     the PCA9685 /OE safety line — read from profile.pins;
 *   • a separate 5–6 V servo PSU (never the ESP regulator) feeding the servo rail;
 *   • one PCA9685 breakout per distinct pcaBoard actually used, at its real I²C
 *     address (0x40 + index, set by the A0–A2 jumpers), with its 16 channels laid
 *     out and every occupied channel labelled with the servo it drives
 *     (string / fret / plucker / strum / lift / damper / aux);
 *   • the shared I²C bus + /OE + power rails as horizontal buses every board taps;
 *   • any direct-GPIO servos wired straight to an ESP32 output pin.
 *
 * It also flags real wiring faults live: a duplicated board+channel, two servos
 * (or a servo and a board signal) on the same GPIO, an unassigned SDA/SCL/OE
 * while a PCA is in use, and the firmware capacity limits (8 boards, 8 direct
 * servos). Read-only: it drives no hardware, so there is nothing to arm or tear
 * down. A "Download SVG" button saves the diagram to take to the workbench.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---- servo function metadata (colour class + short code + long name) ------
  // fn-* classes map to the --wire-* fill tokens in style.css so both themes work.
  var FN = {
    finger:    { cls: 'fn-finger', name: 'Finger' },
    pluck:     { cls: 'fn-pluck',  name: 'Plucker' },
    strum:     { cls: 'fn-strum',  name: 'Strum' },
    strumLift: { cls: 'fn-lift',   name: 'Strum lift' },
    damper:    { cls: 'fn-damper', name: 'Damper' },
    aux:       { cls: 'fn-aux',    name: 'Auxiliary' }
  };

  // ---- small SVG builder (local, mirrors fretboard.js) ----------------------
  function svg(tag, attrs, kids) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    });
    appendKids(el, kids);
    return el;
  }
  function appendKids(el, kids) {
    if (kids === null || kids === undefined) return;
    if (Array.isArray(kids)) { kids.forEach(function (k) { appendKids(el, k); }); return; }
    if (kids.nodeType) { el.appendChild(kids); return; }
    el.appendChild(document.createTextNode(String(kids)));
  }
  function uniqSorted(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort(function (a, b) { return a - b; });
  }
  function hex2(n) { return '0x' + n.toString(16).toUpperCase(); }

  // ---- profile → wiring model -----------------------------------------------

  function signalGpio(p, name) {
    var a = (p.pins || []).filter(function (x) { return x.signal === name; })[0];
    return a && a.gpio >= 0 ? a.gpio : -1;
  }

  // The lower code inside a channel pad: fret number for a finger (both frets if
  // geared), else a one-letter role tag.
  function padCode(sv) {
    if (sv.function === 'finger') return sv.fretB >= 1 ? (sv.fret + '/' + sv.fretB) : String(sv.fret);
    return { pluck: 'P', strum: 'S', strumLift: 'L', damper: 'D', aux: 'A' }[sv.function] || '?';
  }
  // The upper tag inside a channel pad: which string the servo belongs to, so a
  // PCA9685 shared across several strings stays unambiguous. Global aux = "GLB".
  function stringTag(sv) { return sv.stringIndex >= 0 ? 'S' + (sv.stringIndex + 1) : 'GLB'; }
  // The strings a board hosts (board-level "shared across strings" readout).
  function hostedStrings(m, id) {
    var set = {}, aux = false;
    m.byBoard[id].forEach(function (l) {
      l.forEach(function (s) { if (s.stringIndex >= 0) set[s.stringIndex] = 1; else aux = true; });
    });
    var ks = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    if (!ks.length) return aux ? 'Aux only' : '—';
    return (ks.length > 1 ? 'Str ' : 'String ') + ks.map(function (i) { return i + 1; }).join(', ') + (aux ? ' +aux' : '');
  }
  // A full human label for a servo (channel tooltip, direct-servo row, summary).
  function servoLabel(sv, auxIndex) {
    var s = sv.stringIndex >= 0 ? 'String ' + (sv.stringIndex + 1) : '';
    switch (sv.function) {
      case 'finger': return s + ' · ' + (sv.fretB >= 1 ? 'frets ' + sv.fret + ' + ' + sv.fretB + ' (geared)' : 'fret ' + sv.fret);
      case 'pluck': return s + ' · plucker';
      case 'strum': return s + ' · strum';
      case 'strumLift': return s + ' · strum lift';
      case 'damper': return s + ' · damper';
      case 'aux': return 'Auxiliary #' + (auxIndex + 1);
      default: return s + ' · ' + sv.function;
    }
  }

  // Build the adaptive model the diagram renders from.
  function buildModel(p) {
    var servos = (p.servos || []);
    var pca = servos.filter(function (s) { return s.source === 'pca'; });
    var direct = servos.filter(function (s) { return s.source === 'gpio'; });
    var boardIds = uniqSorted(pca.map(function (s) { return s.pcaBoard | 0; }));

    // Channel occupancy per board: byBoard[id][ch] = [servos…] (dup ⇒ length>1).
    var byBoard = {};
    boardIds.forEach(function (id) { byBoard[id] = []; for (var c = 0; c < 16; c++) byBoard[id][c] = []; });
    pca.forEach(function (s) {
      var c = s.channel | 0;
      if (byBoard[s.pcaBoard] && c >= 0 && c < 16) byBoard[s.pcaBoard][c].push(s);
    });

    // GPIO occupancy: board signals + direct servos. Value = list of labels.
    var byGpio = {};
    var auxSeen = 0;
    function claim(gpio, label) { if (gpio < 0) return; (byGpio[gpio] = byGpio[gpio] || []).push(label); }
    ['SDA', 'SCL', 'SERVO_OE'].forEach(function (sig) { claim(signalGpio(p, sig), sig); });
    // Aux servos need a stable index for their label; number them in profile order.
    var auxOrder = {};
    servos.forEach(function (s) { if (s.function === 'aux') auxOrder[servos.indexOf(s)] = auxSeen++; });
    direct.forEach(function (s) {
      claim(s.gpio, servoLabel(s, auxOrder[servos.indexOf(s)] || 0));
    });

    return {
      servos: servos, pca: pca, direct: direct, boardIds: boardIds,
      byBoard: byBoard, byGpio: byGpio, auxOrder: auxOrder,
      sda: signalGpio(p, 'SDA'), scl: signalGpio(p, 'SCL'), oe: signalGpio(p, 'SERVO_OE'),
      usePca: boardIds.length > 0
    };
  }

  // Collect blocking / advisory wiring issues from the model (adaptive checks).
  function findIssues(p, m) {
    var out = [];
    // Duplicate PCA board+channel.
    m.boardIds.forEach(function (id) {
      m.byBoard[id].forEach(function (list, ch) {
        if (list.length > 1) out.push({ sev: 'error',
          msg: 'PCA ' + hex2(0x40 + id) + ' channel ' + ch + ' is wired to ' + list.length +
            ' servos (' + list.map(function (s) { return servoLabel(s, m.auxOrder[m.servos.indexOf(s)] || 0); }).join(', ') + ').' });
      });
    });
    // Duplicate GPIO (two servos, or a servo and a board signal).
    Object.keys(m.byGpio).forEach(function (g) {
      var who = m.byGpio[g];
      if (who.length > 1) out.push({ sev: 'error',
        msg: 'GPIO' + g + ' is shared by ' + who.join(' and ') + ' — one pin cannot drive two.' });
    });
    // Missing board signals while a PCA is used.
    if (m.usePca) {
      if (m.sda < 0) out.push({ sev: 'error', msg: 'I²C SDA is unassigned but a PCA9685 is in use — assign it on the GPIO Pins tab.' });
      if (m.scl < 0) out.push({ sev: 'error', msg: 'I²C SCL is unassigned but a PCA9685 is in use — assign it on the GPIO Pins tab.' });
      if (m.oe < 0) out.push({ sev: 'warning', msg: 'PCA9685 /OE is unassigned — without the safety line the outputs cannot be force-disabled.' });
    }
    // Firmware capacity limits.
    if (m.boardIds.length > 8) out.push({ sev: 'error', msg: m.boardIds.length + ' PCA9685 boards — the firmware supports at most 8 (0x40–0x47).' });
    if (m.direct.length > 8) out.push({ sev: 'error', msg: m.direct.length + ' direct-GPIO servos — at most 8 (one LEDC channel each).' });
    return out;
  }

  // ---- geometry -------------------------------------------------------------
  var BOARD_W = 172, BOARD_GAP = 26, ROW_X0 = 24;
  var BOARD_TOP = 208, BOARD_H = 240;
  var BUS_TOP = 112, BUS_STEP = 14;           // six horizontal buses stacked here
  // Bus order (top→bottom) and the PCA input pin each represents.
  var BUSES = [
    { key: 'vplus', label: 'V+ 5–6V', cls: 'vplus' },
    { key: 'gnd',   label: 'GND',     cls: 'gnd' },
    { key: 'v3',    label: '3V3',     cls: 'v3' },
    { key: 'sda',   label: 'SDA',     cls: 'sda' },
    { key: 'scl',   label: 'SCL',     cls: 'scl' },
    { key: 'oe',    label: '/OE',     cls: 'oe' }
  ];
  function busY(key) { for (var i = 0; i < BUSES.length; i++) if (BUSES[i].key === key) return BUS_TOP + i * BUS_STEP; return BUS_TOP; }

  // The order the board's six top pins map onto the buses (left→right across the
  // board top): V+, GND, 3V3, SDA, SCL, /OE.
  var PIN_ORDER = ['vplus', 'gnd', 'v3', 'sda', 'scl', 'oe'];

  function junction(cls, x, y) { return svg('circle', { class: 'wire-dot ' + cls, cx: x, cy: y, r: 2.6 }); }

  // ---- diagram construction -------------------------------------------------
  function buildDiagram(p, m) {
    // Row items left→right: a Direct-GPIO group (if any) then one box per board.
    var items = [];
    if (m.direct.length) items.push({ type: 'direct' });
    m.boardIds.forEach(function (id) { items.push({ type: 'board', id: id }); });

    // A right gutter holds the bus labels (SDA·40 …) so they never clip.
    var LABEL_GUTTER = 74;
    var rowCore = items.length ? ROW_X0 + items.length * (BOARD_W + BOARD_GAP) - BOARD_GAP + ROW_X0 : 340;
    var VB_W = Math.max(rowCore, 340) + LABEL_GUTTER;
    var VB_H = BOARD_TOP + BOARD_H + 30;
    var busRight = VB_W - LABEL_GUTTER + 4;

    var root = svg('svg', {
      class: 'wire-svg', viewBox: '0 0 ' + VB_W + ' ' + VB_H,
      preserveAspectRatio: 'xMidYMid meet', role: 'group',
      'aria-label': 'Wiring map of the ESP32 and PCA9685 boards'
    });

    // Horizontal buses spanning the whole width (drawn first, under everything).
    BUSES.forEach(function (b) {
      // Skip the I²C/OE/logic buses entirely when no PCA is used (direct-only rig).
      if (!m.usePca && (b.key === 'sda' || b.key === 'scl' || b.key === 'oe' || b.key === 'v3')) return;
      var y = busY(b.key);
      root.appendChild(svg('line', { class: 'wire-rail ' + b.cls, x1: 18, y1: y, x2: busRight, y2: y }));
      // The signal buses carry their GPIO on the label; a missing one is flagged.
      var lab = b.label, miss = false;
      if (b.key === 'sda') { lab = 'SDA·' + (m.sda >= 0 ? m.sda : '—'); miss = m.sda < 0; }
      else if (b.key === 'scl') { lab = 'SCL·' + (m.scl >= 0 ? m.scl : '—'); miss = m.scl < 0; }
      else if (b.key === 'oe') { lab = '/OE·' + (m.oe >= 0 ? m.oe : '—'); miss = m.oe < 0; }
      root.appendChild(svg('text', { class: 'wire-raillabel' + (miss ? ' missing' : ''), x: busRight + 8, y: y + 3, 'text-anchor': 'start', text: lab }));
    });

    root.appendChild(buildEsp(p, m));
    root.appendChild(buildPsu(m));

    items.forEach(function (it, i) {
      var x = ROW_X0 + i * (BOARD_W + BOARD_GAP);
      if (it.type === 'direct') root.appendChild(buildDirectBox(p, m, x));
      else root.appendChild(buildBoard(p, m, it.id, x));
    });

    return root;
  }

  // ESP32-S3 module (top-left), dropping its three signal pins onto the buses.
  function buildEsp(p, m) {
    var g = svg('g', { class: 'wire-mod' });
    var x = 24, y = 14, w = 150, hh = 82;
    g.appendChild(svg('rect', { class: 'wire-esp', x: x, y: y, width: w, height: hh, rx: 9 }));
    g.appendChild(svg('text', { class: 'wire-title light', x: x + 12, y: y + 22, text: 'ESP32-S3' }));
    g.appendChild(svg('text', { class: 'wire-sub light', x: x + 12, y: y + 38, text: 'DevKitC-1 · 3.3 V logic' }));

    // ESP pins that drop onto buses. The GND tie (common ground) is always drawn;
    // the logic 3V3 and the I²C / OE signals only when a PCA9685 is present.
    var all = [ { key: 'gnd', label: 'GND' } ];
    if (m.usePca) all = [
      { key: 'v3', label: '3V3' }, { key: 'gnd', label: 'GND' },
      { key: 'sda', label: 'SDA', gpio: m.sda },
      { key: 'scl', label: 'SCL', gpio: m.scl },
      { key: 'oe',  label: '/OE', gpio: m.oe }
    ];
    var slot = w / (all.length + 1);
    all.forEach(function (pin, i) {
      var px = x + slot * (i + 1);
      var by = busY(pin.key);
      var missing = pin.gpio !== undefined && pin.gpio < 0 && m.usePca;
      g.appendChild(svg('line', { class: 'wire-lead ' + pin.key + (missing ? ' missing' : ''), x1: px, y1: y + hh, x2: px, y2: by }));
      g.appendChild(junction(pin.key, px, by));
      // Name only — the GPIO number lives on the bus label to keep the pins legible.
      g.appendChild(svg('text', { class: 'wire-pinlabel light' + (missing ? ' missing' : ''), x: px, y: y + hh - 5, 'text-anchor': 'middle', text: pin.label }));
    });
    return g;
  }

  // Separate 5–6 V servo supply feeding the V+ and GND buses.
  function buildPsu(m) {
    var g = svg('g', { class: 'wire-mod' });
    var x = 190, y = 14, w = 132, hh = 60;
    g.appendChild(svg('rect', { class: 'wire-psu', x: x, y: y, width: w, height: hh, rx: 9 }));
    g.appendChild(svg('text', { class: 'wire-title light', x: x + 12, y: y + 22, text: 'Servo PSU' }));
    g.appendChild(svg('text', { class: 'wire-sub light', x: x + 12, y: y + 38, text: '5–6 V · separate' }));
    [ { key: 'vplus', label: 'V+' }, { key: 'gnd', label: 'GND' } ].forEach(function (pin, i) {
      var px = x + w * (i ? 0.7 : 0.3);
      var by = busY(pin.key);
      g.appendChild(svg('line', { class: 'wire-lead ' + pin.key, x1: px, y1: y + hh, x2: px, y2: by }));
      g.appendChild(junction(pin.key, px, by));
      g.appendChild(svg('text', { class: 'wire-pinlabel light', x: px, y: y + hh - 5, 'text-anchor': 'middle', text: pin.label }));
    });
    return g;
  }

  // One PCA9685 breakout: taps the six buses at its top edge, lays out 16 channels.
  function buildBoard(p, m, id, x) {
    var g = svg('g', { class: 'wire-mod' });
    var used = 0;
    m.byBoard[id].forEach(function (l) { if (l.length) used++; });

    // Top-edge input pins (six), each a short drop up to its bus with a junction.
    var pinSlot = BOARD_W / (PIN_ORDER.length + 1);
    PIN_ORDER.forEach(function (key, i) {
      var px = x + pinSlot * (i + 1);
      var by = busY(key);
      g.appendChild(svg('line', { class: 'wire-lead ' + key, x1: px, y1: BOARD_TOP, x2: px, y2: by }));
      g.appendChild(junction(key, px, by));
    });

    g.appendChild(svg('rect', { class: 'wire-board', x: x, y: BOARD_TOP, width: BOARD_W, height: BOARD_H, rx: 9 }));
    g.appendChild(svg('text', { class: 'wire-title', x: x + 12, y: BOARD_TOP + 22, text: 'PCA9685 #' + id }));
    g.appendChild(svg('text', { class: 'wire-sub', x: x + BOARD_W - 12, y: BOARD_TOP + 22, 'text-anchor': 'end', text: 'I²C ' + hex2(0x40 + id) }));
    // Which string(s) this board serves (a board may be shared across strings).
    g.appendChild(svg('text', { class: 'wire-sub host', x: x + 12, y: BOARD_TOP + 39, text: hostedStrings(m, id) }));
    g.appendChild(svg('text', { class: 'wire-sub', x: x + BOARD_W - 12, y: BOARD_TOP + 39, 'text-anchor': 'end', text: used + '/16' }));

    // 16 channels as a 4×4 grid; each pad shows its channel/pin, string and fret.
    var gx0 = x + 12, gy0 = BOARD_TOP + 52;
    var pw = 34, ph = 34, gapx = 4, gapy = 12;
    for (var ch = 0; ch < 16; ch++) {
      var c = ch % 4, r = (ch / 4) | 0;
      var px = gx0 + c * (pw + gapx), py = gy0 + r * (ph + gapy);
      g.appendChild(buildChannel(m, id, ch, px, py, pw, ph));
    }
    return g;
  }

  function buildChannel(m, id, ch, px, py, pw, ph) {
    var list = m.byBoard[id][ch];
    var sv = list[0];
    var cls = 'wire-pad';
    if (!sv) cls += ' free';
    else {
      cls += ' used ' + (FN[sv.function] ? FN[sv.function].cls : 'fn-aux');
      if (sv.function === 'finger' && sv.fretB >= 1) cls += ' geared';
      if (sv.enabled === false) cls += ' off';
      if (list.length > 1) cls += ' dup';
    }
    var cell = svg('g', { class: 'wire-cell' });
    cell.appendChild(svg('rect', { class: cls, x: px, y: py, width: pw, height: ph, rx: 5 }));
    // Corner = the PCA pin/channel number; centre = string tag over fret/role code.
    cell.appendChild(svg('text', { class: 'wire-chnum' + (sv ? ' on' : ''), x: px + 3.5, y: py + 10, text: ch }));
    if (sv) {
      cell.appendChild(svg('text', { class: 'wire-chstr', x: px + pw / 2, y: py + 19, 'text-anchor': 'middle', text: stringTag(sv) }));
      cell.appendChild(svg('text', { class: 'wire-chcode', x: px + pw / 2, y: py + ph - 5, 'text-anchor': 'middle', text: padCode(sv) }));
    }
    // Native SVG tooltip: full description on hover.
    var tip = 'Channel ' + ch + ' — ' + (sv
      ? servoLabel(sv, m.auxOrder[m.servos.indexOf(sv)] || 0) + (sv.enabled === false ? ' (disabled)' : '') +
        (list.length > 1 ? ' — CONFLICT: ' + list.length + ' servos here' : '')
      : 'free');
    cell.appendChild(svg('title', null, tip));
    return cell;
  }

  // Direct-GPIO servos grouped in a board-sized box (signal from ESP GPIO, power
  // from the shared V+/GND buses).
  function buildDirectBox(p, m, x) {
    var g = svg('g', { class: 'wire-mod' });
    // Tap only V+ and GND (these servos take power from the servo rail too).
    ['vplus', 'gnd'].forEach(function (key, i) {
      var px = x + BOARD_W * (i ? 0.66 : 0.34);
      var by = busY(key);
      g.appendChild(svg('line', { class: 'wire-lead ' + key, x1: px, y1: BOARD_TOP, x2: px, y2: by }));
      g.appendChild(junction(key, px, by));
    });
    g.appendChild(svg('rect', { class: 'wire-board direct', x: x, y: BOARD_TOP, width: BOARD_W, height: BOARD_H, rx: 9 }));
    g.appendChild(svg('text', { class: 'wire-title', x: x + 12, y: BOARD_TOP + 22, text: 'Direct GPIO' }));
    g.appendChild(svg('text', { class: 'wire-sub', x: x + BOARD_W - 12, y: BOARD_TOP + 22, 'text-anchor': 'end', text: '×' + m.direct.length }));

    var y = BOARD_TOP + 44, lh = 22, shown = 0, max = 8;
    m.direct.forEach(function (s) {
      if (shown >= max) return;
      shown++;
      var dup = s.gpio >= 0 && (m.byGpio[s.gpio] || []).length > 1;
      var fn = FN[s.function] || FN.aux;
      var lbl = servoLabel(s, m.auxOrder[m.servos.indexOf(s)] || 0);
      g.appendChild(svg('rect', { class: 'wire-swatch ' + fn.cls, x: x + 12, y: y - 10, width: 12, height: 12, rx: 3 }));
      g.appendChild(svg('text', { class: 'wire-directpin' + (dup ? ' dup' : ''), x: x + 30, y: y, text: (s.gpio >= 0 ? 'GPIO' + s.gpio : 'GPIO —') }));
      g.appendChild(svg('text', { class: 'wire-directlbl', x: x + BOARD_W - 12, y: y, 'text-anchor': 'end', text: lbl.replace(/^String /, 'S').replace(' · ', ' ') }));
      y += lh;
    });
    if (m.direct.length > max)
      g.appendChild(svg('text', { class: 'wire-sub', x: x + 12, y: y + 2, text: '+ ' + (m.direct.length - max) + ' more…' }));
    return g;
  }

  // ---- HTML surrounds (legend, summary, controls) ---------------------------
  function legendCard() {
    function sw(cls, label) { return h('span.wire-lg', [h('span.wire-lg-sw.' + cls), h('span', label)]); }
    function rail(cls, label) { return h('span.wire-lg', [h('span.wire-lg-rail.' + cls), h('span', label)]); }
    return h('div.card', [
      h('h2', 'Legend'),
      h('div.wire-legend', [
        sw('fn-finger', 'Finger (fret servo)'), sw('fn-pluck', 'Plucker'), sw('fn-strum', 'Strum'),
        sw('fn-lift', 'Strum lift'), sw('fn-damper', 'Damper'), sw('fn-aux', 'Auxiliary'),
        h('span.wire-lg', [h('span.wire-lg-sw.free'), h('span', 'Free channel')]),
        h('span.wire-lg', [h('span.wire-lg-sw.geared'), h('span', 'Geared (two frets)')])
      ]),
      h('div.wire-legend', [
        rail('vplus', 'V+ 5–6 V servo rail'), rail('gnd', 'GND (common)'), rail('v3', '3V3 logic'),
        rail('sda', 'I²C SDA'), rail('scl', 'I²C SCL'), rail('oe', 'PCA9685 /OE safety')
      ]),
      h('p.muted', 'Each labelled channel is where one servo plugs in (signal + V+ + GND). On a pad the corner is the ' +
        'PCA pin/channel, the top tag is the string (S1…, GLB = global auxiliary) and the number below is the fret ' +
        '(P plucker, S strum, L lift, D damper, A auxiliary). A single PCA9685 can host several strings — each pin is ' +
        'labelled with its own string and fret, and the board header lists the strings it serves. Hover a channel for the full description.')
    ]);
  }

  function summaryCard(p, m, issues) {
    var onPca = m.pca.length, direct = m.direct.length;
    var stat = function (label, value) { return h('div.stat', [h('div.stat-label', label), h('div.stat-value', value)]); };
    var addrs = m.boardIds.map(function (id) { return hex2(0x40 + id); }).join(', ') || '—';
    var grid = h('div.grid', [
      stat('Instrument', (p.instrument && p.instrument.name) || '—'),
      stat('Strings', String((p.instrument && p.instrument.stringCount) || (p.strings || []).length)),
      stat('PCA9685 boards', String(m.boardIds.length)),
      stat('I²C addresses', addrs),
      stat('Servos on PCA', String(onPca)),
      stat('Direct-GPIO servos', String(direct)),
      stat('SDA / SCL', (m.sda >= 0 ? 'GPIO' + m.sda : '—') + ' / ' + (m.scl >= 0 ? 'GPIO' + m.scl : '—')),
      stat('/OE safety', m.oe >= 0 ? 'GPIO' + m.oe : '—')
    ]);
    var kids = [h('div.card-head', [h('h2', 'Harness summary'),
      h('span.muted', 'derived live from the current configuration')]), grid];
    if (issues.length) {
      kids.push(h('h3', 'Wiring checks'));
      issues.forEach(function (is) {
        kids.push(h('div.err-item' + (is.sev === 'warning' ? '.warn' : ''), [
          h('div.err-head', [h('span.pill.mini.' + (is.sev === 'warning' ? 'warn' : 'error'), is.sev)]),
          h('div.err-reason', is.msg)
        ]));
      });
    } else {
      kids.push(h('div.pill.ok', 'No wiring conflicts detected.'));
    }
    return h('div.card', kids);
  }

  // Serialize the live SVG and offer it as a download (a portable bench reference).
  function downloadSvg(host) {
    var node = host.querySelector('.wire-svg');
    if (!node) return;
    var clone = node.cloneNode(true);
    clone.setAttribute('xmlns', SVGNS);
    // Inline the computed theme colours so the file renders outside the app.
    inlineStyles(node, clone);
    var data = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    var blob = new Blob([data], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var name = ((GMB.state.profile.instrument && GMB.state.profile.instrument.name) || 'instrument');
    var a = document.createElement('a');
    a.href = url; a.download = GMB.slug(name) + '-wiring.svg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    GMB.toast('Wiring diagram downloaded.', 'ok');
  }
  // Copy computed presentation properties onto the clone so the standalone SVG
  // keeps its colours (the external stylesheet is not embedded).
  function inlineStyles(src, dst) {
    var props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity',
      'font-size', 'font-weight', 'font-family', 'text-anchor'];
    var cs = getComputedStyle(src);
    var decl = props.map(function (pr) { return pr + ':' + cs.getPropertyValue(pr); }).join(';');
    if (src.nodeType === 1) dst.setAttribute('style', decl);
    var sc = src.children || [], dc = dst.children || [];
    for (var i = 0; i < sc.length; i++) if (dc[i]) inlineStyles(sc[i], dc[i]);
  }

  // ---- view -----------------------------------------------------------------
  function render(host) {
    var p = GMB.state.profile;
    var servos = p.servos || [];

    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Wiring'),
        h('span.muted', 'graphical harness — ESP32-S3 + PCA9685(s), adapts to the configuration')]),
      h('p.muted', 'A schematic of how the current instrument is wired: the ESP32-S3, a separate ' +
        '5–6 V servo supply, one PCA9685 per board actually used (at its I²C address), the shared ' +
        'I²C + /OE + power buses, and any direct-GPIO servos. Each occupied channel is labelled with its ' +
        'string and fret, so a PCA9685 shared across several strings stays unambiguous. It updates with each ' +
        'change made in the Setup Wizard and GPIO Pins tabs.')
    ]));

    if (!servos.length) {
      host.appendChild(h('div.card', [h('div.pill.warn', 'No servos configured yet.'),
        h('p.muted', 'Define the instrument in the Setup Wizard first — the wiring map is built from its servos.'),
        h('div.row', [GMB.button('Open Setup Wizard', function () { GMB.navigate('wizard'); }, 'primary')])]));
      return;
    }

    var m = buildModel(p);
    var issues = findIssues(p, m);

    if (!m.usePca && !m.direct.length) {
      host.appendChild(h('div.note-box', 'The servos are configured but none has a signal source yet.'));
    }

    // The diagram (scrolls horizontally on narrow screens, like the fretboard).
    host.appendChild(h('div.card.wire-card', [
      h('div.wire-toolbar', [
        h('span.muted', m.boardIds.length + ' PCA board(s) · ' + m.pca.length + ' PCA servo(s) · ' + m.direct.length + ' direct'),
        h('span.spacer'),
        GMB.button('Download SVG', function () { downloadSvg(host); }, 'ghost')
      ]),
      h('div.wire-scroll', buildDiagram(p, m))
    ]));

    host.appendChild(summaryCard(p, m, issues));
    host.appendChild(legendCard());
  }

  GMB.views.wiring = { render: render };
})(window);
