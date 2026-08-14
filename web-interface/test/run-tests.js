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

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
