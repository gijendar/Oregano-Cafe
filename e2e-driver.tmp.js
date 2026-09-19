const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(p => fs.existsSync(p));
  if (!candidates.length) { console.error('No Chrome/Edge found'); process.exit(2); }

  const chrome = spawn(candidates[0], [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--user-data-dir=' + process.env.TEMP + '\\toc-e2e-' + Date.now(),
    '--no-first-run',
    '--window-size=1280,900',
    '--disable-gpu',
    'http://127.0.0.1:3578/?table=7#e2e'
  ], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { await getJSON('http://127.0.0.1:9223/json/version'); up = true; break; } catch (e) { await wait(250); }
  }
  if (!up) { console.error('CDP never came up'); chrome.kill(); process.exit(2); }
  console.log('Browser up — harness running...');

  let results = null;
  for (let i = 0; i < 120; i++) {
    await wait(500);
    try {
      const r = await getJSON('http://127.0.0.1:3578/__e2e_results');
      if (r && r.results) { results = r; break; }
    } catch (e) { /* not yet */ }
  }
  chrome.kill();
  if (!results) { console.error('E2E results never arrived (timeout)'); process.exit(3); }
  console.log(results.results.join('\n'));
  process.exit(results.failures === 0 ? 0 : 1);
})();
