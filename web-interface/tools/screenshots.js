/*
 * screenshots.js — regenerate img/screenshots/*.png from the real interface.
 *
 * The UI falls back to its in-memory mock backend when no device answers (see
 * js/api.js), so opening index.html from file:// gives a complete, deterministic
 * demo instrument — a 4-string GCEA ukulele, with a geared finger on string 1 —
 * and every screenshot in the documentation is taken from it.
 *
 * Usage (Playwright is NOT a project dependency — install it wherever you like):
 *
 *   npm i playwright && npx playwright install chromium
 *   node web-interface/tools/screenshots.js
 *
 * Set CHROMIUM_PATH to use an already-installed Chromium instead.
 *
 * Each page is shot full-height with the viewport fitted to the rendered content,
 * so the images carry no band of empty background. Keep the file names stable:
 * they are referenced from README.md, README_EN.md and docs/WEB_INTERFACE.md.
 */
'use strict';

const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'img', 'screenshots');
const URL = 'file://' + path.join(ROOT, 'web-interface', 'index.html');
const WIDTH = 1400;                    // desktop layout, single column of cards
const SCALE = 1.5;                     // crisp text without 4 MB PNGs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: SCALE,
    colorScheme: 'light',
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.waitForSelector('.nav-item');
  await sleep(600);

  // `fit` grows the viewport to the view's real height before a full-page shot.
  // The modal shots pass fit:false: the overlay is viewport-sized by design.
  async function shot(name, opts) {
    const fit = !opts || opts.fit !== false;
    await sleep(350);
    if (fit) {
      const height = await page.evaluate(() => {
        const view = document.getElementById('view');
        const box = view && view.getBoundingClientRect();
        return Math.ceil(Math.max(box ? box.bottom + window.scrollY + 20 : 0, 560));
      });
      await page.setViewportSize({ width: WIDTH, height: Math.min(height, 4200) });
      await sleep(250);
    }
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: fit });
    await page.setViewportSize({ width: WIDTH, height: 900 });
    console.log('  ' + name + '.png');
  }

  const view = async (id) => { await page.evaluate((v) => GMB.navigate(v), id); await sleep(500); };
  const step = async (id) => { await page.evaluate((s) => GMB.gotoSetupStep(s), id); await sleep(600); };
  const sub = async (label) => { await page.click('.subtab:text-is("' + label + '")'); await sleep(600); };

  // The welcome screen only shows on a first run; stamp the flag first so the
  // documented pages are the ones a configured instrument shows, then shoot the
  // welcome screen on its own at the end.
  await page.evaluate(() => GMB.markSetupComplete());

  console.log('Instrument');
  await view('fretboard');
  await shot('fretboard');

  console.log('Configure');
  await step('builder');
  await shot('wizard');

  await step('frets');
  // Open the first equipped fret so the servo editor is part of the picture.
  const chip = page.locator('.fret-chip.equipped, .fret-chip.geared').first();
  if (await chip.count()) { await chip.click(); await sleep(500); }
  await shot('calibration');

  await step('strings');
  await shot('calibration-plucking');
  await step('test');
  await shot('calibration-test');
  await step('finish');
  await shot('validation');

  console.log('Wiring');
  await view('hardware');
  await sub('Diagram');
  await shot('wiring');
  await sub('Commissioning');
  await shot('commissioning');

  console.log('Settings modal');
  await view('fretboard');                       // calm backdrop behind the overlay
  await page.evaluate(() => GMB.openSettings('device'));
  await sleep(800);
  await shot('network', { fit: false });

  // Each settings tab, with its folded sections opened where the documentation
  // needs to show what is inside them.
  async function tab(label) {
    await page.click('.settings-tab:text-is("' + label + '")');
    await sleep(900);
  }
  async function unfold(label) {
    const t = page.locator('.disclosure-toggle', { hasText: label }).first();
    if (await t.count() && (await t.getAttribute('aria-expanded')) === 'false') {
      await t.click();
      await sleep(900);
    }
  }
  await tab('MIDI');
  await unfold('MIDI parameters');
  await shot('midi', { fit: false });

  await tab('Advanced hardware');
  await shot('settings-hardware', { fit: false });
  await unfold('GPIO pins');
  await shot('pins', { fit: false });
  await unfold('I\u00b2C addressing');
  await shot('wiring-i2c', { fit: false });
  await unfold('Power & safety');
  await shot('wiring-power', { fit: false });

  await tab('Security');
  await shot('settings-security', { fit: false });
  await tab('Diagnostics');
  await shot('midi-monitor', { fit: false });
  await tab('Developer');
  await shot('sysex', { fit: false });

  // Close, then show the first-run welcome screen on its own.
  await page.keyboard.press('Escape');
  await sleep(400);
  // The hash still points at the last page visited; a genuine first run has none.
  await page.evaluate(() => { GMB.resetFirstRun(); location.hash = ''; });
  await page.goto(URL);
  await page.waitForSelector('.welcome-card');
  await sleep(600);
  await shot('welcome');
  await page.evaluate(() => GMB.markSetupComplete());

  await browser.close();

  if (errors.length) {
    console.log('\nPage errors (the CORS/fetch failures of file:// mock mode are expected):');
    errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  }
})();
