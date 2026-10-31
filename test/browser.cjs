const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  // PRICES=path serves that file as data/prices.json (the real one is written by the GitHub Action)
  if (process.env.PRICES) {
    const body = require('fs').readFileSync(process.env.PRICES, 'utf8');
    await p.route('**/data/prices.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body }));
  }
  await p.goto('http://127.0.0.1:8765/');
  await p.waitForFunction(() => !document.getElementById('readBtn').disabled, null, { timeout: 30000 });
  await p.selectOption('#sampleSel', process.argv[2] || 'ring');
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
  await b.close();
})();
