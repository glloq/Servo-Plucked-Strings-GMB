/*
 * settings.js — the Settings modal (gear button, top-right).
 *
 * Everything the software can decide for the user lives here rather than in the
 * creation flow (UX audit 17), split by WHO needs it instead of by which
 * firmware subsystem owns it:
 *
 *   • Device            — Wi-Fi (one line + "Change network"), device name, hotspot.
 *   • MIDI              — automatic by default; parameters and tablature behind
 *                         disclosures (midiselect.js).
 *   • Advanced hardware — controller board, PCA9685 / I²C topology, GPIO grid,
 *                         power & safety dossier, timing & servo-start governor.
 *   • Security          — admin token, network-MIDI source posture.
 *   • Diagnostics       — live MIDI monitor + integrated note tester.
 *   • Developer         — GMB identity & capabilities (SysEx).
 *
 * SysEx therefore never appears in front of somebody who only wants to build a
 * guitar. The modal is a real dialog: role="dialog", aria-modal, a focus trap and
 * focus restored to the gear button on close.
 */
(function (global) {
  'use strict';
  var GMB = global.GMB, h = GMB.h;

  var overlay = null;
  var lastFocus = null;
  var activeTab = 'device';
  // openNetwork/pickedSsid: the "no password needed" state is only trusted while
  // the SSID field still holds the exact network picked from the scan — a manual
  // edit falls back to "unknown security" and shows the password field again.
  var wifi = { stationPassword: '', apPassword: '', forgetStation: false,
               forgetAp: false, openNetwork: false, pickedSsid: '' };
  // Wi-Fi scan state: null until a scan ran; { scanning, networks } afterwards.
  var scan = null;
  var scanPollTimer = null;
  var changingNetwork = false;   // "Change network" pressed: show the picker

  function openNetworkSelected() {
    var net = GMB.state.profile && GMB.state.profile.network;
    return wifi.openNetwork && net && net.ssid === wifi.pickedSsid;
  }

  var TABS = [
    { id: 'device',     label: 'Device' },
    { id: 'midi',       label: 'MIDI' },
    { id: 'hardware',   label: 'Advanced hardware' },
    { id: 'security',   label: 'Security' },
    { id: 'diagnostics', label: 'Diagnostics' },
    { id: 'developer',  label: 'Developer' }
  ];
  // Retired tab ids still resolve (deep links, docs, the screenshot tool).
  var TAB_ALIASES = { network: 'device', advanced: 'diagnostics', sysex: 'developer' };

  function section(title, children, hint) {
    return h('div.settings-section', [
      h('h3', title), hint ? h('p.muted', hint) : null, children
    ]);
  }

  // ---- shell ----------------------------------------------------------------
  function build() {
    var panel = h('div.settings-panel', {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title',
      onclick: function (e) { e.stopPropagation(); }
    }, [
      h('div.settings-head', [
        h('div.settings-head-top', [
          h('h2#settings-title', 'Settings'),
          h('button.settings-close', { type: 'button', 'aria-label': 'Close settings',
            title: 'Close', onclick: close }, '×')
        ]),
        h('div.settings-tabs', { role: 'tablist', 'aria-label': 'Settings sections' },
          TABS.map(function (t) {
            var on = t.id === activeTab;
            return h('button.settings-tab' + (on ? '.active' : ''),
              { type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
                onclick: function () { switchTab(t.id); } }, t.label);
          }))
      ]),
      h('div.settings-body', { id: 'settings-body' }),
      h('div.settings-actions', [
        h('span.muted', GMB.api.mock ? 'Demo / mock backend' : ''),
        h('span.spacer'),
        GMB.button('Close', close, 'ghost'),
        GMB.button('Save and apply', save, 'primary')
      ])
    ]);

    overlay = h('div.settings-overlay', { onclick: close }, [panel]);
    document.body.appendChild(overlay);
    drawTab();
  }

  function drawTab() {
    var body = document.getElementById('settings-body');
    if (!body) return;
    teardownTab();
    body.innerHTML = '';
    GMB.setRedraw(drawTab);   // disclosures inside a tab redraw the TAB only
    if (activeTab === 'midi') midiTab(body);
    else if (activeTab === 'hardware') hardwareTab(body);
    else if (activeTab === 'security') securityTab(body);
    else if (activeTab === 'diagnostics') diagnosticsTab(body);
    else if (activeTab === 'developer') developerTab(body);
    else deviceTab(body);
  }

  function switchTab(id) {
    if (id === activeTab) return;
    teardownTab();
    activeTab = id;
    if (overlay) overlay.querySelectorAll('.settings-tab').forEach(function (b, i) {
      var on = TABS[i] && TABS[i].id === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    drawTab();
  }

  // Release anything live a tab may hold (MIDI socket, running test sequence,
  // Wi-Fi scan polling).
  function teardownTab() {
    if (GMB.midiSettings && GMB.midiSettings.teardown) GMB.midiSettings.teardown();
    if (GMB.views.midi && GMB.views.midi.teardown) GMB.views.midi.teardown();
    if (GMB.testRunner && GMB.testRunner.stop) GMB.testRunner.stop();
    stopScanPoll();
  }

  // ---- Network tab ----------------------------------------------------------

  // Poll GET /api/wifi/scan while the survey runs, re-rendering the list as
  // results land. The timer dies with the tab/modal (teardownTab/close).
  function pollScan() {
    GMB.api.wifiScan(false).then(function (r) {
      scan = r;
      renderScanList();
      if (r && r.scanning) scanPollTimer = setTimeout(pollScan, 800);
      else scanPollTimer = null;
    }).catch(function () { scanPollTimer = null; });
  }

  function startScan() {
    scan = { scanning: true, networks: (scan && scan.networks) || [] };
    renderScanList();
    GMB.api.wifiScan(true).then(function (r) {
      scan = r;
      renderScanList();
      if (scanPollTimer) clearTimeout(scanPollTimer);
      scanPollTimer = setTimeout(pollScan, 800);
    }).catch(function (e) {
      scan = null;
      renderScanList();
      GMB.toast('Wi-Fi scan failed: ' + (e && e.message || e), 'error');
    });
  }

  function stopScanPoll() {
    if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }
  }

  function renderScanList() {
    var box = document.getElementById('wifi-scan-list');
    if (!box) return;
    box.innerHTML = '';
    if (!scan) return;
    if (scan.scanning) box.appendChild(h('p.muted', 'Scanning…'));
    var nets = scan.networks || [];
    if (!scan.scanning && !nets.length)
      box.appendChild(h('p.muted', 'No network found. Scan again, or type the name by hand.'));
    nets.forEach(function (n) {
      box.appendChild(h('button.btn.ghost.wifi-row',
        { type: 'button', onclick: function () { pickNetwork(n); } }, [
          h('span', n.ssid),
          h('span.muted', ' ' + (n.secure ? '🔒' : 'open') + ' · ' + n.rssi + ' dBm · ch ' + n.channel)
        ]));
    });
  }

  function pickNetwork(entry) {
    var net = GMB.state.profile.network;
    net.mode = 'station';
    net.ssid = entry.ssid;
    wifi.pickedSsid = entry.ssid;
    wifi.openNetwork = !entry.secure;
    if (wifi.openNetwork) wifi.stationPassword = '';  // open: no password to send
    changingNetwork = true;
    GMB.markDirty();
    drawTab();
  }

  // ---- Device tab ------------------------------------------------------------
  // First view: where the device is connected, and how to reach it if that fails.
  // Modes, SSIDs, hostname and credential erasure are a second click away
  // (UX audit 16).
  function deviceTab(host) {
    var p = GMB.state.profile;
    var net = p.network;
    var station = net.mode === 'station';

    var connKids = [
      GMB.summaryLine('Connected to',
        station ? (net.ssid || '(no network chosen)') : ('its own hotspot “' + (net.apSsid || 'GMB') + '”'),
        changingNetwork ? 'Cancel' : 'Change network',
        function () { changingNetwork = !changingNetwork; drawTab(); },
        station ? !!net.ssid : true),
      GMB.summaryLine('Reachable at', (net.hostname || 'gmb') + '.local', null, null, true)
    ];
    host.appendChild(section('Wi-Fi', h('div', connKids),
      'Stored on the device itself (not in the instrument profile), so it survives ' +
      'reboots and profile changes. If a network cannot be joined, the device falls ' +
      'back to its own hotspot.'));

    if (changingNetwork) {
      var pickKids = [
        h('div.toolbar', [
          GMB.button('Scan for networks', startScan, 'primary'),
          GMB.button('Use the device hotspot instead', function () {
            net.mode = 'accessPoint'; GMB.markDirty(); changingNetwork = false; drawTab();
          }, 'ghost')
        ]),
        h('div', { id: 'wifi-scan-list' }),
        GMB.field('…or type the network name', GMB.input(net, 'ssid', {
          // A hand-edited SSID is no longer the scanned (possibly open) network:
          // security becomes unknown again, so the password field comes back.
          onChange: function () {
            net.mode = 'station';
            if (net.ssid !== wifi.pickedSsid) { wifi.openNetwork = false; }
            drawTab();
          }
        }))
      ];
      if (net.mode === 'station') {
        if (openNetworkSelected())
          pickKids.push(h('p.muted', '“' + (net.ssid || '') + '” is an open network — no password needed.'));
        else
          pickKids.push(GMB.field('Wi-Fi password', GMB.input(wifi, 'stationPassword', { type: 'password' }),
            'write-only — never displayed or exported'));
      }
      pickKids.push(h('p.muted', 'Press “Save and apply” below to join.'));
      host.appendChild(section('Choose a network', h('div', pickKids)));
    }

    host.appendChild(section('Fallback hotspot', h('div', [
      GMB.summaryLine('Hotspot name', net.apSsid || 'GMB', null, null, true),
      h('div.toolbar', [GMB.button('Start the hotspot now', startHotspot, 'ghost')]),
      h('p.muted', 'Joining the device’s Wi-Fi opens this page automatically. Also ' +
        'available by holding the board’s BOOT button for ~2 s.')
    ])));

    host.appendChild(GMB.disclosure('net-advanced', 'Advanced network options', function () {
      var credKids = [];
      if (net.mode === 'station') {
        var forget = h('input', { type: 'checkbox', checked: !!wifi.forgetStation });
        forget.addEventListener('change', function () { wifi.forgetStation = forget.checked; });
        credKids.push(h('label.inline.builder-opt', [forget,
          h('span', 'Forget the stored Wi-Fi password')]));
      }
      if (!wifi.forgetAp) {
        credKids.push(GMB.field('Hotspot password', GMB.input(wifi, 'apPassword', { type: 'password' }),
          '8–63 characters (WPA2)'));
      }
      var forgetAp = h('input', { type: 'checkbox', checked: !!wifi.forgetAp });
      forgetAp.addEventListener('change', function () {
        wifi.forgetAp = forgetAp.checked;
        if (wifi.forgetAp) wifi.apPassword = '';
        drawTab();
      });
      credKids.push(h('label.inline.builder-opt', [forgetAp,
        h('span', 'Remove the hotspot password (OPEN access point)')]));

      return [
        h('div.form-grid', [
          GMB.field('Mode', GMB.input(net, 'mode', {
            type: 'select',
            options: [{ value: 'accessPoint', label: 'Access point (hotspot)' },
                      { value: 'station', label: 'Wi-Fi client' }],
            onChange: drawTab
          })),
          GMB.field('Hotspot name (AP SSID)', GMB.input(net, 'apSsid')),
          GMB.field('Device name (hostname)', GMB.input(net, 'hostname'),
            'reachable as <name>.local on the network')
        ]),
        h('h4', 'Stored credentials'),
        h('p.muted', 'Write-only — never displayed or exported. Leave blank to keep ' +
          'unchanged; use “Forget” / “Remove” (or pick an open network) to really erase one.'),
        h('div.form-grid', credKids)
      ];
    }));

    host.appendChild(GMB.disclosure('device-firstrun', 'Re-run the welcome screen', function () {
      return [
        h('p.muted', 'Shows the “create your instrument” screen again the next time ' +
          'this page is opened. Nothing on the device is changed.'),
        h('div.toolbar', [GMB.button('Show the welcome screen again', function () {
          GMB.resetFirstRun();
          GMB.toast('The welcome screen will show on the next reload.', 'ok');
        }, 'ghost')])
      ];
    }));

    renderScanList();
  }

  // ---- MIDI tab --------------------------------------------------------------
  function midiTab(host) {
    if (GMB.midiSettings && GMB.midiSettings.settings) GMB.midiSettings.settings(host);
    else host.appendChild(h('div.note-box', 'MIDI settings module not loaded.'));
  }

  // ---- Advanced hardware tab -------------------------------------------------
  // Everything the generator normally decides: the board, the PCA9685 / I²C
  // topology, the GPIO grid, the power dossier and the timing / governor.
  function hardwareTab(host) {
    host.appendChild(h('div.note-box',
      'Every value here already has a working default derived from your instrument. ' +
      'You only need this page when the hardware differs from the recommended build, ' +
      'or when you are diagnosing a real installation.'));
    if (GMB.hardwarePanels) {
      GMB.hardwarePanels.board(host);
      GMB.hardwarePanels.i2c(host);
      GMB.hardwarePanels.timing(host);
    }
    hwDisclosure(host, 'hw-gpio', 'GPIO pins', GMB.views.pins.render);
    hwDisclosure(host, 'hw-i2c-detail', 'I²C addressing & pull-ups', GMB.views.wiringI2c.render);
    hwDisclosure(host, 'hw-power', 'Power & safety dossier', GMB.views.wiringPower.render);
  }

  // A folded section hosting a whole view module. The box is ATTACHED to the
  // document before the module renders into it: some views (the GPIO grid) look
  // their own sub-elements up by id, which only works once they are in the DOM.
  function hwDisclosure(host, key, label, renderFn) {
    var box = h('div.hw-section');
    host.appendChild(GMB.disclosure(key, label, function () { return box; }));
    if (GMB.isDisclosed(key)) renderFn(box);
  }

  // ---- Diagnostics tab -------------------------------------------------------
  function diagnosticsTab(host) {
    host.appendChild(h('div.note-box',
      'Live view of what the instrument receives and does: the MIDI monitor shows ' +
      'every incoming event with its interpretation, and the tester sends one note ' +
      'through the whole chain.'));
    if (GMB.midiSettings && GMB.midiSettings.tools) GMB.midiSettings.tools(host);
  }

  // ---- Developer tab ---------------------------------------------------------
  function developerTab(host) {
    host.appendChild(h('div.note-box',
      'The instrument’s machine-readable identity: the SysEx capability descriptor a ' +
      'host queries to discover strings, frets, CC numbers and revision. Nothing here ' +
      'is needed to build or play the instrument.'));
    if (GMB.views.sysex && GMB.views.sysex.render) GMB.views.sysex.render(host);
  }

  // ---- Advanced tab ---------------------------------------------------------
  var adminTok = { token: '', confirm: '', current: '' };

  // Re-read the live status and re-render the security section (policy radios,
  // unlock button, protection banner) so a change is visible IMMEDIATELY.
  function refreshSecurity() {
    var sec = document.getElementById('security-section');
    if (!sec) return;
    GMB.api.getStatus().then(function (st) { renderSecurity(sec, st); })
      .catch(function () {});
  }

  function unlockBrowser() {
    if (!adminTok.current) {
      GMB.toast('Enter the current admin token first.', 'warn');
      return;
    }
    GMB.api.unlockAdminToken(adminTok.current)
      .then(function () {
        adminTok.current = '';
        GMB.toast('Token accepted — this browser is now authorised for writes.', 'ok');
        refreshSecurity();
      })
      .catch(function () {
        GMB.toast('Wrong token — the device refused it.', 'error');
      });
  }

  function setAdminToken() {
    if (!adminTok.token || adminTok.token.length < 8) {
      GMB.toast('Admin token must be at least 8 characters.', 'error');
      return;
    }
    if (adminTok.token !== adminTok.confirm) {
      GMB.toast('The two token fields do not match.', 'error');
      return;
    }
    GMB.api.setAdminTokenRemote(adminTok.token)
      .then(function () {
        adminTok.token = ''; adminTok.confirm = '';
        GMB.toast('Admin token set — write API calls now require it (this browser ' +
                  'remembers it).', 'ok');
        drawTab();
      })
      .catch(function (e) {
        GMB.toast('Token change failed: ' + ((e && e.body && e.body.error) ||
                  (e && e.message) || e), 'error');
      });
  }

  // Device security: admin token workflow + UDP MIDI source posture, rendered from
  // the live status (audit 4 P2.2 / P2.3).
  function renderSecurity(box, st) {
    box.innerHTML = '';
    var configured = st ? !!st.authConfigured : null;
    var adminKids = [
      h('p' + (configured === false ? '.warn-text' : '.muted'),
        configured === null ? 'Protection: …'
          : configured ? 'Protection: configured — write API calls require the admin token.'
                       : 'Protection: NOT configured — anyone reaching this page can ' +
                         'change settings. Set a token before joining a shared network.')
    ];
    if (configured) {
      // A NEW browser that KNOWS the token must be able to authorise itself
      // without changing the device's token (audit 5): verify via
      // /api/auth/check, then remember it locally.
      adminKids.push(GMB.field('Current admin token',
        GMB.input(adminTok, 'current', { type: 'password' }),
        'authorise THIS browser with the existing token'));
      adminKids.push(h('div.toolbar', [GMB.button('Unlock this browser', unlockBrowser, 'primary')]));
    }
    adminKids.push(GMB.field(configured ? 'New admin token' : 'Admin token',
      GMB.input(adminTok, 'token', { type: 'password' }), 'at least 8 characters'));
    adminKids.push(GMB.field('Confirm token', GMB.input(adminTok, 'confirm', { type: 'password' })));
    adminKids.push(h('div.toolbar', [GMB.button(configured ? 'Change token' : 'Set token',
      setAdminToken, configured ? 'ghost' : 'primary')]));
    box.appendChild(section('Admin access', h('div.form-grid', adminKids),
      'Stored on the device (never exported); this browser keeps its copy locally ' +
      'so your own writes keep working.'));

    var policy = (st && st.midiSourcePolicy) || 'open';
    var locked = !!(st && st.midiSourceLocked);
    function policyRadio(value, label, hint) {
      var input = h('input', { type: 'radio', name: 'midisrc', checked: policy === value });
      input.addEventListener('change', function () {
        GMB.api.setMidiSource({ policy: value }).then(function () {
          GMB.toast('Network MIDI source policy: ' + label, 'ok');
          refreshSecurity();  // show the unlock button / lock state right away
        }).catch(function (e) {
          GMB.toast('Policy change failed: ' + ((e && e.message) || e), 'error');
        });
      });
      return h('label.inline.builder-opt', [input, h('span', label + ' — ' + hint)]);
    }
    var midiKids = [
      policyRadio('open', 'Accept any sender', 'any host on the network may send notes'),
      policyRadio('lockToFirst', 'Lock to first sender',
        'the first controller heard becomes the only accepted one' +
        (locked ? ' (currently locked to a sender)' : '')),
      policyRadio('disabled', 'Disable network MIDI', 'refuse every UDP MIDI packet')
    ];
    if (policy === 'lockToFirst') {
      midiKids.push(h('div.toolbar', [GMB.button('Unlock current sender', function () {
        GMB.api.setMidiSource({ unlock: true }).then(function () {
          GMB.toast('Sender unlocked — the next controller heard will lock the session.', 'ok');
          refreshSecurity();
        }).catch(function (e) {
          GMB.toast('Unlock failed: ' + ((e && e.message) || e), 'error');
        });
      }, 'ghost')]));
    }
    box.appendChild(section('MIDI network source', h('div', midiKids),
      'Stored on the device. On the isolated hotspot “accept any” is fine; on a ' +
      'shared Wi-Fi prefer “lock to first sender”.'));
  }

  function securityTab(host) {
    host.appendChild(h('div.note-box',
      'Who is allowed to change this instrument, and which hosts on the network may ' +
      'send it notes. On an isolated hotspot the defaults are fine; before joining a ' +
      'shared Wi-Fi, set an admin token.'));
    var sec = h('div', { id: 'security-section' });
    host.appendChild(sec);
    renderSecurity(sec, null);
    GMB.api.getStatus().then(function (st) { renderSecurity(sec, st); })
      .catch(function () {});
  }

  // ---- open / close ---------------------------------------------------------
  function open(tab) {
    if (!GMB.state.profile) { GMB.toast('Configuration still loading…', 'warn'); return; }
    tab = TAB_ALIASES[tab] || tab;
    activeTab = (tab && TABS.some(function (t) { return t.id === tab; })) ? tab : 'device';
    if (overlay) overlay.remove();
    lastFocus = document.activeElement;
    build();
    // rAF so the .open transition runs from the hidden state. Focus only moves
    // on the NEXT frame: the overlay is still `visibility: hidden` while the
    // class is being applied, and focus() on a hidden element is a no-op.
    requestAnimationFrame(function () {
      if (!overlay) return;
      overlay.classList.add('open');
      requestAnimationFrame(function () {
        if (!overlay) return;
        var first = overlay.querySelector('.settings-tab');
        if (first) first.focus();
      });
    });
    document.addEventListener('keydown', onKey, true);
  }
  GMB.openSettings = open;

  function close() {
    document.removeEventListener('keydown', onKey, true);
    teardownTab();
    GMB.setRedraw(null);
    if (overlay) {
      var o = overlay;
      o.classList.remove('open');
      overlay = null;
      setTimeout(function () { o.remove(); }, 200);
    }
    // Focus goes back where it came from (the gear button), so keyboard users are
    // not dumped at the top of the document.
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
    // Refresh the underlying page so config changes show, and reset the wizard's
    // current-flow tracking to whatever page is now visible.
    if (GMB.render) GMB.render();
  }
  GMB.closeSettings = close;

  // Escape closes; Tab is trapped inside the dialog (a modal that leaks focus to
  // the page behind it is not a modal).
  var FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    var items = Array.prototype.filter.call(overlay.querySelectorAll(FOCUSABLE), function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (overlay.contains(document.activeElement)) return;
    else { e.preventDefault(); first.focus(); }
  }

  // ---- save -----------------------------------------------------------------
  // Order matters (audit 4 P1.6): the PROFILE is published FIRST, over the link we
  // still have; the network settings (device NVS) go second; and only then is the
  // Wi-Fi change APPLIED — apply:true may tear down the very connection the
  // browser is using (hotspot -> station or back), which used to kill the profile
  // PUT that was still queued behind it.
  function save() {
    var net = GMB.state.profile.network;
    // WPA2 needs 8..63 chars — anything shorter would silently start an OPEN
    // hotspot, so refuse it here too (the API also answers 422).
    if (wifi.apPassword && (wifi.apPassword.length < 8 || wifi.apPassword.length > 63)) {
      GMB.toast('Hotspot password must be 8–63 characters (WPA2) — or use ' +
                '“Remove the hotspot password” for an open access point.', 'error');
      return;
    }
    var payload = {
      mode: net.mode,
      ssid: net.ssid || '',
      apSsid: net.apSsid || '',
      hostname: net.hostname || '',
      apply: true  // the device reconnects only after everything is stored
    };
    if (wifi.stationPassword) payload.stationPassword = wifi.stationPassword;
    if (wifi.apPassword) payload.apPassword = wifi.apPassword;
    if (wifi.forgetStation || (openNetworkSelected() && !wifi.stationPassword))
      payload.clearStationPassword = true;
    if (wifi.forgetAp) payload.clearApPassword = true;
    var switching = net.mode === 'station';
    GMB.saveProfile()
      .then(function () {
        // Profile safely published: NOW store + apply the network settings.
        return GMB.api.setWifi(payload).then(function (r) {
          wifi.stationPassword = ''; wifi.apPassword = '';
          wifi.forgetStation = false; wifi.forgetAp = false;
          GMB.toast((r && r.note) ? ('Network settings ' + r.note) :
            'Network settings stored on the device.', 'ok');
          if (switching)
            GMB.toast('If you are connected through the hotspot, the device may now ' +
                      'switch networks — reconnect on the new network if this page ' +
                      'stops responding.', 'warn');
        }, function (e) {
          var body = e && e.body;
          GMB.toast('Network save failed: ' + ((body && body.error) || (e && e.message) || e),
                    'error');
        });
      })
      .catch(function () {
        // Profile save failed (already toasted): the network change was NOT
        // stored or applied — fix the draft and save again.
      });
  }

  function startHotspot() {
    if (!confirm('Switch to the Wi-Fi hotspot (access point) now?\n\nIf you are connected over Wi-Fi you will be disconnected — rejoin the device’s network (the config page opens automatically).')) return;
    GMB.api.startHotspot().then(function (r) {
      GMB.toast((r && r.note) || 'Hotspot starting…', 'warn');
    }).catch(function (e) { GMB.toast('Hotspot request failed: ' + (e && e.message || e), 'error'); });
  }

  GMB.views = GMB.views || {};
})(window);
