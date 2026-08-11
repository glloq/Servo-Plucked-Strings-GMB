/*
 * fretboard.js — playable instrument ("Instrument" main page).
 *
 * Redesigned to echo the General-Midi-Boop virtual keyboard: a clean wooden neck
 * with a note-name circle on every EQUIPPED fret (the frets that carry a servo),
 * an open-string circle on the headstock side, and nothing else on the board — no
 * colour coding, no legend. Press-and-hold a note to play it; a chord bar below
 * plays common chords across several strings at once. The top bar keeps only the
 * controls a player needs: a big emergency STOP, a Re-arm button, the armed badge
 * and the play-mode selector (above the frets).
 *
 * It drives the hardware through the one-servo-at-a-time test endpoints
 * (POST /api/test/servo), so it works on the real device (once armed) and
 * stand-alone against the mock backend, reading the working draft profile.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---- geometry (SVG user units; the <svg> scales to the container) ---------
  var VB_W = 1000;
  var PEG_X = 26;        // tuning-peg column (headstock)
  var NUT_X = 132;       // the nut (fret 0)
  var FRET_RIGHT = 812;  // x of the highest fret wire
  var BRIDGE_X = 936;    // where the strings meet the bridge (on the body)
  var BODY_RIGHT = 972;
  var TOP = 54;          // headroom for the fret numbers
  var ROW = 58;          // vertical pitch between strings
  var BOT = 40;          // room for the fret-number row at the bottom
  var STD_INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];  // single dots
  var DBL_INLAYS = [12, 24];                       // double dots (octave)

  // ---- view-local play state (reset on each mount) --------------------------
  var mode = 'pluck';        // current play mode (persists across renders)
  var altDown = true;        // 'alternate' mode: is the next stroke a down-stroke?
  var held = {};             // stringIndex -> { idx, fret } finger currently pressed
  var active = {};           // stringIndex -> fret currently sounding (incl. 0 = open)
  var timers = [];           // pending strike/return setTimeouts, cleared on teardown
  var armedHint = false;     // show the "arm the instrument" hint at most once
  var els = null;            // element references for live highlight updates
  var chordRoot = 0;         // selected chord root (0 = C … 11 = B), persists

  // ---- small helpers --------------------------------------------------------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function svg(tag, attrs, kids) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
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

  // Profile lookups (kept local so the module is independent of the wizard).
  function fingerFor(strIdx, fret) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.enabled && s.function === 'finger' && s.stringIndex === strIdx &&
          (s.fret === fret || s.fretB === fret)) return s;
    }
    return null;
  }
  function isGeared(sv) { return !!sv && sv.function === 'finger' && sv.fretB >= 1; }
  function strikerFor(strIdx) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++)
      if (list[i].enabled && (list[i].function === 'pluck' || list[i].function === 'strum') &&
          list[i].stringIndex === strIdx) return list[i];
    return null;
  }
  function perStringServo(strIdx, fn) {
    var list = GMB.state.profile.servos;
    for (var i = 0; i < list.length; i++)
      if (list[i].enabled && list[i].function === fn && list[i].stringIndex === strIdx) return list[i];
    return null;
  }
  function servoIndexOf(sv) { return GMB.state.profile.servos.indexOf(sv); }
  function clampPulse(sv, us) { return clamp(us, sv.pulseMinUs || 500, sv.pulseMaxUs || 2500); }

  // Equal-temperament fret position (luthier's rule of 18), normalised to fit.
  function fretFraction(n) { return 1 - Math.pow(2, -n / 12); }
  function fretX(n, boardMax) {
    var denom = fretFraction(boardMax) || 1;
    return NUT_X + (FRET_RIGHT - NUT_X) * (fretFraction(n) / denom);
  }
  function stringY(i) { return TOP + ROW * i + ROW / 2; }

  // Which sounding modes the wiring can actually perform (feasibility gating).
  function availableModes(p) {
    var modes = [{ id: 'pluck', label: 'Pluck' }];
    var anyStrum = p.servos.some(function (s) { return s.enabled && s.function === 'strum'; });
    if (anyStrum) {
      modes.push({ id: 'up', label: 'Up-stroke' });
      modes.push({ id: 'alternate', label: 'Alternate' });
    }
    if (p.servos.some(function (s) { return s.enabled && s.function === 'damper'; }))
      modes.push({ id: 'mute', label: 'Muted' });
    return modes;
  }
  function modeHint(id) {
    return {
      pluck: 'Single strike (down-stroke).',
      up: 'Strike with the up-stroke pulse.',
      alternate: 'Alternate down / up strokes on each note.',
      mute: 'Strike, then damp for a short, muted note.'
    }[id] || '';
  }

  // ---- driving the mechanics ------------------------------------------------
  function drive(payload) {
    return GMB.api.testServo(payload).catch(function () {
      if (!armedHint) {
        armedHint = true;
        GMB.toast('Re-arm the instrument (top of the page) to move the servos.', 'warn');
      }
    });
  }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }

  // Press a fret (or open string) on a string: lift any finger already down on
  // that string, press the target finger, then sound it.
  function press(strIdx, fret) {
    releaseFinger(strIdx);
    var lead = 0;
    if (fret > 0) {
      var fsv = fingerFor(strIdx, fret);
      if (!fsv) return;
      var idx = servoIndexOf(fsv);
      var pulse = (isGeared(fsv) && fsv.fretB === fret) ? (fsv.activeBUs || fsv.activeUs) : fsv.activeUs;
      if (idx >= 0) drive({ index: idx, active: true, us: pulse | 0 });
      held[strIdx] = { idx: idx, fret: fret };
      lead = clamp(fsv.travelMs || 120, 60, 200);
    }
    active[strIdx] = fret;
    paintActive(strIdx, fret, true);
    strike(strIdx, lead);
  }

  function release(strIdx) {
    releaseFinger(strIdx);
    if (active[strIdx] !== undefined) {
      paintActive(strIdx, active[strIdx], false);
      delete active[strIdx];
    }
  }
  function releaseFinger(strIdx) {
    var hv = held[strIdx];
    if (!hv) return;
    delete held[strIdx];
    if (hv.idx >= 0) drive({ index: hv.idx, active: false });
  }
  function releaseAllActive() { Object.keys(active).slice().forEach(function (k) { release(+k); }); }

  // Sound the string after `lead` ms using the striker and the current play mode.
  function strike(strIdx, lead) {
    var sk = strikerFor(strIdx);
    if (!sk) { GMB.toast('String ' + (strIdx + 1) + ' has no plucker to sound it.', 'warn'); return; }
    var idx = servoIndexOf(sk);
    if (idx < 0) return;
    var down = sk.activeUs | 0, rest = sk.restUs | 0;
    var canUp = sk.function === 'strum' || sk.activeAltUs > 0;
    var upUs = clampPulse(sk, sk.activeAltUs ? sk.activeAltUs : (2 * rest - down));
    var useUp = false;
    if (mode === 'up') useUp = canUp;
    else if (mode === 'alternate' && canUp) { useUp = !altDown; altDown = !altDown; }
    var strikeUs = useUp ? upUs : down;

    var lift = perStringServo(strIdx, 'strumLift');
    var liftIdx = lift ? servoIndexOf(lift) : -1;
    var strokeMs = Math.max(80, sk.strokeMs || 120);

    later(function () {
      if (liftIdx >= 0) drive({ index: liftIdx, active: true, us: lift.activeUs | 0 });
      drive({ index: idx, active: true, us: strikeUs });
      flashString(strIdx);
      if (mode === 'mute') {
        var dmp = perStringServo(strIdx, 'damper');
        if (dmp) {
          var di = servoIndexOf(dmp);
          later(function () {
            drive({ index: di, active: true, us: dmp.activeUs | 0 });
            later(function () { drive({ index: di, active: false }); }, 170);
          }, 130);
        }
      }
      later(function () {
        drive({ index: idx, active: false });
        if (liftIdx >= 0) drive({ index: liftIdx, active: false });
      }, strokeMs);
    }, lead || 0);
  }

  // ---- chords ---------------------------------------------------------------
  var ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var CHORD_TYPES = [
    { id: 'maj',  label: 'Maj',  iv: [0, 4, 7] },
    { id: 'min',  label: 'Min',  iv: [0, 3, 7] },
    { id: '5',    label: '5',    iv: [0, 7] },
    { id: '7',    label: '7',    iv: [0, 4, 7, 10] },
    { id: 'maj7', label: 'Maj7', iv: [0, 4, 7, 11] },
    { id: 'm7',   label: 'm7',   iv: [0, 3, 7, 10] }
  ];

  // Play a chord: pick, on each string, the lowest playable fret (open or equipped)
  // whose pitch class is in the chord, then strike them together (a strummed chord).
  function playChord(intervals) {
    var p = GMB.state.profile;
    releaseAllActive();
    var pcs = intervals.map(function (iv) { return (chordRoot + iv) % 12; });
    var picks = [];
    p.strings.forEach(function (s, i) {
      if (!s.enabled) return;
      for (var f = 0; f <= (s.maxFret || 0); f++) {
        if (f === 0) { if (!strikerFor(i)) continue; }
        else if (!fingerFor(i, f)) continue;
        if (pcs.indexOf((s.openNote + f) % 12) >= 0) { picks.push({ str: i, fret: f }); break; }
      }
    });
    if (!picks.length) { GMB.toast('No chord notes reachable on this instrument.', 'warn'); return; }
    picks.forEach(function (pk) { press(pk.str, pk.fret); });
    later(function () { picks.forEach(function (pk) { release(pk.str); }); }, 650);
  }

  // ---- live highlight -------------------------------------------------------
  function paintActive(strIdx, fret, on) {
    if (!els) return;
    var mark = fret > 0 ? els.note[strIdx + ':' + fret] : els.open[strIdx];
    if (mark) mark.classList.toggle('pressed', on);
  }
  function flashString(strIdx) {
    if (!els || !els.string[strIdx]) return;
    var line = els.string[strIdx];
    line.classList.remove('vibrate');
    try { line.getBBox(); } catch (_) {}
    line.classList.add('vibrate');
    later(function () { line.classList.remove('vibrate'); }, 420);
  }

  // ---- board construction ---------------------------------------------------
  function buildBoard(p) {
    var strings = p.strings || [];
    var n = strings.length;
    var boardMax = Math.max.apply(null, strings.map(function (s) { return s.maxFret || 0; }).concat([0]));
    var H = TOP + n * ROW + BOT;
    els = { string: [], note: {}, open: [] };

    var root = svg('svg', {
      class: 'fb-svg', viewBox: '0 0 ' + VB_W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': 'Instrument fretboard'
    });

    var defs = svg('defs', null, [
      svg('linearGradient', { id: 'fbNeck', x1: '0', y1: '0', x2: '0', y2: '1' }, [
        svg('stop', { offset: '0%', class: 'fb-neck-a' }),
        svg('stop', { offset: '52%', class: 'fb-neck-b' }),
        svg('stop', { offset: '100%', class: 'fb-neck-a' })
      ]),
      svg('linearGradient', { id: 'fbBody', x1: '0', y1: '0', x2: '0', y2: '1' }, [
        svg('stop', { offset: '0%', class: 'fb-body-a' }),
        svg('stop', { offset: '100%', class: 'fb-body-b' })
      ])
    ]);
    root.appendChild(defs);

    // Instrument silhouette: body (right) + soundhole, neck, headstock (left).
    var bodyTop = TOP - 22, bodyBot = H - BOT + 22;
    root.appendChild(svg('path', {
      class: 'fb-body',
      d: 'M ' + (FRET_RIGHT - 40) + ' ' + bodyTop +
         ' H ' + (BODY_RIGHT - 26) +
         ' Q ' + BODY_RIGHT + ' ' + bodyTop + ' ' + BODY_RIGHT + ' ' + (bodyTop + 26) +
         ' V ' + (bodyBot - 26) +
         ' Q ' + BODY_RIGHT + ' ' + bodyBot + ' ' + (BODY_RIGHT - 26) + ' ' + bodyBot +
         ' H ' + (FRET_RIGHT - 40) + ' Z',
      fill: 'url(#fbBody)'
    }));
    var holeCx = (FRET_RIGHT + BODY_RIGHT) / 2 + 4, holeCy = TOP + (n * ROW) / 2;
    root.appendChild(svg('ellipse', { class: 'fb-hole', cx: holeCx, cy: holeCy,
      rx: 34, ry: clamp(n * ROW * 0.32, 26, 120) }));
    root.appendChild(svg('ellipse', { class: 'fb-hole-ring', cx: holeCx, cy: holeCy,
      rx: 40, ry: clamp(n * ROW * 0.32 + 6, 30, 130) }));

    root.appendChild(svg('path', {
      class: 'fb-headstock',
      d: 'M ' + (NUT_X + 2) + ' ' + (TOP - 14) +
         ' H ' + 40 +
         ' Q ' + 8 + ' ' + (TOP - 14) + ' ' + 8 + ' ' + (TOP + 6) +
         ' V ' + (H - BOT - 6) +
         ' Q ' + 8 + ' ' + (H - BOT + 14) + ' ' + 40 + ' ' + (H - BOT + 14) +
         ' H ' + (NUT_X + 2) + ' Z'
    }));

    root.appendChild(svg('rect', { class: 'fb-neck', x: NUT_X, y: TOP - 14,
      width: (FRET_RIGHT + 24) - NUT_X, height: (H - BOT + 14) - (TOP - 14),
      rx: 6, fill: 'url(#fbNeck)' }));
    root.appendChild(svg('rect', { class: 'fb-nut', x: NUT_X - 6, y: TOP - 14,
      width: 6, height: (H - BOT + 14) - (TOP - 14), rx: 2 }));

    // Fret wires + numbers (top and bottom, GMB-style).
    for (var f = 1; f <= boardMax; f++) {
      var x = fretX(f, boardMax);
      root.appendChild(svg('line', { class: 'fb-fret', x1: x, y1: TOP - 14, x2: x, y2: H - BOT + 14 }));
      root.appendChild(svg('text', { class: 'fb-fretnum', x: (fretX(f - 1, boardMax) + x) / 2, y: H - BOT + 30,
        'text-anchor': 'middle', text: String(f) }));
    }
    root.appendChild(svg('text', { class: 'fb-fretnum', x: (NUT_X + fretX(1, boardMax)) / 2 - 30, y: H - BOT + 30,
      'text-anchor': 'middle', text: '0' }));

    // Inlay dots.
    var midY = TOP + (n * ROW) / 2;
    function inlayX(fret) { return (fretX(fret - 1, boardMax) + fretX(fret, boardMax)) / 2; }
    STD_INLAYS.forEach(function (fr) {
      if (fr <= boardMax) root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY, r: 5 }));
    });
    DBL_INLAYS.forEach(function (fr) {
      if (fr <= boardMax) {
        root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY - ROW * 0.55, r: 5 }));
        root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY + ROW * 0.55, r: 5 }));
      }
    });

    // Strings — thicker for the lower-pitched ones (mirrors real gauges).
    var notes = strings.map(function (s) { return s.openNote; });
    var loN = Math.min.apply(null, notes), hiN = Math.max.apply(null, notes);
    for (var i = 0; i < n; i++) {
      var t = hiN > loN ? (strings[i].openNote - loN) / (hiN - loN) : 0.5;
      var w = 3.4 - 1.7 * t;
      var y = stringY(i);
      // Dim the out-of-range region beyond this string's last fret.
      if (strings[i].maxFret < boardMax) {
        var xoor = fretX(strings[i].maxFret, boardMax);
        root.appendChild(svg('rect', { class: 'fb-oor', x: xoor, y: y - ROW * 0.42,
          width: (FRET_RIGHT + 24) - xoor, height: ROW * 0.84 }));
      }
      var ln = svg('line', { class: 'fb-string', x1: PEG_X, y1: y, x2: BRIDGE_X, y2: y,
        'stroke-width': w.toFixed(2) });
      els.string[i] = ln;
      root.appendChild(ln);
    }

    // Note circles: an open-string circle on the headstock side, and one per
    // EQUIPPED fret (the frets that actually carry a servo). That is all — no
    // colour coding, no pads.
    function noteCircle(cx, cy, label, strIdx, fret, playable) {
      var r = fret > 0 ? clamp((fretX(fret, boardMax) - fretX(fret - 1, boardMax)) * 0.34, 8, 13) : 12;
      var g = svg('g', { class: 'fb-notewrap' + (playable ? '' : ' disabled') });
      var circle = svg('circle', { class: 'fb-note', cx: cx, cy: cy, r: r });
      g.appendChild(circle);
      g.appendChild(svg('text', { class: 'fb-notetext', x: cx, y: cy + 3.6, 'text-anchor': 'middle', text: label }));
      if (playable) attachCell(g, strIdx, fret);
      return { g: g, circle: circle };
    }

    for (i = 0; i < n; i++) {
      (function (idx) {
        var s = strings[idx];
        var yy = stringY(idx);
        root.appendChild(svg('circle', { class: 'fb-peg', cx: PEG_X, cy: yy, r: 7 }));
        root.appendChild(svg('text', { class: 'fb-strnum', x: PEG_X, y: yy - 12, 'text-anchor': 'middle', text: String(idx + 1) }));
        // Open string (playable when a plucker exists).
        var open = noteCircle(NUT_X - 22, yy, GMB.noteName(s.openNote), idx, 0, !!strikerFor(idx));
        els.open[idx] = open.circle;
        root.appendChild(open.g);
        // Equipped frets.
        for (var fr = 1; fr <= s.maxFret; fr++) {
          if (!fingerFor(idx, fr)) continue;
          var cx = (fretX(fr - 1, boardMax) + fretX(fr, boardMax)) / 2;
          var node = noteCircle(cx, yy, GMB.noteName(s.openNote + fr), idx, fr, true);
          els.note[idx + ':' + fr] = node.circle;
          root.appendChild(node.g);
        }
      })(i);
    }

    return root;
  }

  // Press-and-hold semantics via pointer capture, plus keyboard for accessibility.
  function attachCell(g, strIdx, fret) {
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    var s = GMB.state.profile.strings[strIdx];
    g.setAttribute('aria-label', 'String ' + (strIdx + 1) + ' ' +
      (fret === 0 ? 'open' : 'fret ' + fret) + ' — ' + GMB.noteName(s.openNote + fret));
    g.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { g.setPointerCapture(e.pointerId); } catch (_) {}
      press(strIdx, fret);
    });
    var up = function () { release(strIdx); };
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
    g.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && active[strIdx] === undefined) { e.preventDefault(); press(strIdx, fret); }
    });
    g.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); release(strIdx); }
    });
    g.addEventListener('blur', up);
  }

  // ---- top control bar (emergency stop + re-arm + armed badge + play mode) ---
  function topBar(p) {
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

    var modes = availableModes(p);
    if (!modes.some(function (m) { return m.id === mode; })) mode = 'pluck';
    var modeWrap = h('div.fb-modes');
    modes.forEach(function (m) {
      var btn = h('button.fb-mode' + (m.id === mode ? '.active' : ''),
        { type: 'button', title: modeHint(m.id), onclick: function () {
          mode = m.id;
          modeWrap.querySelectorAll('.fb-mode').forEach(function (x) { x.classList.remove('active'); });
          btn.classList.add('active');
        } }, m.label);
      modeWrap.appendChild(btn);
    });

    return h('div.card.fb-topbar', [
      h('div.fb-estop', [
        h('button.btn.danger.fb-stop', { type: 'button', title: 'Emergency stop', onclick: GMB.doPanic }, 'STOP'),
        GMB.button('Re-arm servos', function () {
          GMB.api.resetSystem().then(function (res) {
            if (res && res.ok === false) GMB.toast('Re-arm refused: ' + (res.error || 'E-stop / invalid config') + '.', 'warn');
            else { armedHint = false; GMB.toast('Re-armed.', 'ok'); }
            refresh();
          }).catch(function (e) { GMB.toast('Re-arm failed: ' + (e && e.message || e), 'error'); });
        }, 'ghost'),
        badge
      ]),
      h('div.fb-play', [h('span.fb-lbl', 'Play'), modeWrap])
    ]);
  }

  // ---- chord bar (root + common chord types, played across the strings) ------
  function chordBar() {
    var rootWrap = h('div.fb-roots');
    ROOTS.forEach(function (name, i) {
      var b = h('button.fb-root' + (i === chordRoot ? '.active' : ''),
        { type: 'button', onclick: function () {
          chordRoot = i;
          rootWrap.querySelectorAll('.fb-root').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
        } }, name);
      rootWrap.appendChild(b);
    });
    var typeWrap = h('div.fb-chords');
    CHORD_TYPES.forEach(function (c) {
      typeWrap.appendChild(h('button.fb-chord', { type: 'button',
        onclick: function () { playChord(c.iv); } }, c.label));
    });
    return h('div.card.fb-chordbar', [
      h('div.fb-chordhead', [h('span.fb-lbl', 'Chords'), h('span.muted', 'play across the strings')]),
      h('div.fb-rootrow', [h('span.fb-rootlbl', 'Root'), rootWrap]),
      typeWrap
    ]);
  }

  // ---- render / teardown ----------------------------------------------------
  function render(host) {
    held = {}; active = {}; timers = []; armedHint = false; els = null;
    var p = GMB.state.profile;
    var strings = p.strings || [];
    var anyStriker = strings.some(function (_, i) { return !!strikerFor(i); });

    host.appendChild(topBar(p));

    if (!strings.length) {
      host.appendChild(h('div.card', [h('div.pill.warn', 'No strings configured yet.'),
        h('p.muted', 'Set the instrument up first — the Setup page walks the whole build.'),
        h('div.row', [GMB.button('Go to setup', function () { GMB.navigate('setup'); }, 'primary')])]));
      return;
    }

    // The board itself (scrolls horizontally on narrow screens).
    host.appendChild(h('div.card.fb-card', [h('div.fb-scroll', buildBoard(p))]));

    if (!anyStriker)
      host.appendChild(h('div.note-box', [
        'No plucker on any string yet, so notes cannot sound. ',
        GMB.button('Go to setup', function () { GMB.navigate('setup'); }, 'ghost')]));
    else
      host.appendChild(chordBar());
  }

  // Leaving the page (or re-rendering) must never leave a finger pressed or a
  // strike timer pending on the hardware.
  function teardown() {
    timers.forEach(clearTimeout);
    timers = [];
    Object.keys(held).slice().forEach(function (k) { releaseFinger(+k); });
    held = {}; active = {}; els = null;
  }

  GMB.views.fretboard = { render: render, teardown: teardown };
})(window);
