/*
 * commissioning.js — "Commissioning" sub-tab of the Wiring & GPIO page.
 *
 * The staged electrical acceptance procedure of hardware/COMMISSIONING.md as a
 * live checklist: each stage has a gate — do not power the next stage until
 * every box of the current one holds. Progress is kept in localStorage per
 * instrument (bench state, not configuration), so it survives reloads without
 * touching the profile. The full procedure, with the measurements to record,
 * stays in hardware/COMMISSIONING.md.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var STAGES = [
    { id: 's0', title: 'Stage 0 — visual & mechanical (all supplies OFF)', items: [
      'Every servo lead, power branch and the I²C harness routed and strain-relieved; connectors latched',
      'PCA9685 A0–A2 jumpers match the I²C & PCA tab (bus + address per board)',
      'Branch fuses F1…Fn and the main fuse F0 installed at their rated values',
      'E-stop button mounted, reachable, latched released',
      'No string under tension yet'
    ] },
    { id: 's1', title: 'Stage 1 — continuity & shorts (all supplies OFF)', items: [
      'All grounds (ESP32, PCA boards, PSU, distribution block) are one net',
      'No continuity +V_SERVO↔GND, 3V3↔GND, +V_SERVO↔3V3',
      'E-stop chain: every NC contact closed when released, open when pressed',
      '/OE bus continuous to every board’s /OE pin; pull-up to 3.3 V present'
    ] },
    { id: 's2', title: 'Stage 2 — logic only (USB in, servo PSU OFF)', items: [
      'ESP32-S3 boots, web UI reachable, profile loaded',
      'GPIO validation shows no errors (SDA/SCL per used bus, /OE, ESTOP)',
      'Profile loaded but NOT armed → /OE bus measures HIGH (≈3.3 V)',
      'E-stop press shows EmergencyStop in the UI; release + Reset clears it',
      'NC wiring: unplugging the chain connector also reads STOP (fail-safe check)',
      'Every configured PCA answers at its (bus, address) on an arming attempt'
    ] },
    { id: 's3', title: 'Stage 3 — servo rail on, outputs disabled (do not arm)', items: [
      'Rail voltage correct at the distribution block and at EACH branch',
      '/OE still HIGH — no servo twitches at power-on',
      'Idle current plausible (boards’ quiescent draw only)',
      'E-stop press drops the contactor: 0 V on every branch'
    ] },
    { id: 's4', title: 'Stage 4 — first motion, one servo (strings off)', items: [
      'Arm from the UI (profile valid → Parking → Ready)',
      'One finger servo moves correctly (direction, travel, rest)',
      'E-stop during motion stops it instantly; Reset + re-arm works after',
      'Same E-stop test on a direct-GPIO servo, if any (only the power cut stops it)'
    ] },
    { id: 's5', title: 'Stage 5 — per-branch bring-up', items: [
      'Every servo of each branch reaches rest and press/pluck positions',
      'Branch current at worst realistic case within its fuse’s continuous rating',
      'Branch voltage sag during the peak < ~5% (else: bigger cap, thicker wiring, lower per-board cap)'
    ] },
    { id: 's6', title: 'Stage 6 — whole instrument', items: [
      'Full-instrument stress pattern: PSU current + sag within spec, nothing overheating',
      'Wi-Fi loss during play releases the notes, instrument stays armed',
      'One PCA unplugged during play degrades only its strings (readyDegraded)',
      'E-stop at full load: instant, complete stop; recovery = release + reset + re-arm',
      'Only now: string the instrument and repeat the motion checks at low velocity'
    ] }
  ];

  function storeKey() {
    var p = GMB.state.profile;
    var name = (p && p.instrument && p.instrument.name) || 'instrument';
    return 'gmb.commissioning.' + (GMB.slug ? GMB.slug(name) : name);
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(storeKey())) || {}; }
    catch (e) { return {}; }
  }
  function save(state) {
    try { localStorage.setItem(storeKey(), JSON.stringify(state)); } catch (e) {}
  }

  function render(host) {
    var state = load();
    var total = 0, done = 0;
    STAGES.forEach(function (st) {
      st.items.forEach(function (_, i) { total++; if (state[st.id + ':' + i]) done++; });
    });

    var pct = total ? Math.round(done / total * 100) : 0;
    host.appendChild(h('div.card', [
      h('div.card-head', [h('h2', 'Commissioning'),
        h('span.muted', 'staged power-up — full procedure: hardware/COMMISSIONING.md')]),
      h('p.muted', 'Each stage is a GATE: do not pass it until every check holds. Progress is stored in this ' +
        'browser per instrument (bench state, not part of the profile). Record the measured currents, sags and ' +
        'fitted values with the machine as the doc asks.'),
      h('div.cap-line', [
        h('span.cap-label', 'Progress'),
        h('div.cap-bar', h('span', { style: 'width:' + pct + '%' })),
        h('span.cap-val', done + ' / ' + total)
      ]),
      h('div.row', [GMB.button('Reset checklist', function () {
        if (!global.confirm('Clear the commissioning progress for this instrument?')) return;
        save({}); GMB.render();
      }, 'ghost')])
    ]));

    var reached = true;   // stages after an incomplete one are truly gated
    STAGES.forEach(function (st) {
      var stDone = st.items.every(function (_, i) { return !!state[st.id + ':' + i]; });
      // A gate really gates (audit P2): a blocked stage's boxes are DISABLED, not
      // just dimmed — out-of-order ticking needs the explicit per-stage override.
      var overridden = !!state['override:' + st.id];
      var unlocked = reached || overridden;
      var status = stDone ? h('span.pill.mini.ok', 'gate passed')
        : (reached ? h('span.pill.mini.warn', 'in progress')
           : (overridden ? h('span.pill.mini.warn', 'unlocked out of order')
                         : h('span.muted', 'blocked by the previous gate')));
      var kids = [h('div.card-head', [h('h3', st.title), status])];
      st.items.forEach(function (item, i) {
        var key = st.id + ':' + i;
        var cb = h('input', { type: 'checkbox', checked: !!state[key], disabled: !unlocked });
        cb.addEventListener('change', function () {
          state[key] = cb.checked; save(state); GMB.render();
        });
        kids.push(h('label.inline.ps-decl', [cb, h('span', item)]));
      });
      if (!unlocked) {
        kids.push(h('div.row', [
          GMB.button('Unlock this stage anyway', function () {
            state['override:' + st.id] = true; save(state); GMB.render();
          }, 'ghost'),
          h('span.muted', 'Only for a deliberate out-of-order check — the previous gate is not passed.')
        ]));
      }
      host.appendChild(h('div.card' + (unlocked ? '' : '.commissioning-blocked'), kids));
      if (!stDone) reached = false;
    });
  }

  GMB.views.commissioning = { render: render };
})(window);
