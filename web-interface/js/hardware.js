/*
 * hardware.js — combined "Câblage & GPIO" page (UI redesign).
 *
 * One of the three main pages a builder needs. It hosts, behind two sub-tabs, the
 * two hardware views that used to be separate nav entries:
 *   • Schéma de câblage — the adaptive ESP32-S3 + PCA9685 harness diagram (wiring.js)
 *   • Broches GPIO       — the GPIO pin-assignment grid + validation (pins.js)
 * It simply delegates to GMB.views.wiring / GMB.views.pins, so all the wiring and
 * pin logic stays in those modules; this file only owns the sub-tab switch.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var sub = 'wiring';   // 'wiring' | 'gpio' — persists across renders

  function subBtn(id, label) {
    return h('button.subtab' + (sub === id ? '.active' : ''),
      { type: 'button', onclick: function () { sub = id; GMB.render(); } }, label);
  }

  function render(host) {
    host.appendChild(h('div.card.hw-head', [
      h('div.card-head', [h('h2', 'Câblage & GPIO'),
        h('span.muted', 'schéma du harnais et affectation des broches')]),
      h('div.subtabs', [
        subBtn('wiring', 'Schéma de câblage'),
        subBtn('gpio', 'Broches GPIO')
      ])
    ]));

    // Each sub-view renders into its own section (a fresh element every switch).
    var section = h('div.hw-section');
    host.appendChild(section);
    if (sub === 'gpio') GMB.views.pins.render(section);
    else GMB.views.wiring.render(section);
  }

  GMB.views.hardware = { render: render };
})(window);
