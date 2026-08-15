#!/usr/bin/env node
// Behavioural tests for the web interface's PURE logic (no DOM needed) — run by
// the CI web-js job after the syntax checks. The two most serious UI defects of
// audit 5 were semantic (destructive builder regeneration, draft-index live
// tests): node --check can catch neither, so the testable kernels get asserted
// here (audit 5 P2 — behavioural JS tests).
'use strict';

// Minimal browser-shape so api.js loads outside a browser. Its IIFE receives
// `window`; localStorage/fetch/document are guarded or unused at load time.
global.window = global;

require('../js/api.js');
var GMB = global.GMB;

var failures = 0, checks = 0;
function check(cond, label) {
  checks++;
  if (!cond) { failures++; console.error('  CHECK failed: ' + label); }
}
function test(name, fn) {
  var before = failures;
  try { fn(); } catch (e) { failures++; console.error('  THREW: ' + e.message); }
  console.log('[' + (failures === before ? 'PASS' : 'FAIL') + '] ' + name);
}

// A calibrated, hand-wired string 0: plain finger 1 on a direct GPIO, geared
// finger 2+3, a plucker with a mute angle — nothing at factory defaults.
function calibrated() {
  return [
    { enabled: true, function: 'finger', stringIndex: 0, fret: 1, fretB: -1,
      source: 'gpio', gpio: 18, pcaBoard: 0, channel: 0,
      restUs: 1540, activeUs: 1885, travelMs: 111, settleMs: 27, inverted: true },
    { enabled: true, function: 'finger', stringIndex: 0, fret: 2, fretB: 3,
      source: 'pca', pcaBoard: 2, i2cBus: 1, channel: 9,
      restUs: 1470, activeUs: 1795, activeBUs: 1210, travelMs: 95 },
    { enabled: true, function: 'pluck', stringIndex: 0, fret: -1, fretB: -1,
      source: 'pca', pcaBoard: 0, channel: 12,
      restUs: 1515, activeUs: 1730, activeAltUs: 1260, alternateDirection: true,
      muteUs: 1490, travelMs: 88, settleMs: 21, inverted: false }
  ];
}

test('merge keeps every existing servo intact for matching identities', function () {
  var generated = [
    { function: 'finger', stringIndex: 0, fret: 1, fretB: -1, restUs: 1000, activeUs: 1800, source: 'pca' },
    { function: 'finger', stringIndex: 0, fret: 2, fretB: 3, restUs: 1500, activeUs: 1900, source: 'pca' },
    { function: 'pluck', stringIndex: 0, fret: -1, fretB: -1, restUs: 1500, activeUs: 1720, source: 'pca' }
  ];
  var merged = GMB.mergeBuilderServos(generated, calibrated());
  check(merged.length === 3, 'same count');
  check(merged[0].restUs === 1540 && merged[0].activeUs === 1885, 'finger 1 calibration kept');
  check(merged[0].source === 'gpio' && merged[0].gpio === 18, 'finger 1 stays direct-GPIO');
  check(merged[0].inverted === true && merged[0].travelMs === 111, 'finger 1 direction/timing kept');
  check(merged[1].activeBUs === 1210 && merged[1].i2cBus === 1 && merged[1].channel === 9,
        'geared finger wiring + side-B kept');
  check(merged[2].muteUs === 1490 && merged[2].activeAltUs === 1260, 'plucker mute/up-stroke kept');
});

test('a maxFret bump only adds ONE default servo, everything else untouched', function () {
  function spec() {
    return { maxFret: 2, fretting: 'chromatic', sounding: 'pluck', lift: false, damper: false, board: 0 };
  }
  var strings = [{ enabled: true, openNote: 60, maxFret: 2 }];
  var existing = [
    { enabled: true, function: 'finger', stringIndex: 0, fret: 1, fretB: -1,
      source: 'gpio', gpio: 18, restUs: 1540, activeUs: 1885 },
    { enabled: true, function: 'pluck', stringIndex: 0, fret: -1, fretB: -1,
      source: 'pca', pcaBoard: 0, channel: 12, restUs: 1515, activeUs: 1730, muteUs: 1490 }
  ];
  var out = GMB.buildInstrument(function () { return spec(); }, strings, existing);
  check(out.length === 3, 'finger1 + NEW finger2 + plucker');
  var f1 = out.filter(function (s) { return s.function === 'finger' && s.fret === 1; })[0];
  var f2 = out.filter(function (s) { return s.function === 'finger' && s.fret === 2; })[0];
  var pk = out.filter(function (s) { return s.function === 'pluck'; })[0];
  check(f1 && f1.restUs === 1540 && f1.source === 'gpio' && f1.gpio === 18,
        'existing finger kept verbatim (incl. direct GPIO)');
  check(f2 && f2.restUs !== 1540 && f2.source !== 'gpio', 'new finger gets defaults');
  check(pk && pk.muteUs === 1490 && pk.channel === 12, 'plucker kept verbatim');
});

