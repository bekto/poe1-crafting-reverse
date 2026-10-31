// Mobile layout and accessibility checks in headless Chromium:
//   NODE_PATH=$(npm root -g) node test/a11y.cjs        (needs the server on :8765, like browser.cjs)
// 1. no sideways scrolling on a phone-sized screen, at every step
// 2. every control has an accessible name
// 3. text contrast meets WCAG AA (4.5:1, or 3:1 for large text), disabled controls excepted
// 4. the main flow works with the keyboard alone (Tab / Enter / Space)
const { chromium } = require('playwright');

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('  FAIL', msg); };
const pass = (msg) => console.log('  ok  ', msg);

async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { overflow: null, unnamed: [], lowContrast: [] };
    const doc = document.documentElement;
    // on a phone the layout viewport grows with too-wide content, so compare with the screen (clientWidth)
    const screenW = doc.clientWidth;
    if (doc.scrollWidth > screenW + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > screenW + 1 && e.offsetParent !== null);
      out.overflow = { width: doc.scrollWidth, viewport: screenW, culprits: wide.slice(0, 5).map((e) => e.tagName + (e.id ? '#' + e.id : '') + '.' + e.className) };
    }
    const visible = (e) => {
      if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true })) return false; // also inside closed <details>
      const s = getComputedStyle(e); const b = e.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0;
    };
    // accessible names
    for (const e of document.querySelectorAll('button, input, select, textarea, summary, [role=button]')) {
      if (!visible(e) || e.type === 'hidden') continue;
      const id = e.id && document.querySelector(`label[for="${e.id}"]`);
      const name = (e.getAttribute('aria-label') || '').trim() || (e.closest('label')?.innerText || '').trim() || (id?.innerText || '').trim() ||
        (e.getAttribute('title') || '').trim() || (['BUTTON', 'SUMMARY'].includes(e.tagName) ? e.innerText.trim() : '') || (e.getAttribute('placeholder') && e.tagName === 'TEXTAREA' ? '' : '');
      if (!name) out.unnamed.push(e.outerHTML.slice(0, 90));
    }
    // contrast
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x)); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const bgOf = (e) => {
      const layers = [];
      for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
      let bg = { r: 18, g: 17, b: 16, a: 1 }; // the page background
      for (const c of layers.reverse()) bg = blend(c, bg);
      return bg;
    };
    const opacityOf = (e) => { let o = 1; for (let x = e; x; x = x.parentElement) o *= parseFloat(getComputedStyle(x).opacity); return o; };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const e = t.parentElement;
      if (!e || seen.has(e) || !visible(e) || e.closest('[disabled], option, datalist, .off')) continue;
      seen.add(e);
      const s = getComputedStyle(e);
      const bg = bgOf(e);
      let fg = parse(s.color);
      fg = blend({ ...fg, a: fg.a * opacityOf(e) }, bg);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) out.lowContrast.push(`${ratio.toFixed(2)} < ${need}: "${t.textContent.trim().slice(0, 40)}" (${e.tagName}.${e.className})`);
    }
    return out;
  });
  if (r.overflow) fail(`${label}: page is ${r.overflow.width}px wide on a ${r.overflow.viewport}px screen (${r.overflow.culprits.join(', ')})`);
  else pass(`${label}: no sideways scrolling`);
  if (r.unnamed.length) fail(`${label}: controls without a name: ${r.unnamed.join(' | ')}`);
  else pass(`${label}: every control has a name`);
  if (r.lowContrast.length) fail(`${label}: low contrast: ${r.lowContrast.slice(0, 8).join(' | ')}`);
  else pass(`${label}: text contrast meets AA`);
}

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/');
  await page.waitForFunction(() => !document.getElementById('readBtn').disabled, null, { timeout: 30000 });
  console.log('phone (375 px):');
  await audit(page, 'start');
  await page.click('#builder summary');
  await audit(page, 'builder open');
  await page.selectOption('#sampleSel', 'boots');
  await page.waitForSelector('#itemPanel:not([hidden])');
  await audit(page, 'item read');
  await page.click('#planBtn');
  await page.waitForSelector('.method', { timeout: 120000 });
  await page.waitForSelector('#progress[hidden]', { state: 'attached' });
  await audit(page, 'plans shown');

  console.log('keyboard only (desktop):');
  const k = await b.newPage({ viewport: { width: 1100, height: 900 } });
  await k.goto('http://127.0.0.1:8765/');
  await k.waitForFunction(() => !document.getElementById('readBtn').disabled, null, { timeout: 30000 });
  const tabTo = async (pred, max = 60) => {
    for (let i = 0; i < max; i++) {
      await k.keyboard.press('Tab');
      if (await k.evaluate(pred)) return true;
    }
    return false;
  };
  // paste box -> type an item -> Read item with Enter
  if (await tabTo(() => document.activeElement?.id === 'itemText')) pass('Tab reaches the paste box'); else fail('Tab never reaches the paste box');
  const ring = await k.evaluate(async () => (await import('./js/samples.js')).ITEMS.ring);
  await k.keyboard.insertText(ring);
  if (await tabTo(() => document.activeElement?.id === 'readBtn')) pass('Tab reaches "Read item"'); else fail('Tab never reaches "Read item"');
  await k.keyboard.press('Enter');
  await k.waitForSelector('#itemPanel:not([hidden])');
  pass('Enter on "Read item" reads the item');
  // untick a mod with Space, then plan with Enter
  if (await tabTo(() => document.activeElement?.matches('#modList input[type=checkbox]'))) {
    await k.keyboard.press('Space');
    const off = await k.evaluate(() => !document.activeElement.checked);
    off ? pass('Space toggles a mod') : fail('Space did not toggle the mod checkbox');
  } else fail('Tab never reaches the mod checkboxes');
  if (await tabTo(() => document.activeElement?.id === 'planBtn')) {
    await k.keyboard.press('Enter');
    await k.waitForSelector('.method', { timeout: 120000 });
    pass('Enter on "Find crafting plans" plans');
  } else fail('Tab never reaches "Find crafting plans"');
  // a plan opens and closes with the keyboard
  if (await tabTo(() => document.activeElement?.matches('.method summary'), 200)) {
    const before = await k.evaluate(() => document.activeElement.parentElement.open);
    await k.keyboard.press('Enter');
    const after = await k.evaluate(() => document.activeElement.parentElement.open);
    before !== after ? pass('Enter opens/closes a plan') : fail('Enter did not toggle the plan');
    const ring = await k.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    ring !== 'none' ? pass('focused plan has a visible focus ring') : fail('no focus ring on the focused plan');
  } else fail('Tab never reaches a plan');
  if (errs.length) fail('page errors: ' + errs.join('; '));
  console.log(failures.length ? `\n${failures.length} accessibility problem(s)` : '\nall accessibility checks passed');
  if (failures.length) process.exitCode = 1;
  await b.close();
})();
