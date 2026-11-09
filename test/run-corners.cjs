const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('console', m => console.log('console:', m.text())); p.on('pageerror', e => console.log('err:', e.message));
  await p.goto('http://localhost:8123/test/' + (process.argv[2] || 'corners.html'));
  await p.waitForFunction(() => window.RESULT, null, { timeout: 120000 });
  console.log(JSON.stringify(await p.evaluate(() => window.RESULT), null, 1));
  await b.close();
})();
