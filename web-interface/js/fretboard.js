/*
 * fretboard.js — playable fretboard visualization ("Fretboard" tab).
 *
 * Once an instrument is defined and calibrated (strings + finger servos +
 * plucker/strum servos), this page draws its neck as a stylised instrument and
 * turns it into a clickable "keyboard":
 *
 *   • The strings and fret wires are drawn to scale — the spacing between frets
 *     follows equal temperament (the luthier's "rule of 18"), so the neck
 *     compresses toward the body exactly like a real fretboard.
 *   • Every equipped fret shows the finger servo as a small rectangle on the
 *     string, just on the nut side of its fret wire (where a finger presses).
 *   • Press-and-hold a fret with a servo → the finger servo presses that fret
 *     and the string is sounded; the played string lights up. Release → the
 *     finger lifts off the string. The open-string zone (left of the nut) plays
 *     the open note (fret 0, no finger).
 *   • A play-mode selector exposes the sounding options the wiring actually
 *     supports — Pluck, Up-stroke and Alternate for a strum servo, Muted when a
 *     damper is present — so only mechanically-feasible modes are offered.
 *
 * It drives the hardware through the same one-servo-at-a-time test endpoints the
 * wizard uses (POST /api/test/servo), so it works on the real device (once armed)
 * and stand-alone against the mock backend. Reads the working draft profile
 * (GMB.state.profile), so an in-progress calibration can be tried immediately.
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
  var BOT = 34;
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
  var readout = null;        // "now playing" line

  // ---- small helpers --------------------------------------------------------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function noop() {}
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

  // Equal-temperament fret position: distance from the nut as a fraction of the
  // scale length is 1 - 2^(-n/12). Normalising by the highest fret keeps the real
  // relative spacing while fitting the drawn board to the available width.
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

  // ---- driving the mechanics ------------------------------------------------

  // One servo command. A rejection (e.g. not armed / mock offline) is swallowed,
  // but the first one nudges the user to arm the instrument.
  function drive(payload) {
    return GMB.api.testServo(payload).catch(function () {
      if (!armedHint) {
        armedHint = true;
        GMB.toast('Arm the instrument (top of the page) to move the servos.', 'warn');
      }
    });
  }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }

  // Press a fret (or open string) on a string: lift any finger already down on
  // that string, press the target finger, light the string, then sound it.
  function press(strIdx, fret) {
    var p = GMB.state.profile;
    releaseFinger(strIdx);
    var lead = 0;
    if (fret > 0) {
      var fsv = fingerFor(strIdx, fret);
      if (!fsv) return;                       // guarded: empty cells carry no handler
      var idx = servoIndexOf(fsv);
      // A geared finger presses its side-B fret with a different pulse.
      var pulse = (isGeared(fsv) && fsv.fretB === fret) ? (fsv.activeBUs || fsv.activeUs) : fsv.activeUs;
      if (idx >= 0) drive({ index: idx, active: true, us: pulse | 0 });
      held[strIdx] = { idx: idx, fret: fret };
      lead = clamp(fsv.travelMs || 120, 60, 200);  // give the finger time to seat
    }
    active[strIdx] = fret;
    paintActive(strIdx, fret, true);
    strike(strIdx, lead);
  }

  // Release a string: lift its finger and drop the highlight.
  function release(strIdx) {
    releaseFinger(strIdx);
    if (active[strIdx] !== undefined) {
      paintActive(strIdx, active[strIdx], false);
      delete active[strIdx];
    }
    updateReadout();
  }
  function releaseFinger(strIdx) {
    var hv = held[strIdx];
    if (!hv) return;
    delete held[strIdx];
    // active:false with no us → normal rest semantics (honours disableAtRest).
    if (hv.idx >= 0) drive({ index: hv.idx, active: false });
  }

  // Sound the string after `lead` ms (once the finger has begun to seat), using
  // the striker servo and the current play mode. A strum lift, when present, is
  // lowered for the stroke and raised again; 'mute' taps the damper right after.
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
      if (liftIdx >= 0) drive({ index: liftIdx, active: true, us: lift.activeUs | 0 });  // lower onto string
      drive({ index: idx, active: true, us: strikeUs });
      flashString(strIdx);
      // Muted: let it ring for a moment, then damp for a short, staccato note.
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
        drive({ index: idx, active: false });                      // return stroke
        if (liftIdx >= 0) drive({ index: liftIdx, active: false }); // raise the lift
      }, strokeMs);
    }, lead || 0);
  }

  // Lift every finger this page is holding (safety net; STOP/panic fully
  // neutralises the hardware). Scoped to tracked fingers so it never floods the
  // command queue with a rest command for every servo on the instrument.
  function allFingersUp() {
    var keys = Object.keys(active);
    keys.slice().forEach(function (k) { release(+k); });
    GMB.toast(keys.length ? 'Lifted ' + keys.length + ' finger(s).' : 'No fingers are pressed.',
      keys.length ? 'ok' : 'warn');
  }

  // ---- live highlight -------------------------------------------------------
  function paintActive(strIdx, fret, on) {
    if (!els) return;
    if (els.string[strIdx]) els.string[strIdx].classList.toggle('active', on);
    if (els.rowHi[strIdx]) els.rowHi[strIdx].classList.toggle('active', on);
    var mark = fret > 0 ? els.pad[strIdx + ':' + fret] : els.open[strIdx];
    if (mark) mark.classList.toggle('pressed', on);
    if (on) updateReadout(strIdx, fret); else updateReadout();
  }
  // A brief "pluck" wobble on the string, cleared shortly after.
  function flashString(strIdx) {
    if (!els || !els.string[strIdx]) return;
    var line = els.string[strIdx];
    line.classList.remove('vibrate');
    try { line.getBBox(); } catch (_) {}  // force reflow so re-adding restarts the animation
    line.classList.add('vibrate');
    later(function () { line.classList.remove('vibrate'); }, 420);
  }
  function updateReadout(strIdx, fret) {
    if (!readout) return;
    var keys = Object.keys(active);
    if (strIdx === undefined) {
      if (!keys.length) { readout.textContent = '—'; return; }
      strIdx = +keys[keys.length - 1];
      fret = active[strIdx];
    }
    var s = GMB.state.profile.strings[strIdx];
    var note = GMB.noteName(s.openNote + fret);
    readout.textContent = 'String ' + (strIdx + 1) + ' · ' +
      (fret === 0 ? 'open' : 'fret ' + fret) + ' · ' + note;
  }

  // ---- board construction ---------------------------------------------------
  function buildBoard(p) {
    var strings = p.strings || [];
    var n = strings.length;
    var boardMax = Math.max.apply(null, strings.map(function (s) { return s.maxFret || 0; }).concat([0]));
    var H = TOP + n * ROW + BOT;
    els = { string: [], rowHi: [], pad: {}, open: [] };

    var root = svg('svg', {
      class: 'fb-svg', viewBox: '0 0 ' + VB_W + ' ' + H,
      preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': 'Instrument fretboard'
    });

    // Wood gradients (themed via CSS classes on the stops).
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

    // Instrument silhouette in the background: body (right) + soundhole, neck,
    // headstock (left) with tuning pegs.
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

    // Headstock.
    root.appendChild(svg('path', {
      class: 'fb-headstock',
      d: 'M ' + (NUT_X + 2) + ' ' + (TOP - 14) +
         ' H ' + 40 +
         ' Q ' + 8 + ' ' + (TOP - 14) + ' ' + 8 + ' ' + (TOP + 6) +
         ' V ' + (H - BOT - 6) +
         ' Q ' + 8 + ' ' + (H - BOT + 14) + ' ' + 40 + ' ' + (H - BOT + 14) +
         ' H ' + (NUT_X + 2) + ' Z'
    }));

    // Neck / fretboard.
    root.appendChild(svg('rect', { class: 'fb-neck', x: NUT_X, y: TOP - 14,
      width: (FRET_RIGHT + 24) - NUT_X, height: (H - BOT + 14) - (TOP - 14),
      rx: 6, fill: 'url(#fbNeck)' }));

    // Nut.
    root.appendChild(svg('rect', { class: 'fb-nut', x: NUT_X - 6, y: TOP - 14,
      width: 6, height: (H - BOT + 14) - (TOP - 14), rx: 2 }));

    // Fret wires + numbers.
    for (var f = 1; f <= boardMax; f++) {
      var x = fretX(f, boardMax);
      root.appendChild(svg('line', { class: 'fb-fret', x1: x, y1: TOP - 14, x2: x, y2: H - BOT + 14 }));
      root.appendChild(svg('text', { class: 'fb-fretnum', x: x, y: TOP - 24,
        'text-anchor': 'middle', text: String(f) }));
    }

    // Inlay dots (centre of the cell, on the neck centre line).
    var midY = TOP + (n * ROW) / 2;
    function inlayX(fret) { return (fretX(fret - 1, boardMax) + fretX(fret, boardMax)) / 2; }
    STD_INLAYS.forEach(function (fr) {
      if (fr <= boardMax) root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY, r: 6 }));
    });
    DBL_INLAYS.forEach(function (fr) {
      if (fr <= boardMax) {
        root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY - ROW * 0.55, r: 6 }));
        root.appendChild(svg('circle', { class: 'fb-inlay', cx: inlayX(fr), cy: midY + ROW * 0.55, r: 6 }));
      }
    });

    // Per-string row highlight (behind the strings).
    for (var i = 0; i < n; i++) {
      var rh = svg('rect', { class: 'fb-rowhi', x: NUT_X, y: stringY(i) - ROW * 0.42,
        width: FRET_RIGHT + 24 - NUT_X, height: ROW * 0.84, rx: 5 });
      els.rowHi[i] = rh;
      root.appendChild(rh);
    }

    // Strings — thicker for the lower-pitched ones (mirrors real gauges).
    var notes = strings.map(function (s) { return s.openNote; });
    var loN = Math.min.apply(null, notes), hiN = Math.max.apply(null, notes);
    for (i = 0; i < n; i++) {
      var t = hiN > loN ? (strings[i].openNote - loN) / (hiN - loN) : 0.5;
      var w = 3.4 - 1.7 * t;   // low note (t≈0) → thick, high note (t≈1) → thin
      var y = stringY(i);
      var ln = svg('line', { class: 'fb-string', x1: PEG_X, y1: y, x2: BRIDGE_X, y2: y,
        'stroke-width': w.toFixed(2) });
      els.string[i] = ln;
      root.appendChild(ln);
    }

    // Servo pads: a small rectangle on the string, just on the nut side of the
    // fret wire — one per equipped fret (a geared servo shows a pad on both frets).
    for (i = 0; i < n; i++) {
      GMB.availableFrets(p, i).forEach(function (fret) {
        if (fret > boardMax) return;
        var self = i;
        var xr = fretX(fret, boardMax);
        var cellW = fretX(fret, boardMax) - fretX(fret - 1, boardMax);
        var padW = clamp(cellW * 0.5, 7, 16);
        var padH = clamp(ROW * 0.36, 12, 20);
        var sv = fingerFor(self, fret);
        var pad = svg('rect', {
          class: 'fb-pad' + (isGeared(sv) ? ' geared' : ''),
          x: xr - 3 - padW, y: stringY(self) - padH / 2, width: padW, height: padH, rx: 3
        });
        els.pad[self + ':' + fret] = pad;
        root.appendChild(pad);
      });
    }

    // Tuning pegs + open-note labels + open-string trigger (headstock region).
    for (i = 0; i < n; i++) {
      (function (idx) {
        var y = stringY(idx);
        var s = strings[idx];
        root.appendChild(svg('circle', { class: 'fb-peg', cx: PEG_X, cy: y, r: 7 }));
        var openMark = svg('circle', { class: 'fb-open', cx: NUT_X - 20, cy: y, r: 9 });
        els.open[idx] = openMark;
        root.appendChild(openMark);
        root.appendChild(svg('text', { class: 'fb-opennote', x: NUT_X - 20, y: y - 15,
          'text-anchor': 'middle', text: GMB.noteName(s.openNote) }));
        root.appendChild(svg('text', { class: 'fb-strnum', x: NUT_X - 20, y: y + 4,
          'text-anchor': 'middle', text: String(idx + 1) }));

        // Open-string hit zone (headstock → nut). Playable only if a striker exists.
        var openCell = svg('rect', { x: 2, y: y - ROW * 0.42, width: NUT_X - 8, height: ROW * 0.84,
          class: 'fb-cell' + (strikerFor(idx) ? '' : ' empty'), rx: 5 });
        if (strikerFor(idx)) attachCell(openCell, idx, 0);
        root.appendChild(openCell);

        // Fret cells 1..boardMax. Playable when the fret carries a finger and is
        // within this string's range.
        for (var fr = 1; fr <= boardMax; fr++) {
          var x0 = fretX(fr - 1, boardMax), x1 = fretX(fr, boardMax);
          var playable = fr <= (s.maxFret || 0) && !!fingerFor(idx, fr);
          var cell = svg('rect', { x: x0, y: y - ROW * 0.42, width: x1 - x0, height: ROW * 0.84,
            class: 'fb-cell' + (playable ? '' : ' empty') });
          if (playable) attachCell(cell, idx, fr);
          root.appendChild(cell);
        }
      })(i);
    }

    return root;
  }

  // Wire one interactive cell: press-and-hold semantics via pointer capture, plus
  // keyboard (Enter / Space) for accessibility.
  function attachCell(rect, strIdx, fret) {
    rect.setAttribute('tabindex', '0');
    rect.setAttribute('role', 'button');
    var s = GMB.state.profile.strings[strIdx];
    rect.setAttribute('aria-label', 'String ' + (strIdx + 1) + ' ' +
      (fret === 0 ? 'open' : 'fret ' + fret) + ' — ' + GMB.noteName(s.openNote + fret));
    rect.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { rect.setPointerCapture(e.pointerId); } catch (_) {}
      press(strIdx, fret);
    });
    var up = function () { release(strIdx); };
    rect.addEventListener('pointerup', up);
    rect.addEventListener('pointercancel', up);
    rect.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && active[strIdx] === undefined) { e.preventDefault(); press(strIdx, fret); }
    });
    rect.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); release(strIdx); }
    });
    rect.addEventListener('blur', up);
  }

  // ---- controls (arm, mode, actions) ----------------------------------------
  function armBar() {
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
    return h('div.fb-arm', [
      GMB.button('Arm for playing', function () {
        GMB.api.resetSystem().then(function (res) {
          if (res && res.ok === false) GMB.toast('Arm refused: ' + (res.error || 'E-stop/invalid config') + '.', 'warn');
          else { armedHint = false; GMB.toast('Armed — the fretboard can drive the servos.', 'ok'); }
          refresh();
        }).catch(function (e) { GMB.toast('Arm failed: ' + (e && e.message || e), 'error'); });
      }, 'ghost'),
      badge,
      h('span.muted', 'Servos move only while armed. Stand-alone, the motion is simulated.')
    ]);
  }

  function modeBar(p) {
    var modes = availableModes(p);
    if (!modes.some(function (m) { return m.id === mode; })) mode = 'pluck';
    var wrap = h('div.fb-modes');
    modes.forEach(function (m) {
      var b = h('button.fb-mode' + (m.id === mode ? '.active' : ''), {
        type: 'button', title: modeHint(m.id),
        onclick: function () {
          mode = m.id;
          wrap.querySelectorAll('.fb-mode').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
        }
      }, m.label);
      wrap.appendChild(b);
    });
    return h('div.fb-modewrap', [h('span.fb-lbl', 'Play mode'), wrap,
      h('span.muted.fb-modehint', modes.length > 1 ? '' : 'Add a strum servo or damper for more modes.')]);
  }
  function modeHint(id) {
    return {
      pluck: 'Single strike (down-stroke).',
      up: 'Strike with the up-stroke pulse.',
      alternate: 'Alternate down / up strokes on each note.',
      mute: 'Strike, then damp for a short, muted note.'
    }[id] || '';
  }

  // Prominent emergency stop at the top of the main page (kept from the old
  // dashboard): a big STOP that neutralises the servos + flushes the MIDI queue,
  // and a Reset that recovers from an E-stop and re-arms.
  function emergencyStopCard() {
    return h('div.card.panic-card', [
      h('div', [h('h2', 'Arrêt d’urgence'),
        h('p.muted', 'Neutralise les servos (PCA9685 /OE) et vide la file MIDI.')]),
      h('div.panic-actions', [
        h('button.btn.danger.panic-big', { onclick: GMB.doPanic }, 'STOP'),
        GMB.button('Reset & ré-armer', function () {
          GMB.api.resetSystem().then(function (res) {
            if (res && res.ok === false) {
              GMB.toast('Reset refusé : ' + (res.error || 'E-stop actif ou config invalide') + '.', 'warn');
            } else {
              GMB.toast('Reset accepté — ré-armement.', 'ok');
            }
          }).catch(function (e) { GMB.toast('Reset échoué : ' + (e && e.message || e), 'error'); });
        })
      ])
    ]);
  }

  // ---- render / teardown ----------------------------------------------------
  function render(host) {
    // Fresh state for this mount (mode is intentionally preserved).
    held = {}; active = {}; timers = []; armedHint = false; els = null;

    var p = GMB.state.profile;
    var strings = p.strings || [];
    var anyFinger = p.servos.some(function (s) { return s.enabled && s.function === 'finger'; });
    var anyStriker = strings.some(function (_, i) { return !!strikerFor(i); });

    readout = h('span.fb-readout', '—');

    host.appendChild(emergencyStopCard());
    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Fretboard'),
        h('span.muted', 'play the calibrated instrument — press and hold a fret')]),
      h('p.muted', 'Fret spacing follows equal temperament (the neck compresses toward the body like a real ' +
        'fretboard). Each equipped fret shows its finger servo as a pad on the string, just before the fret ' +
        'wire. Press and hold a fret with a servo to press the finger and sound the string; release to lift it. ' +
        'The zone left of the nut plays the open string.'),
      armBar(),
      h('div.fb-controls', [
        modeBar(p),
        h('span.spacer'),
        h('span.fb-nowlabel', 'Now playing'), readout
      ])
    ]));

    if (!strings.length) {
      host.appendChild(h('div.card', [h('div.pill.warn', 'No strings configured yet.'),
        h('p.muted', 'Configure the instrument first (Réglages → Configuration).'),
        h('div.row', [GMB.button('Ouvrir la configuration', function () { if (GMB.openSettings) GMB.openSettings('config'); }, 'primary')])]));
      return;
    }
    if (!anyStriker)
      host.appendChild(h('div.note-box', [
        'None of the strings has a plucker / strum servo yet, so notes cannot sound. ',
        GMB.button('Aller à la calibration', function () { GMB.navigate('calibration'); }, 'ghost')]));
    else if (!anyFinger)
      host.appendChild(h('div.note-box', [
        'No finger servos are equipped — only the open strings can be played. ',
        GMB.button('Aller à la calibration', function () { GMB.navigate('calibration'); }, 'ghost')]));

    // The board itself (scrolls horizontally on narrow screens so tap targets
    // stay usable rather than shrinking to nothing).
    host.appendChild(h('div.card.fb-card', [h('div.fb-scroll', buildBoard(p))]));

    // Legend + safety actions.
    host.appendChild(h('div.card', [
      h('div.fb-legend', [
        legendItem('fb-lg-pad', 'finger servo (equipped fret)'),
        legendItem('fb-lg-geared', 'geared servo (two frets)'),
        legendItem('fb-lg-empty', 'no servo on this fret'),
        legendItem('fb-lg-active', 'active string')
      ]),
      h('div.row', [
        GMB.button('All fingers up', function () { allFingersUp(); }, 'ghost')
      ])
    ]));
  }
  function legendItem(cls, label) {
    return h('span.fb-lg', [h('span.fb-swatch.' + cls), h('span', label)]);
  }

  // Leaving the page (or re-rendering) must never leave a finger pressed or a
  // strike timer pending on the hardware.
  function teardown() {
    timers.forEach(clearTimeout);
    timers = [];
    Object.keys(held).slice().forEach(function (k) { releaseFinger(+k); });
    held = {}; active = {}; els = null; readout = null;
  }

  GMB.views.fretboard = { render: render, teardown: teardown };
})(window);
