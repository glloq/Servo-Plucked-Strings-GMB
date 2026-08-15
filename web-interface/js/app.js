/*
 * app.js — application shell: routing between views, shared DOM helpers, the
 * global working-profile state and the first-run entry point. Loaded after
 * api.js and before the view modules.
 *
 * Each view module registers itself on GMB.views[name] with a render(container)
 * function. app.js owns navigation and the draft profile that views read and
 * mutate; saving is atomic through GMB.api.putProfile.
 *
 * PROGRESSIVE DISCLOSURE (UX audit): a screen only asks for the decisions the
 * software cannot make itself. Everything derivable, generatable or safely
 * defaulted is hidden behind a local "Advanced…" disclosure — never behind a
 * global expert switch. The shared atoms for that live here: GMB.disclosure,
 * GMB.summaryLine and GMB.alert (persistent errors, as opposed to toasts).
 */
(function (global) {
  'use strict';
  var GMB = global.GMB;

  // ---- tiny DOM builder: h('div.class#id', {attrs}, [children]) -------------
  function h(tag, attrs, children) {
    var parts = tag.split(/(?=[.#])/);
    var el = document.createElement(parts[0] || 'div');
    parts.slice(1).forEach(function (p) {
      if (p[0] === '.') el.classList.add(p.slice(1));
      else if (p[0] === '#') el.id = p.slice(1);
    });
    if (attrs && (attrs.nodeType || typeof attrs === 'string' || Array.isArray(attrs))) {
      children = attrs; attrs = null;
    }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) el.setAttribute(k, k); el[k] = v; }
        else el.setAttribute(k, v);
      });
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    if (children === null || children === undefined) return;
    if (Array.isArray(children)) { children.forEach(function (c) { appendChildren(el, c); }); return; }
    if (children.nodeType) { el.appendChild(children); return; }
    el.appendChild(document.createTextNode(String(children)));
  }
  GMB.h = h;

  // Labelled form field helper.
  GMB.field = function (label, control, hint) {
    return h('label.field', [h('span.field-label', label), control,
      hint ? h('span.field-hint', hint) : null]);
  };

  // Bound input that writes obj[key] on change (with optional coercion).
  GMB.input = function (obj, key, opts) {
    opts = opts || {};
    var type = opts.type || 'text';
    var el;
    if (type === 'select') {
      el = h('select');
      (opts.options || []).forEach(function (o) {
        var val = o.value !== undefined ? o.value : o;
        var lab = o.label !== undefined ? o.label : o;
        el.appendChild(h('option', { value: val, selected: String(obj[key]) === String(val) }, lab));
      });
      el.value = obj[key];
    } else if (type === 'checkbox') {
      el = h('input', { type: 'checkbox', checked: !!obj[key] });
    } else {
      el = h('input', { type: type, value: obj[key] });
      if (opts.min !== undefined) el.min = opts.min;
      if (opts.max !== undefined) el.max = opts.max;
      if (opts.step !== undefined) el.step = opts.step;
      if (opts.placeholder) el.placeholder = opts.placeholder;
    }
    el.addEventListener('change', function () {
      var v;
      if (type === 'checkbox') v = el.checked;
      else if (type === 'number') {
        // A cleared number field coerces to its minimum (or 0), never null: a null
        // openNote/maxFret rendered "--" and turned fret loops into no-ops (G10).
        if (el.value === '') { v = (opts.min !== undefined) ? opts.min : 0; el.value = v; }
        else v = Number(el.value);
      } else v = el.value;
      if (opts.coerce) v = opts.coerce(v);
      obj[key] = v;
      if (opts.onChange) opts.onChange(v);
      GMB.markDirty();
    });
    if (opts.disabled) el.disabled = true;
    return el;
  };

  GMB.button = function (label, onClick, cls) {
    return h('button.btn' + (cls ? '.' + cls : ''), { type: 'button', onclick: onClick }, label);
  };

  // A number input bound to obj[key] but DISPLAYED with an offset. Used for the
  // MIDI channel, which the firmware stores zero-based while every musician (and
  // every other piece of gear) counts 1–16: the offset lives in this data layer
  // only, and the user never learns the storage is zero-based (UX audit 6).
  GMB.offsetInput = function (obj, key, offset, opts) {
    opts = opts || {};
    var el = h('input', { type: 'number', value: (obj[key] | 0) + offset });
    if (opts.min !== undefined) el.min = opts.min;
    if (opts.max !== undefined) el.max = opts.max;
    el.addEventListener('change', function () {
      var lo = opts.min !== undefined ? opts.min : -Infinity;
      var hi = opts.max !== undefined ? opts.max : Infinity;
      var shown = Math.max(lo, Math.min(hi, Math.round(Number(el.value) || lo)));
      el.value = shown;
      obj[key] = shown - offset;
      if (opts.onChange) opts.onChange(obj[key]);
      GMB.markDirty();
    });
    return el;
  };

  // ---- progressive disclosure ----------------------------------------------
  // A collapsible block whose open/closed state SURVIVES a re-render: views
  // redraw themselves wholesale on every edit, so the state is keyed by a stable
  // string (or by the object being edited, via GMB.disclosureKey).
  var openBlocks = {};
  GMB.isDisclosed = function (key) { return !!openBlocks[key]; };
  GMB.setDisclosed = function (key, on) { openBlocks[key] = !!on; };

  // GMB.disclosure(key, label, build) — `build()` is only called when open, so a
  // closed block costs nothing to render (and holds no live listeners).
  GMB.disclosure = function (key, label, build, opts) {
    opts = opts || {};
    var open = !!openBlocks[key];
    var btn = h('button.disclosure-toggle', {
      type: 'button', 'aria-expanded': open ? 'true' : 'false',
      onclick: function () {
        openBlocks[key] = !open;
        if (opts.onToggle) opts.onToggle(!open); else GMB.redraw();
      }
    }, [h('span.disclosure-caret', open ? '▾' : '▸'), h('span', label)]);
    return h('div.disclosure' + (open ? '.open' : ''),
      [btn, open ? h('div.disclosure-body', build()) : null]);
  };

  // "Label: value ✓  [Change…]" — the compact form of a decision the software
  // already took for the user (wiring, controller, MIDI…).
  GMB.summaryLine = function (label, value, actionLabel, onAction, ok) {
    return h('div.summary-line', [
      h('span.sl-label', label),
      h('strong.sl-value', value),
      ok === false ? h('span.sl-flag.bad', '!') : h('span.sl-flag.ok', '✓'),
      h('span.spacer'),
      onAction ? GMB.button(actionLabel || 'Change…', onAction, 'ghost.small') : null
    ]);
  };

  // The view module currently on screen can register how to redraw ITSELF (a
  // step body, a settings tab…) so a disclosure toggle doesn't rebuild the page
  // and lose scroll position. Defaults to a full re-render.
  var redrawHook = null;
  GMB.setRedraw = function (fn) { redrawHook = fn; };
  GMB.redraw = function () { if (redrawHook) redrawHook(); else GMB.render(); };

  // Surface a list of backend validation issues ({field,message,severity}) as a
  // PERSISTENT alert. A toast that vanishes after 3.6 s is the wrong home for a
  // rejected save (UX audit 19): the reasons stay on screen until dismissed, and
  // the raw field paths sit behind "Technical details".
  GMB.reportIssues = function (prefix, issues) {
    if (!issues || !issues.length) return false;
    var errs = issues.filter(function (is) { return is.severity !== 'warning'; });
    GMB.alert(prefix + ' — ' + issues.length + ' problem(s) to fix.',
      issues.map(function (is) {
        return (is.severity === 'warning' ? '⚠ ' : '✖ ') +
               (is.field ? is.field + ' — ' : '') + is.message;
      }), errs.length ? 'error' : 'warn');
    return true;
  };

  // A persistent, dismissible message under the top bar. Unlike a toast it stays
  // until the user closes it or the next alert replaces it, so an error can be
  // read, acted on and re-read.
  GMB.alert = function (msg, details, kind) {
    var host = document.getElementById('alert-host');
    if (!host) return;
    host.innerHTML = '';
    var box = h('div.alertbox.' + (kind || 'error'), { role: 'alert' }, [
      h('div.alertbox-head', [
        h('strong', msg), h('span.spacer'),
        h('button.alertbox-close', { type: 'button', 'aria-label': 'Dismiss this message',
          onclick: function () { host.innerHTML = ''; } }, '×')
      ]),
      (details && details.length)
        ? GMB.disclosure('alert-details', 'Technical details', function () {
            return h('ul.alertbox-list', details.map(function (d) { return h('li', d); }));
          }, { onToggle: function () { GMB.alert(msg, details, kind); } })
        : null
    ]);
    host.appendChild(box);
  };
  GMB.clearAlert = function () {
    var host = document.getElementById('alert-host');
    if (host) host.innerHTML = '';
  };

  // Toast notifications — for transient confirmations only. The host is an
  // aria-live region so a screen reader announces them; errors get role="alert".
  GMB.toast = function (msg, kind) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var t = h('div.toast' + (kind ? '.' + kind : ''),
      kind === 'error' ? { role: 'alert' } : null, msg);
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3600);
  };

  // ---- routing --------------------------------------------------------------
  // Three main pages: the playable Instrument, the Configure flow (design ->
  // calibrate -> test -> finish) and the generated Wiring page. Everything the
  // software can decide for the user — GPIO, I²C, PCA addressing, power
  // governor, timing, MIDI, SysEx — lives behind the gear menu instead of the
  // main navigation (UX audit 2).
  var TABS = [
    { id: 'fretboard', label: 'Instrument', icon: '♪' },
    { id: 'setup', label: 'Configure', icon: '⛭' },
    { id: 'hardware', label: 'Wiring', icon: '⚡' }
  ];
  // Views reachable by hash / navigate() but absent from the sidebar.
  var EXTRA_VIEWS = { welcome: 'Welcome' };
  function viewLabel(id) {
    var t = TABS.filter(function (x) { return x.id === id; })[0];
    return t ? t.label : (EXTRA_VIEWS[id] || id);
  }
  function knownView(id) { return TABS.some(function (t) { return t.id === id; }) || !!EXTRA_VIEWS[id]; }

  var state = {
    profile: null,      // working draft (edited in place by views)
    mode: 'simplified',
    dirty: false,
    current: 'fretboard'
  };
  GMB.state = state;

  // ---- first run -------------------------------------------------------------
  // "Has this instrument ever been set up?" is a property of the INSTALLATION,
  // not of the profile (the device always answers with a usable default profile),
  // so it is remembered in the browser. Until it is marked done, the interface
  // opens on the welcome screen and takes the user straight into creation
  // instead of landing on a fretboard that does not exist yet (UX audit 7).
  var SETUP_KEY = 'gmb.setupComplete';
  GMB.setupComplete = function () {
    try { return localStorage.getItem(SETUP_KEY) === '1'; } catch (e) { return true; }
  };
  GMB.markSetupComplete = function () {
    try { localStorage.setItem(SETUP_KEY, '1'); } catch (e) {}
  };
  GMB.resetFirstRun = function () {
    try { localStorage.removeItem(SETUP_KEY); } catch (e) {}
  };

  GMB.markDirty = function () {
    state.dirty = true;
    var b = document.getElementById('save-bar');
    if (b) b.classList.add('visible');
  };

  // There is no global expert mode: disclosure is LOCAL to each screen (see
  // GMB.disclosure). Kept as a stable no-op so any lingering caller — or an old
  // saved profile's `mode` field — stays harmless.
  GMB.isAdvanced = function () { return false; };
  function setMode() { state.mode = 'simplified'; document.body.setAttribute('data-mode', 'simplified'); }
  GMB.setMode = setMode;

  function navigate(id) {
    // Leaving a view must never leave a group test driving the servos in the
    // background: cancel any running sequence before switching.
    if (GMB.testRunner) GMB.testRunner.stop();
    GMB.setRedraw(null);
    state.current = id;
    location.hash = '#' + id;
    document.querySelectorAll('.nav-item').forEach(function (n) {
      var on = n.getAttribute('data-tab') === id;
      n.classList.toggle('active', on);
      n.setAttribute('aria-current', on ? 'page' : 'false');
    });
    render();
  }
  GMB.navigate = navigate;

  var mountedView = null;   // id of the view currently in the DOM (for teardown)

  function render() {
    var host = document.getElementById('view');
    if (!host) return;
    // Let the outgoing view release anything live (sockets, servo holds, timers)
    // before it is torn out of the DOM. Runs on every re-render, so a view's
    // teardown must be idempotent — its render then re-establishes what it needs.
    if (mountedView && GMB.views[mountedView] && GMB.views[mountedView].teardown) {
      try { GMB.views[mountedView].teardown(); } catch (e) {}
    }
    mountedView = null;
    host.innerHTML = '';
    if (!state.profile) { host.appendChild(h('div.card', 'Loading configuration…')); return; }
    var view = GMB.views[state.current];
    if (view && view.render) {
      try { view.render(host); mountedView = state.current; }
      catch (e) { host.appendChild(h('div.card', [h('h2', 'View error'), h('pre', String(e && e.stack || e))])); }
    } else {
      host.appendChild(h('div.card', 'Unknown view: ' + state.current));
    }
    updateMockBadge();
  }
  GMB.render = render;

  function updateMockBadge() {
    var badge = document.getElementById('mock-badge');
    if (badge) badge.style.display = GMB.api.mock ? 'inline-flex' : 'none';
  }
  GMB.updateMockBadge = updateMockBadge;

  // Save the working draft atomically (SysEx spec 15: only validated profiles
  // are published; a save increments capabilitiesRevision on the backend).
  // The returned Promise REJECTS on failure (after toasting): callers that chain
  // follow-up actions on a successful save must be able to tell the difference —
  // the old swallow-and-resolve let "saved, now do X" run on a failed save
  // (audit 4). Callers that don't care can ignore the rejection via .catch.
  // PUT /api/profile answers 202: the activation is only QUEUED (the loop parks the
  // old servos, swaps, re-parks, re-arms). "Saved" therefore is NOT "active": after
  // acceptance we follow the command outcome and then poll the status until the
  // instrument is back to ready/readyDegraded, so the success toast means the new
  // profile actually RUNS (audit 5). Timeouts degrade to an honest "still
  // activating" warning without rejecting (the activation continues on-device).
  function waitForActivation(commandId) {
    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // The firmware now reports the WHOLE activation on the command itself
    // (audit 7): "running" while the old profile parks, swaps and the new one
    // re-parks; "succeeded" only when the new profile really reached ready.
    // So the command poll carries the ~30 s budget (double park + arming), and
    // the status poll after it is a short confirmation, not a guess.
    function pollCommand(triesLeft) {
      if (!commandId) return Promise.resolve('succeeded');  // mock / immediate path
      return GMB.api.commandState(commandId).then(function (r) {
        var st = r && r.state;
        if (st === 'succeeded') return 'succeeded';
        if (st === 'refused') throw Object.assign(new Error('activation refused'),
                                                  { refused: true });
        // Purged by a panic / E-stop before it ran (audit 6): stop immediately
        // instead of polling a ghost to the timeout.
        if (st === 'cancelled') throw Object.assign(new Error('activation cancelled'),
                                                    { refused: true, cancelled: true });
        // The swap started but could not be completed (park unconfirmed, arming
        // failed): terminal — the device kept the safest posture (audit 7).
        if (st === 'failed') throw Object.assign(new Error('activation failed'),
                                                 { refused: true, failed: true });
        if (triesLeft <= 0) return 'timeout';
        return delay(500).then(function () { return pollCommand(triesLeft - 1); });
      });
    }
    function pollReady(triesLeft) {
      return GMB.api.getStatus().then(function (st) {
        var s = String((st && st.state) || '').toLowerCase();
        if (s === 'ready' || s === 'readydegraded') return 'ready';
        if (triesLeft <= 0) return 'timeout';
        return delay(500).then(function () { return pollReady(triesLeft - 1); });
      });
    }
    return pollCommand(60).then(function (r) {
      if (r === 'timeout') return 'timeout';
      return pollReady(10);
    });
  }

  GMB.saveProfile = function () {
    // `dirty` is only cleared once the activation is CONFIRMED (or on the mock /
    // legacy immediate path): the 202 merely queues it, and the command can still
    // be refused (safety lock) or cancelled (panic purge) before it runs — the
    // draft must then keep showing as unsaved (audit 6).
    function markSaved() {
      state.dirty = false;
      GMB.markSetupComplete();   // a configuration really ran: no longer a first run
      GMB.clearAlert();
      var b = document.getElementById('save-bar');
      if (b) b.classList.remove('visible');
    }
    return GMB.api.putProfile(state.profile).then(function (res) {
      if (res && res.capabilitiesRevision) state.profile.capabilitiesRevision = res.capabilitiesRevision;
      updateMockBadge();
      if (res && res.accepted !== undefined) {
        GMB.toast('Profile accepted — activating…', 'ok');
        return waitForActivation(res.commandId).then(function (r) {
          if (r === 'timeout') {
            GMB.toast('Still applying — the draft stays marked unsaved until the ' +
                      'instrument confirms it.', 'warn');
          } else {
            markSaved();
            GMB.toast('Configuration applied ✓', 'ok');
          }
        });
      }
      // Mock / legacy backend: no queue — the save is the whole story.
      markSaved();
      GMB.toast('Configuration saved ✓', 'ok');
    }).catch(function (e) {
      var body = e && e.body;
      if (e && e.cancelled)
        GMB.toast('Activation cancelled (panic / E-stop / safety stop) — the draft ' +
                  'is still unsaved.', 'error');
      else if (e && e.failed)
        GMB.toast('Activation FAILED on the device (parking could not be confirmed ' +
                  'or arming failed) — check Diagnostics; the draft is still unsaved.',
                  'error');
      else if (e && e.refused)
        GMB.toast('Activation refused by the device (safety locked or invalid profile).', 'error');
      else if (!(body && body.issues && GMB.reportIssues('The configuration was refused', body.issues)))
        GMB.alert('Save failed.', [(body && body.error) || e.message], 'error');
      throw e;  // the toast is shown; callers still need the real outcome
    });
  };

  GMB.reloadProfile = function () {
    return GMB.api.getProfile().then(function (p) {
      state.profile = p;
      state.dirty = false;
      var b = document.getElementById('save-bar');
      if (b) b.classList.remove('visible');
      render();
    });
  };

  // ---- shell construction ---------------------------------------------------
  function buildShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    var nav = h('nav.sidebar', { 'aria-label': 'Main navigation' }, [
      h('div.brand', [h('div.brand-mark', 'GMB'),
        h('div.brand-text', [h('strong', 'Servo-Plucked'), h('small', 'Strings-GMB')])]),
      h('div.nav-list', TABS.map(function (t) {
        return h('button.nav-item', {
          'data-tab': t.id, onclick: function () { navigate(t.id); },
          'aria-current': t.id === state.current ? 'page' : 'false',
          class: t.id === state.current ? 'active' : ''
        }, [h('span.nav-icon', { 'aria-hidden': 'true' }, t.icon), h('span.nav-label', t.label)]);
      })),
      h('div.nav-footer', [
        h('button.btn.danger.panic-side', { onclick: doPanic }, 'STOP')
      ])
    ]);

    var burger = h('button.hamburger', {
      'aria-label': 'Open the navigation menu', 'aria-expanded': 'false',
      'aria-controls': 'sidebar-nav',
      onclick: function () {
        var open = nav.classList.toggle('open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }, '≡');
    nav.id = 'sidebar-nav';

    var main = h('main.main', [
      h('header.topbar', [
        burger,
        h('div#topbar-title.topbar-title', 'Instrument'),
        h('div.topbar-right', [
          h('span#mock-badge.badge.mock', { style: 'display:none' }, 'DEMO / MOCK DATA'),
          h('span#conn-badge.badge.ok', 'Local'),
          h('button.icon-btn#settings-btn', {
            'aria-label': 'Settings — device, MIDI, advanced hardware, diagnostics',
            title: 'Settings — device, MIDI, advanced hardware, diagnostics',
            onclick: function () { if (GMB.openSettings) GMB.openSettings(); }
          }, [h('span', { 'aria-hidden': 'true' }, '⚙')])
        ])
      ]),
      h('div#alert-host.alert-host', { 'aria-live': 'assertive' }),
      h('div#view.view'),
      h('div#save-bar.save-bar', [
        h('span', 'You have unsaved changes.'),
        h('span.spacer'),
        GMB.button('Discard', discardChanges, 'ghost'),
        GMB.button('Save and apply', function () { GMB.saveProfile().catch(function () {}); }, 'primary')
      ])
    ]);

    app.appendChild(nav);
    app.appendChild(main);
    app.appendChild(h('div#toast-host.toast-host', { 'aria-live': 'polite', role: 'status' }));
  }

  // Discarding throws work away, so it asks first (UX audit 15).
  function discardChanges() {
    if (!confirm('Discard every change made since the last save?\n\n' +
                 'The instrument goes back to the configuration currently running ' +
                 'on the device.')) return;
    GMB.clearAlert();
    GMB.reloadProfile().then(function () { GMB.toast('Changes discarded.', 'warn'); });
  }
  GMB.discardChanges = discardChanges;

  function doPanic() {
    if (!confirm('PANIC / STOP: disable all drivers, neutralise servos and flush the MIDI queue. Continue?')) return;
    if (GMB.testRunner) GMB.testRunner.stop();   // halt any client-side group test too
    GMB.api.panic().then(function (r) { GMB.toast(r.message || 'Panic executed.', 'warn'); });
  }
  GMB.doPanic = doPanic;

  // Keep the topbar title in sync with the active tab.
  var _navigate = navigate;
  navigate = function (id) {
    _navigate(id);
    var el = document.getElementById('topbar-title');
    if (el) el.textContent = viewLabel(id);
    var side = document.querySelector('.sidebar');
    if (side) side.classList.remove('open');
    var burger = document.querySelector('.hamburger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  };
  GMB.navigate = navigate;

  // ---- boot -----------------------------------------------------------------
  function boot() {
    buildShell();
    setMode('simplified');
    GMB.api.getProfile().then(function (p) {
      state.profile = p;
      var start = (location.hash || '').replace('#', '');
      if (knownView(start)) state.current = start;
      // Nothing has ever been configured from this browser: open on Welcome and
      // walk straight into creating an instrument (UX audit 7). Once a
      // configuration has been applied, Instrument becomes the home page again.
      else if (!GMB.setupComplete() && GMB.views.welcome) state.current = 'welcome';
      navigate(state.current);
      updateMockBadge();
    });
  }

  window.addEventListener('hashchange', function () {
    var id = (location.hash || '').replace('#', '');
    if (id && id !== state.current && knownView(id)) navigate(id);
  });

  document.addEventListener('DOMContentLoaded', boot);

  GMB.views = GMB.views || {};
})(window);