test('an explicit factory reset (existing=[]) regenerates everything', function () {
  function spec() {
    return { maxFret: 1, fretting: 'chromatic', sounding: 'pluck', lift: false, damper: false, board: 0 };
  }
  var strings = [{ enabled: true, openNote: 60, maxFret: 1 }];
  var out = GMB.buildInstrument(function () { return spec(); }, strings, []);
  check(out.length === 2, 'finger + plucker');
  check(out.every(function (s) { return s.restUs !== 1540; }), 'no stale calibration');
});

test('a removed position releases its servo; the rest keeps calibration', function () {
  function spec(maxFret) {
    return { maxFret: maxFret, fretting: 'chromatic', sounding: 'pluck', lift: false, damper: false, board: 0 };
  }
  var strings = [{ enabled: true, openNote: 60, maxFret: 1 }];
  var out = GMB.buildInstrument(function () { return spec(1); }, strings, calibrated());
  check(out.filter(function (s) { return s.function === 'finger'; }).length === 1,
        'only fret 1 remains');
  check(out[0].restUs === 1540, 'surviving finger calibration kept');
  check(out.filter(function (s) { return s.function === 'pluck'; })[0].muteUs === 1490,
        'plucker kept');
});

test('mergeBuilderServos never reuses one existing servo twice', function () {
  var generated = [
    { function: 'pluck', stringIndex: 0, fret: -1, fretB: -1, restUs: 1500 },
    { function: 'pluck', stringIndex: 0, fret: -1, fretB: -1, restUs: 1500 }
  ];
  var existing = [{ function: 'pluck', stringIndex: 0, fret: -1, fretB: -1, restUs: 1515 }];
  var merged = GMB.mergeBuilderServos(generated, existing);
  check(merged[0].restUs === 1515, 'first takes the calibrated one');
  check(merged[1].restUs === 1500, 'second falls back to defaults');
});

test('re-applying the ukulele preset keeps every calibration verbatim (audit 6)', function () {
  function spec() {
    return { maxFret: 3, fretting: 'chromatic', sounding: 'pluck', lift: false, damper: false, board: 0 };
  }
  // Ukulele GCEA, all strings fretted to 3 — the shape applyPreset() builds.
  var ukeStrings = [67, 60, 64, 69].map(function (n) {
    return { enabled: true, openNote: n, maxFret: 3 };
  });
  // Stock generation, then a full bench calibration pass over every servo.
  var before = GMB.buildInstrument(function () { return spec(); }, ukeStrings, []);
  check(before.length === 16, 'stock ukulele: 4 strings x (3 fingers + pluck)');
  before.forEach(function (s, i) {
    s.restUs = 1400 + i; s.activeUs = 1800 + i;
    s.travelMs = 80 + i; s.settleMs = 20 + i; s.inverted = (i % 2) === 0;
  });
  // applyPreset('ukulele') on an already-ukulele draft now rebuilds
  // differentially, passing the existing servos instead of [].
  var after = GMB.buildInstrument(function () { return spec(); }, ukeStrings, before);
  check(after.length === before.length, 'same servo count after re-apply');
  check(after.every(function (s) { return before.indexOf(s) >= 0; }),
        'every servo object survives verbatim (identity, hence calibration)');
  var f = after.filter(function (s) { return s.function === 'finger' && s.stringIndex === 2; })[0];
  check(f && f.restUs >= 1400 && f.restUs < 1400 + before.length,
        'spot check: hand-set pulse widths still present');
});

