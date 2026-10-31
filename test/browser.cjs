const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  // "Failed to load resource" console lines are reported through the response handler, with their URL
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  // prices.json is optional (the GitHub Action writes it), so a 404 for it is fine
  p.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/data/prices.json')) errs.push(`${r.status()} ${r.url()}`); });
  // PRICES=path serves that file as data/prices.json (the real one is written by the GitHub Action)
  if (process.env.PRICES) {
    const body = require('fs').readFileSync(process.env.PRICES, 'utf8');
    await p.route('**/data/prices.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body }));
  }
  const share = (process.argv[2] || '').startsWith('#') ? process.argv[2] : null; // open a share link
  await p.goto('http://127.0.0.1:8765/' + (share || ''));
  await p.waitForFunction(() => !document.getElementById('readBtn').disabled, null, { timeout: 30000 });
  if (share) {
    await p.waitForSelector('.method', { timeout: 120000 });
    console.log('shared item:', await p.$eval('#itemHead', (e) => e.innerText.replace(/\n/g, ' | ')));
    console.log('hash after planning:', await p.evaluate(() => location.hash));
    console.log('first plan:', await p.$eval('.method summary', (e) => e.innerText.split('\n')[0]));
    console.log('errors', errs);
    if (errs.length) process.exitCode = 1;
    await b.close();
    return;
  }
  if (process.argv[2] === 'builder') {
    // build an item by hand: a Two-Stone Ring with life and cold resistance
    await p.click('#builder summary');
    const label = await p.$eval('#bBaseList', (d) => [...d.options].map((o) => o.value).find((v) => v.startsWith('Two-Stone Ring (+(12-16)% to Fire and Lightning')));
    await p.fill('#bBase', label);
    await p.dispatchEvent('#bBase', 'change');
    for (const re of ['to maximum Life$', 'to Cold Resistance$']) {
      const mod = await p.$eval('#bModList', (d, re) => [...d.options].map((o) => o.value).find((v) => new RegExp('^Prefix · \\+|^Suffix · \\+').test(v) && new RegExp(re).test(v)), re);
      await p.fill('#bMod', mod);
      await p.dispatchEvent('#bMod', 'change');
    }
    console.log('builder mods:', await p.$$eval('#bMods li .text', (els) => els.map((e) => e.textContent)));
    await p.click('#bUse');
  } else await p.selectOption('#sampleSel', process.argv[2] || 'ring');
  await p.waitForSelector('#itemPanel:not([hidden])');
  if (process.argv[3]) for (const i of process.argv[3].split(',')) await p.click(`#modList input[data-i="${i}"]`);
  await p.screenshot({ path: 'test/shot_item.png', fullPage: true });
  const t0 = Date.now();
  await p.click('#planBtn');
  await p.waitForSelector('#progress[hidden]', { state: 'attached', timeout: 120000 });
  await p.waitForFunction(() => document.querySelectorAll('.method').length > 0 || document.querySelector('#planSummary .msg'), null, { timeout: 120000 });
  console.log('plan ms', Date.now() - t0);
  await p.screenshot({ path: 'test/shot_plan.png', fullPage: true });
  console.log(await p.$$eval('.method summary', els => els.map(e => e.innerText.replace(/\n/g,' | '))));
  if (process.env.PRICES) {
    await p.check('input[name="rank"][value="chance"]');
    console.log('by chance, first:', await p.$eval('.method summary', e => e.innerText.split('\n')[0]));
  }
  console.log('errors', errs);
  if (errs.length) process.exitCode = 1;
  await b.close();
})();
