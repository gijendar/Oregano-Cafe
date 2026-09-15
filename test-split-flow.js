/* eslint-disable no-console */
// End-to-end test of the split payment flow against a locally started server.
// Uses the in-memory fallback (no Supabase env) so assertions are deterministic.
process.env.PORT = '3577';
// Ensure no Supabase env leaks in — we test the in-memory persistence path.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.SUPABASE_KEY;

const { spawn } = require('child_process');
const http = require('http');

// Force the child into in-memory mode: empty-string values are falsy but present,
// so dotenv (which never overrides existing vars) will not re-load them from .env.
const CHILD_ENV = { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_KEY: '', PORT: '3577' };

const BASE = 'http://127.0.0.1:3577';
const TOKEN = 'admin-session-token';
let failures = 0;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      host: '127.0.0.1',
      port: 3577,
      path,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': TOKEN
      }
    };
    const r = http.request(opts, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function check(name, cond, detail) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}

async function createAndPay(table, method, split) {
  // Create an order totaling the given amount
  const items = [];
  let remaining = table.total;
  // Build items that sum exactly to `total` using menu-like pricing
  items.push({ name: 'Test Item A', price: 100, qty: 1 });
  if (table.total > 100) items.push({ name: 'Test Item B', price: table.total - 100, qty: 1 });
  const ord = await req('POST', '/api/orders', { table: table.num, items });
  if (!ord.json.success) throw new Error('order create failed: ' + JSON.stringify(ord.json));
  const orderId = ord.json.order.id;

  // Admin completes the order
  const comp = await req('PATCH', '/api/orders/' + orderId, { action: 'complete' });
  if (!comp.json.success) throw new Error('complete failed');

  // Pay
  const payload = { payment_method: method };
  if (method === 'SPLIT') { payload.cash_amount = split.cash; payload.online_amount = split.online; }
  const pay = await req('POST', '/api/tables/' + table.num + '/pay', payload);
  if (!pay.json.success) throw new Error('pay failed: ' + JSON.stringify(pay.json));
  return pay.json;
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));

  // Wait for server ready
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ping = () => {
      http.get(BASE + '/health', res => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > 10000) reject(new Error('server did not start'));
        else setTimeout(ping, 300);
      });
    };
    ping();
  });

  try {
    console.log('--- TEST 1: SPLIT ₹50 cash + ₹100 online (total ₹150) ---');
    const t1 = await createAndPay({ num: 11, total: 150 }, 'SPLIT', { cash: 50, online: 100 });
    check('payment success', t1.success === true);
    check('bill.payment_method === SPLIT', t1.bill.payment_method === 'SPLIT', t1.bill.payment_method);
    check('bill.cash_amount === 50', Number(t1.bill.cash_amount) === 50, t1.bill.cash_amount);
    check('bill.online_amount === 100', Number(t1.bill.online_amount) === 100, t1.bill.online_amount);
    check('bill.total === 150', Number(t1.bill.total) === 150, t1.bill.total);
    check('payment.cash_amount === 50', Number(t1.payment.cash_amount) === 50, t1.payment.cash_amount);
    check('payment.online_amount === 100', Number(t1.payment.online_amount) === 100, t1.payment.online_amount);

    // GET BILL API (what ADMIN → BILLS → VIEW BILL uses)
    const bill1 = await req('GET', '/api/bills/' + t1.bill.bill_number);
    check('GET /api/bills/:num → payment_method SPLIT', bill1.json.payment_method === 'SPLIT');
    check('GET /api/bills/:num → cash_amount 50', Number(bill1.json.cash_amount) === 50, bill1.json.cash_amount);
    check('GET /api/bills/:num → online_amount 100', Number(bill1.json.online_amount) === 100, bill1.json.online_amount);
    check('GET /api/bills/:num → total 150', Number(bill1.json.total) === 150);

    // GET /api/bills list
    const list1 = await req('GET', '/api/bills');
    const found1 = list1.json.find(b => b.bill_number === t1.bill.bill_number);
    check('GET /api/bills list contains split values', found1 && Number(found1.cash_amount) === 50 && Number(found1.online_amount) === 100, found1);

    // Earnings API
    const today = bill1.json.payment_date;
    const earn1 = await req('GET', '/api/earnings?date=' + today);
    check('earnings totalEarnings 150', Number(earn1.json.totalEarnings) === 150, earn1.json);
    check('earnings cashTotal 50', Number(earn1.json.cashTotal) === 50, earn1.json.cashTotal);
    check('earnings onlineTotal 100', Number(earn1.json.onlineTotal) === 100, earn1.json.onlineTotal);

    // Reports API
    const rep1 = await req('GET', '/api/reports?from=' + today + '&to=' + today);
    check('reports totalEarnings 150', Number(rep1.json.totalEarnings) === 150, rep1.json.totalEarnings);
    check('reports cashTotal 50', Number(rep1.json.cashTotal) === 50, rep1.json.cashTotal);
    check('reports onlineTotal 100', Number(rep1.json.onlineTotal) === 100, rep1.json.onlineTotal);
    check('reports netProfit 150 (no expenses)', Number(rep1.json.netProfit) === 150, rep1.json.netProfit);

    console.log('--- TEST 2: INVALID SPLIT 50 + 80 ≠ 150 must be rejected ---');
    let invalidRejected = false;
    try { await createAndPay({ num: 12, total: 150 }, 'SPLIT', { cash: 50, online: 80 }); }
    catch (e) { invalidRejected = /must equal/i.test(e.message); }
    check('invalid split rejected by server', invalidRejected);

    console.log('--- TEST 3: CASH ₹150 ---');
    const t3 = await createAndPay({ num: 13, total: 150 }, 'CASH');
    check('cash bill: cash_amount 150', Number(t3.bill.cash_amount) === 150, t3.bill.cash_amount);
    check('cash bill: online_amount 0', Number(t3.bill.online_amount) === 0, t3.bill.online_amount);
    check('cash bill: method CASH', t3.bill.payment_method === 'CASH');

    console.log('--- TEST 4: ONLINE ₹150 ---');
    const t4 = await createAndPay({ num: 14, total: 150 }, 'ONLINE');
    check('online bill: cash_amount 0', Number(t4.bill.cash_amount) === 0, t4.bill.cash_amount);
    check('online bill: online_amount 150', Number(t4.bill.online_amount) === 150, t4.bill.online_amount);
    check('online bill: method ONLINE', t4.bill.payment_method === 'ONLINE');

    console.log('--- TEST 5: SPLIT ₹30 + ₹120 (total ₹150) — different split ratio ---');
    const t5 = await createAndPay({ num: 15, total: 150 }, 'SPLIT', { cash: 30, online: 120 });
    check('split2: cash 30', Number(t5.bill.cash_amount) === 30, t5.bill.cash_amount);
    check('split2: online 120', Number(t5.bill.online_amount) === 120, t5.bill.online_amount);

    console.log('--- TEST 6: Multi-order session SPLIT (₹100 order + ₹50 order = ₹150) ---');
    const o6a = await req('POST', '/api/orders', { table: 16, items: [{ name: 'A', price: 100, qty: 1 }] });
    const o6b = await req('POST', '/api/orders', { table: 16, items: [{ name: 'B', price: 50, qty: 1 }] });
    await req('PATCH', '/api/orders/' + o6a.json.order.id, { action: 'complete' });
    await req('PATCH', '/api/orders/' + o6b.json.order.id, { action: 'complete' });
    const pay6 = await req('POST', '/api/tables/16/pay', { payment_method: 'SPLIT', cash_amount: 60, online_amount: 90 });
    check('multi-order split success', pay6.json.success === true, pay6.json);
    check('multi-order split: total 150', Number(pay6.json.bill.total) === 150, pay6.json.bill.total);
    check('multi-order split: cash 60', Number(pay6.json.bill.cash_amount) === 60, pay6.json.bill.cash_amount);
    check('multi-order split: online 90', Number(pay6.json.bill.online_amount) === 90, pay6.json.bill.online_amount);

    console.log('--- TEST 7: Daily earnings across ALL test bills (1×SPLIT 50/100 + 1×CASH 150 + 1×ONLINE 150 + 1×SPLIT 30/120 + 1×SPLIT 60/90) ---');
    const earn7 = await req('GET', '/api/earnings?date=' + today);
    // total = 150+150+150+150+150 = 750; cash = 50+150+0+30+60 = 290; online = 100+0+150+120+90 = 460
    check('earnings total 750', Number(earn7.json.totalEarnings) === 750, earn7.json.totalEarnings);
    check('earnings cash 290', Number(earn7.json.cashTotal) === 290, earn7.json.cashTotal);
    check('earnings online 460', Number(earn7.json.onlineTotal) === 460, earn7.json.onlineTotal);

    console.log('\n================================');
    if (failures === 0) console.log('ALL TESTS PASSED (' + 0 + ' failures)');
    else console.log(failures + ' TEST(S) FAILED');
    console.log('================================');
  } catch (e) {
    failures++;
    console.error('TEST RUN ERROR:', e.message);
    console.error(serverLog.slice(-3000));
  } finally {
    server.kill();
    process.exit(failures === 0 ? 0 : 1);
  }
})();
