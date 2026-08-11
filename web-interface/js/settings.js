/*
 * settings.js — the consolidated Settings modal (gear button, top-right).
 *
 * UI redesign: the three main pages a player needs (Instrument, Calibration,
 * Câblage & GPIO) stay in the nav; EVERYTHING else a user configures lives here,
 * behind four tabs:
 *
 *   • Configuration — the instrument-configuration wizard (all its pages:
 *                     Instrument → MIDI → Alimentation → Validation), hosted via
 *                     GMB.renderConfigWizard. This is the "wizard config instrument"
 *                     with every page reachable, not just the first.
 *   • Réseau        — network mode, SSIDs, hostname, Wi-Fi credentials (write-only)
 *                     and the on-demand hotspot switch.
 *   • Profils       — saved device profile slots (load / copy / rename / export…).
 *   • Avancé        — GMB identity & capabilities (SysEx) + the live MIDI monitor
 *                     and integrated tester.
 *
 * The Simplified / Advanced toggle is mirrored in the footer because the overlay
 * covers the sidebar. Tabs that own a live socket (Advanced, and the config
 * wizard's MIDI step) are torn down on every tab switch and on close.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var overlay = null;
  var activeTab = 'config';
  var wifi = { stationPassword: '', apPassword: '' };

  var TABS = [
    { id: 'config',   label: 'Configuration' },
    { id: 'network',  label: 'Réseau' },
    { id: 'profiles', label: 'Profils' },
    { id: 'advanced', label: 'Avancé' }
  ];

  function section(title, children, hint) {
    return h('div.settings-section', [
      h('h3', title), hint ? h('p.muted', hint) : null, children
    ]);
  }

  // ---- shell ----------------------------------------------------------------
  function build() {
    var panel = h('div.settings-panel', { onclick: function (e) { e.stopPropagation(); } }, [
      h('div.settings-head', [
        h('div.settings-head-top', [
          h('h2', 'Réglages'),
          h('button.settings-close', { type: 'button', title: 'Fermer', onclick: close }, '×')
        ]),
        h('div.settings-tabs', TABS.map(function (t) {
          return h('button.settings-tab' + (t.id === activeTab ? '.active' : ''),
            { type: 'button', onclick: function () { switchTab(t.id); } }, t.label);
        }))
      ]),
      h('div.settings-body', { id: 'settings-body' }),
      h('div.settings-actions', [
        modeToggle(),
        h('span.muted', GMB.api.mock ? 'Démo / backend simulé' : ''),
        h('span.spacer'),
        GMB.button('Fermer', close, 'ghost'),
        GMB.button('Enregistrer & publier', save, 'primary')
      ])
    ]);

    overlay = h('div.settings-overlay', { onclick: close }, [panel]);
    document.body.appendChild(overlay);
    drawTab();
  }

  // Simplified / Advanced mirror (the sidebar toggle is hidden behind the modal).
  function modeToggle() {
    var mode = GMB.state.mode;
    return h('div.mode-toggle.mini', [
      h('button' + (mode === 'simplified' ? '.active' : ''),
        { type: 'button', onclick: function () { setMode('simplified'); } }, 'Simplifié'),
      h('button' + (mode === 'advanced' ? '.active' : ''),
        { type: 'button', onclick: function () { setMode('advanced'); } }, 'Avancé')
    ]);
  }
  function setMode(m) {
    if (GMB.state.mode === m) return;
    GMB.setMode(m);   // updates body[data-mode], sidebar toggle, re-renders the page
    rebuild();        // re-render the modal so mode-gated fields appear/disappear
  }

  function drawTab() {
    var body = document.getElementById('settings-body');
    if (!body) return;
    teardownTab();
    body.innerHTML = '';
    if (activeTab === 'config') GMB.renderConfigWizard(body);
    else if (activeTab === 'network') networkTab(body);
    else if (activeTab === 'profiles') { if (GMB.views.profiles) GMB.views.profiles.render(body); }
    else if (activeTab === 'advanced') advancedTab(body);
  }

  function switchTab(id) {
    if (id === activeTab) return;
    teardownTab();
    activeTab = id;
    if (overlay) overlay.querySelectorAll('.settings-tab').forEach(function (b, i) {
      b.classList.toggle('active', TABS[i] && TABS[i].id === id);
    });
    drawTab();
  }

  // Rebuild the whole panel, preserving the active tab and the open state.
  function rebuild() {
    var wasOpen = overlay && overlay.classList.contains('open');
    teardownTab();
    if (overlay) overlay.remove();
    build();
    if (wasOpen && overlay) overlay.classList.add('open');
  }

  // Release anything live a tab may hold (MIDI socket, running test sequence).
  function teardownTab() {
    if (GMB.midiSettings && GMB.midiSettings.teardown) GMB.midiSettings.teardown();
    if (GMB.views.midi && GMB.views.midi.teardown) GMB.views.midi.teardown();
    if (GMB.configWizard && GMB.configWizard.teardown) GMB.configWizard.teardown();
    if (GMB.testRunner && GMB.testRunner.stop) GMB.testRunner.stop();
  }

  // ---- Réseau tab -----------------------------------------------------------
  function networkTab(host) {
    var net = GMB.state.profile.network;

    host.appendChild(section('Réseau', h('div.form-grid', [
      GMB.field('Mode', GMB.input(net, 'mode', {
        type: 'select',
        options: [{ value: 'accessPoint', label: 'Point d’accès (hotspot)' },
                  { value: 'station', label: 'Client Wi-Fi' }],
        onChange: drawTab
      })),
      GMB.field('SSID du point d’accès', GMB.input(net, 'apSsid')),
      net.mode === 'station' ? GMB.field('SSID (station)', GMB.input(net, 'ssid')) : null,
      GMB.field('Nom d’hôte', GMB.input(net, 'hostname'))
    ]), 'Les changements réseau s’appliquent après un redémarrage. Utilisez « Démarrer le hotspot » pour basculer immédiatement en point d’accès.'));

    host.appendChild(section('Identifiants Wi-Fi', h('div.form-grid', [
      net.mode === 'station'
        ? GMB.field('Mot de passe station', GMB.input(wifi, 'stationPassword', { type: 'password' }))
        : null,
      GMB.field('Mot de passe point d’accès', GMB.input(wifi, 'apPassword', { type: 'password' }))
    ]), 'En écriture seule — jamais affichés ni exportés. Laisser vide pour ne pas changer. Appliqués après redémarrage.'));

    host.appendChild(section('Hotspot', h('div.toolbar', [
      GMB.button('Démarrer le hotspot maintenant', startHotspot, 'ghost')
    ]), 'Bascule immédiatement en point d’accès avec portail captif : rejoindre le Wi-Fi de l’appareil ouvre cette page. Aussi disponible en maintenant le bouton BOOT ~2 s.'));
  }

  // ---- Avancé tab -----------------------------------------------------------
  function advancedTab(host) {
    host.appendChild(h('div.note-box',
      'Outils avancés. Identité & capacités GMB (SysEx), moniteur MIDI temps réel et ' +
      'testeur intégré. Basculez en mode « Avancé » ci-dessous pour les options détaillées.'));
    if (GMB.views.sysex && GMB.views.sysex.render) GMB.views.sysex.render(host);
    if (GMB.midiSettings && GMB.midiSettings.tools) GMB.midiSettings.tools(host);
  }

  // ---- open / close ---------------------------------------------------------
  function open(tab) {
    if (!GMB.state.profile) { GMB.toast('Configuration en cours de chargement…', 'warn'); return; }
    activeTab = (tab && TABS.some(function (t) { return t.id === tab; })) ? tab : 'config';
    if (overlay) overlay.remove();
    build();
    // rAF so the .open transition runs from the hidden state.
    requestAnimationFrame(function () { if (overlay) overlay.classList.add('open'); });
    document.addEventListener('keydown', onKey);
  }
  GMB.openSettings = open;

  function close() {
    document.removeEventListener('keydown', onKey);
    teardownTab();
    if (overlay) {
      var o = overlay;
      o.classList.remove('open');
      overlay = null;
      setTimeout(function () { o.remove(); }, 200);
    }
    // Refresh the underlying page so config changes show, and reset the wizard's
    // current-flow tracking to whatever page is now visible.
    if (GMB.render) GMB.render();
  }
  GMB.closeSettings = close;

  function onKey(e) { if (e.key === 'Escape') close(); }

  // ---- save -----------------------------------------------------------------
  function save() {
    function saveDraft() {
      // saveProfile() toasts 422 issues and only clears dirty on success; the modal
      // stays open so a rejected save can be fixed in place.
      GMB.saveProfile();
    }
    if (wifi.stationPassword || wifi.apPassword) {
      GMB.api.setWifi({ stationPassword: wifi.stationPassword, apPassword: wifi.apPassword })
        .then(function () {
          wifi.stationPassword = ''; wifi.apPassword = '';
          GMB.toast('Identifiants Wi-Fi enregistrés (redémarrer pour appliquer).', 'ok');
          saveDraft();
        })
        .catch(function (e) { GMB.toast('Échec Wi-Fi : ' + (e && e.message || e), 'error'); });
    } else {
      saveDraft();
    }
  }

  function startHotspot() {
    if (!confirm('Basculer vers le hotspot Wi-Fi (point d’accès) maintenant ?\n\nSi vous êtes connecté en Wi-Fi vous serez déconnecté — rejoignez le réseau de l’appareil (la page de config s’ouvre automatiquement).')) return;
    GMB.api.startHotspot().then(function (r) {
      GMB.toast((r && r.note) || 'Hotspot en démarrage…', 'warn');
    }).catch(function (e) { GMB.toast('Échec de la demande hotspot : ' + (e && e.message || e), 'error'); });
  }

  GMB.views = GMB.views || {};
})(window);
