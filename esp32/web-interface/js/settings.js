/*
 * settings.js — consolidated Settings modal (gear button in the top bar).
 *
 * Ported in spirit from Servo-Flute-GMB's settings overlay: one place for the
 * scattered device / network / Wi-Fi options, plus a "Start hotspot" button that
 * switches the device to its access point + captive portal on demand (mirroring
 * the hardware BOOT-button hotspot). Network + device fields edit the working
 * draft and are saved atomically; Wi-Fi passwords are write-only (POST /api/wifi).
 * Both take effect after a reboot — the hotspot button switches immediately.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var overlay = null;
  var wifi = { stationPassword: '', apPassword: '' };

  function section(title, children, hint) {
    return h('div.settings-section', [
      h('h3', title), hint ? h('p.muted', hint) : null, children
    ]);
  }

  function build() {
    var p = GMB.state.profile;
    var net = p.network, inst = p.instrument, midi = p.midi;

    var panel = h('div.settings-panel', { onclick: function (e) { e.stopPropagation(); } }, [
      h('div.settings-head', [
        h('h2', 'Settings'),
        h('button.settings-close', { type: 'button', title: 'Close', onclick: close }, '×')
      ]),

      section('Device', h('div.form-grid', [
        GMB.field('Instrument name', GMB.input(inst, 'name')),
        GMB.field('MIDI channel', GMB.input(midi, 'globalChannel',
          { type: 'number', min: 0, max: 15, disabled: !!midi.omni })),
        GMB.field('Omni (all channels)', GMB.input(midi, 'omni',
          { type: 'checkbox', onChange: rebuild }))
      ])),

      section('Network', h('div.form-grid', [
        GMB.field('Mode', GMB.input(net, 'mode', {
          type: 'select',
          options: [{ value: 'accessPoint', label: 'Access point (hotspot)' },
                    { value: 'station', label: 'Wi-Fi client' }],
          onChange: rebuild
        })),
        GMB.field('Access-point SSID', GMB.input(net, 'apSsid')),
        net.mode === 'station' ? GMB.field('Station SSID', GMB.input(net, 'ssid')) : null,
        GMB.field('Hostname', GMB.input(net, 'hostname'))
      ]), 'Network changes apply after a reboot. Use “Start hotspot” below to switch to the access point immediately.'),

      section('Wi-Fi credentials', h('div.form-grid', [
        net.mode === 'station'
          ? GMB.field('Station password', GMB.input(wifi, 'stationPassword', { type: 'password' }))
          : null,
        GMB.field('Access-point password', GMB.input(wifi, 'apPassword', { type: 'password' }))
      ]), 'Write-only — never displayed or exported. Leave blank to keep unchanged. Applied after a reboot.'),

      section('Hotspot', h('div.toolbar', [
        GMB.button('Start hotspot now', startHotspot, 'ghost')
      ]), 'Switch to the access point now and open a captive portal: joining the device’s Wi-Fi auto-opens this page. Also available by holding the board BOOT button for ~2 s.'),

      h('div.settings-actions', [
        h('span.muted', GMB.api.mock ? 'Demo / mock backend' : ''),
        h('span.spacer'),
        GMB.button('Close', close, 'ghost'),
        GMB.button('Save settings', save, 'primary')
      ])
    ]);

    overlay = h('div.settings-overlay', { onclick: close }, [panel]);
    document.body.appendChild(overlay);
  }

  function rebuild() {
    // Re-render the panel so mode-dependent fields (station SSID/password, the
    // omni-disabled channel) appear/disappear immediately. Keeps edits (they live
    // on the draft / the wifi object).
    var wasOpen = overlay && overlay.classList.contains('open');
    if (overlay) overlay.remove();
    build();
    if (wasOpen) overlay.classList.add('open');
  }

  function open() {
    if (!GMB.state.profile) { GMB.toast('Configuration still loading…', 'warn'); return; }
    if (overlay) overlay.remove();
    build();
    // rAF so the .open transition runs from the hidden state.
    requestAnimationFrame(function () { if (overlay) overlay.classList.add('open'); });
    document.addEventListener('keydown', onKey);
  }
  GMB.openSettings = open;

  function close() {
    document.removeEventListener('keydown', onKey);
    if (!overlay) return;
    var o = overlay;
    o.classList.remove('open');
    overlay = null;
    setTimeout(function () { o.remove(); }, 200);
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function save() {
    function saveDraft() {
      // saveProfile() resolves even when the backend rejects the profile (it toasts
      // the 422 issues); it only clears the dirty flag on success. Close the modal
      // only when the save actually took, so a rejected save keeps it open to fix.
      GMB.saveProfile().then(function () { if (!GMB.state.dirty) close(); });
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
