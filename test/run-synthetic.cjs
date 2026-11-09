const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  p.on('console', (m) => process.stdout.write('· ' + m.text() + '\n')); p.on('pageerror', (e) => console.log('ERR', e.message, e.stack));
  await p.goto('http://localhost:8123/test/synthetic.html' + (process.argv[2] || ''));
  await p.waitForFunction(() => window.RESULT, null, { timeout: 300000 });
  console.log(JSON.stringify(await p.evaluate(() => window.RESULT), null, 1));
  if (process.argv[3]) await p.screenshot({ path: process.argv[3], fullPage: true });
  await b.close();
})();
