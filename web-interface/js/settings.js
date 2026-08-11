/*
 * settings.js — the device Settings modal (gear button, top-right).
 *
 * UI redesign: the WHOLE instrument creation now lives on the Setup main page
 * (one ordered flow), so this modal holds only what belongs to the device rather
 * than the instrument, behind two tabs:
 *
 *   • Network  — network mode, SSIDs, hostname, Wi-Fi credentials (write-only)
 *                and the on-demand hotspot switch.
 *   • Advanced — GMB identity & capabilities (SysEx) + the live MIDI monitor
 *                and integrated tester (diagnostics).
 *
 * Profiles are intentionally not exposed here (a hidden, non-user setting). The
 * Simplified / Advanced toggle is mirrored in the footer because the overlay
 * covers the sidebar. The Advanced tab owns a live MIDI socket, torn down on
 * every tab switch and on close.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var overlay = null;
  var activeTab = 'network';
  var wifi = { stationPassword: '', apPassword: '' };

  var TABS = [
    { id: 'network',  label: 'Network' },
    { id: 'advanced', label: 'Advanced' }
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
          h('h2', 'Settings'),
          h('button.settings-close', { type: 'button', title: 'Close', onclick: close }, '×')
        ]),
        h('div.settings-tabs', TABS.map(function (t) {
          return h('button.settings-tab' + (t.id === activeTab ? '.active' : ''),
            { type: 'button', onclick: function () { switchTab(t.id); } }, t.label);
        }))
      ]),
      h('div.settings-body', { id: 'settings-body' }),
      h('div.settings-actions', [
        modeToggle(),
        h('span.muted', GMB.api.mock ? 'Demo / mock backend' : ''),
        h('span.spacer'),
        GMB.button('Close', close, 'ghost'),
        GMB.button('Save & publish', save, 'primary')
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
        { type: 'button', onclick: function () { setMode('simplified'); } }, 'Simplified'),
      h('button' + (mode === 'advanced' ? '.active' : ''),
        { type: 'button', onclick: function () { setMode('advanced'); } }, 'Advanced')
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
    if (activeTab === 'advanced') advancedTab(body);
    else networkTab(body);
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
    if (GMB.testRunner && GMB.testRunner.stop) GMB.testRunner.stop();
  }

  // ---- Network tab ----------------------------------------------------------
  function networkTab(host) {
    var net = GMB.state.profile.network;

    host.appendChild(section('Network', h('div.form-grid', [
      GMB.field('Mode', GMB.input(net, 'mode', {
        type: 'select',
        options: [{ value: 'accessPoint', label: 'Access point (hotspot)' },
                  { value: 'station', label: 'Wi-Fi client' }],
        onChange: drawTab
      })),
      GMB.field('Access-point SSID', GMB.input(net, 'apSsid')),
      net.mode === 'station' ? GMB.field('Station SSID', GMB.input(net, 'ssid')) : null,
      GMB.field('Hostname', GMB.input(net, 'hostname'))
    ]), 'Network changes apply after a reboot. Use “Start hotspot” to switch to the access point immediately.'));

    host.appendChild(section('Wi-Fi credentials', h('div.form-grid', [
      net.mode === 'station'
        ? GMB.field('Station password', GMB.input(wifi, 'stationPassword', { type: 'password' }))
        : null,
      GMB.field('Access-point password', GMB.input(wifi, 'apPassword', { type: 'password' }))
    ]), 'Write-only — never displayed or exported. Leave blank to keep unchanged. Applied after a reboot.'));

    host.appendChild(section('Hotspot', h('div.toolbar', [
      GMB.button('Start hotspot now', startHotspot, 'ghost')
    ]), 'Switch to the access point now with a captive portal: joining the device’s Wi-Fi opens this page. Also available by holding the board BOOT button for ~2 s.'));
  }

  // ---- Advanced tab ---------------------------------------------------------
  function advancedTab(host) {
    host.appendChild(h('div.note-box',
      'Advanced tools. GMB identity & capabilities (SysEx), the live MIDI monitor and the ' +
      'integrated tester. Switch to “Advanced” below for the detailed options.'));
    if (GMB.views.sysex && GMB.views.sysex.render) GMB.views.sysex.render(host);
    if (GMB.midiSettings && GMB.midiSettings.tools) GMB.midiSettings.tools(host);
  }

  // ---- open / close ---------------------------------------------------------
  function open(tab) {
    if (!GMB.state.profile) { GMB.toast('Configuration still loading…', 'warn'); return; }
    activeTab = (tab && TABS.some(function (t) { return t.id === tab; })) ? tab : 'network';
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
          GMB.toast('Wi-Fi credentials stored (reboot to apply).', 'ok');
          saveDraft();
        })
        .catch(function (e) { GMB.toast('Wi-Fi save failed: ' + (e && e.message || e), 'error'); });
    } else {
      saveDraft();
    }
  }

  function startHotspot() {
    if (!confirm('Switch to the Wi-Fi hotspot (access point) now?\n\nIf you are connected over Wi-Fi you will be disconnected — rejoin the device’s network (the config page opens automatically).')) return;
    GMB.api.startHotspot().then(function (r) {
      GMB.toast((r && r.note) || 'Hotspot starting…', 'warn');
    }).catch(function (e) { GMB.toast('Hotspot request failed: ' + (e && e.message || e), 'error'); });
  }

  GMB.views = GMB.views || {};
})(window);