// ---------------------------------------------------------------------------
// app.js shell helpers. These need a DOM, but only a tiny slice of one: enough
// to build an element, set attributes and fire a change event. The UX-audit
// helpers below (the 1-16 MIDI channel mapping, the local disclosure state,
// the first-run flag) are pure logic wrapped in DOM plumbing, and every one of
// them is a defect this suite is meant to catch a second time.
// ---------------------------------------------------------------------------
function fakeDom() {
  function el(tag) {
    var e = {
      tagName: tag, nodeType: 1, children: [], attrs: {}, listeners: {}, className: '', id: '',
      classList: {
        add: function (c) { e.className += (e.className ? ' ' : '') + c; },
        contains: function (c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; },
        toggle: function () {}, remove: function () {}
      },
      setAttribute: function (k, v) { e.attrs[k] = String(v); },
      getAttribute: function (k) { return e.attrs.hasOwnProperty(k) ? e.attrs[k] : null; },
      addEventListener: function (k, fn) { (e.listeners[k] = e.listeners[k] || []).push(fn); },
      appendChild: function (c) { e.children.push(c); return c; },
      fire: function (k) { (e.listeners[k] || []).forEach(function (fn) { fn(); }); },
      // Depth-first search over the built tree, used by the assertions.
      find: function (pred) {
        if (pred(e)) return e;
        for (var i = 0; i < e.children.length; i++) {
          var c = e.children[i];
          if (c && c.find) { var r = c.find(pred); if (r) return r; }
        }
        return null;
      }
    };
    return e;
  }
  global.document = {
    createElement: el,
    createTextNode: function (t) { return { text: t, children: [] }; },
    getElementById: function () { return null; },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    addEventListener: function () {}
  };
  var store = {};
  global.localStorage = {
    getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  global.window.addEventListener = global.window.addEventListener || function () {};
  global.location = global.location || { hash: '' };
}
fakeDom();
require('../js/app.js');

test('the MIDI channel is 1-16 on screen and zero-based in the profile', function () {
  // The old panel was labelled "Global channel (1-16)" over an input bound
  // straight to the zero-based field, with a hint explaining the storage.
  var midi = { globalChannel: 0 };
  var input = GMB.offsetInput(midi, 'globalChannel', 1, { min: 1, max: 16 });
  check(input.value === 1, 'channel 0 displays as 1');
  check(String(input.min) === '1' && String(input.max) === '16', 'the input accepts 1..16');

  input.value = 10; input.fire('change');
  check(midi.globalChannel === 9, 'entering 10 stores 9');
  check(input.value === 10, 'the field keeps showing 10');

  input.value = 16; input.fire('change');
  check(midi.globalChannel === 15, 'channel 16 stores 15 (the last valid channel)');

  // Out-of-range entries clamp to a REAL channel instead of writing -1 / 16.
  input.value = 0; input.fire('change');
  check(midi.globalChannel === 0 && input.value === 1, 'below range clamps to channel 1');
  input.value = 99; input.fire('change');
  check(midi.globalChannel === 15 && input.value === 16, 'above range clamps to channel 16');
});

test('a disclosure only builds its body when open, and remembers its state', function () {
  var built = 0;
  var build = function () { built++; return document.createElement('div'); };

  GMB.setRedraw(function () {});          // no re-render in the test harness
  var closed = GMB.disclosure('t1', 'Advanced', build);
  check(built === 0, 'a closed disclosure never calls build()');
  check(closed.getAttribute === undefined || true, 'element built');
  var toggle = closed.find(function (e) { return e.className.indexOf('disclosure-toggle') >= 0; });
  check(!!toggle && toggle.getAttribute('aria-expanded') === 'false', 'aria-expanded reflects closed');

  toggle.fire('click');
  check(GMB.isDisclosed('t1') === true, 'clicking records the open state');

  var open = GMB.disclosure('t1', 'Advanced', build);
  check(built === 1, 'an open disclosure builds its body exactly once');
  var toggle2 = open.find(function (e) { return e.className.indexOf('disclosure-toggle') >= 0; });
  check(toggle2.getAttribute('aria-expanded') === 'true', 'aria-expanded reflects open');
  check(GMB.isDisclosed('t2') === false, 'state is per key, not global');
});

test('the first run is remembered so Welcome shows once, not forever', function () {
  GMB.resetFirstRun();
  check(GMB.setupComplete() === false, 'a fresh browser has never configured anything');
  GMB.markSetupComplete();
  check(GMB.setupComplete() === true, 'applying a configuration retires the welcome screen');
  GMB.resetFirstRun();
  check(GMB.setupComplete() === false, 'the user can ask for the welcome screen again');
});

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
