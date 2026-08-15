/*
 * hardware.js — the "Wiring" page.
 *
 * The harness is GENERATED, not configured (UX audit 8): the software already
 * knows every servo, board, bus and channel, so this page's job is to SHOW the
 * result and to walk the first power-up — not to ask questions.
 *
 *   • Harness       — the adaptive ESP32 + PCA9685 harness diagram (wiring.js)
 *   • Commissioning — the staged power-up checklist (commissioning.js)
 *
 * The specialised integration tools — power & safety dossier, I²C addressing and
 * pull-up sizing, the GPIO grid — are still there in full, but under
 * ⚙ → Advanced hardware: they are diagnostic and integration work, not a step in
 * building an instrument (UX audit 9, 10).
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var sub = 'wiring';   // 'wiring' | 'commissioning'
  var SUBS = [
    { id: 'wiring', label: 'Diagram' },
    { id: 'commissioning', label: 'Commissioning' }
  ];

  function subBtn(t) {
    var on = sub === t.id;
    return h('button.subtab' + (on ? '.active' : ''),
      { type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        onclick: function () { sub = t.id; GMB.render(); } }, t.label);
  }

  function render(host) {
    host.appendChild(h('div.card.hw-head', [
      h('div.card-head', [h('h2', 'Wiring'),
        h('span.muted', 'generated from your instrument')]),
      h('div.subtabs', { role: 'tablist', 'aria-label': 'Wiring sections' }, SUBS.map(subBtn)),
      h('div.row', [
        h('span.muted', 'Addressing, pull-ups, GPIO assignment and the power dossier ' +
          'live in the advanced hardware settings.'),
        GMB.button('Advanced hardware…', function () {
          if (GMB.openSettings) GMB.openSettings('hardware');
        }, 'ghost')
      ])
    ]));

    // Each sub-view renders into its own section (a fresh element every switch).
    var section = h('div.hw-section');
    host.appendChild(section);
    if (sub === 'commissioning') GMB.views.commissioning.render(section);
    else GMB.views.wiring.render(section);
  }

  // Let other views land on a specific sub-tab (the Finish step points at the
  // commissioning checklist once the instrument has been applied).
  GMB.openHardwareSub = function (id) {
    if (SUBS.some(function (t) { return t.id === id; })) { sub = id; GMB.render(); }
  };

  GMB.views.hardware = { render: render };
})(window);
