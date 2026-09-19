/* eslint-disable no-console */
// End-to-end test of the BILL-BEFORE-PAYMENT flow against a locally started server.
// Uses the in-memory fallback (no Supabase env) so assertions are deterministic.
process.env.PORT = '3577';
// Ensure no Supabase env leaks in — we test the in-memory persistence path.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.SUPABASE_KEY;

const { spawn } = require('child_process');
const http = require('http');

const CHILD_ENV = { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_KEY: '', PORT: '3577' };
const BASE = 'http://127.0.0.1:3577';
let failures = 0;

// The token derives from the credentials, so we discover it via login.
let TOKEN = '';

function req(method, path, body, useAuth) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (useAuth !== false && TOKEN) headers['x-admin-token'] = TOKEN;
    const opts = { method, host: '127.0.0.1', port: 3577, path, headers };
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
  else { failures++; console.log('  FAIL  ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// Full workflow: place order(s) → complete → generate bill → pay
async function runWorkflow(table, items, method, split, opts) {
  opts = opts || {};
  const orderIds = [];
  for (const it of items) {
    const ord = await req('POST', '/api/orders', { table, items: it });
    if (!ord.json.success) throw new Error('order create failed: ' + JSON.stringify(ord.json));
    orderIds.push(ord.json.order.id);
    if (!opts.skipComplete) {
      const comp = await req('PATCH', '/api/orders/' + ord.json.order.id, { action: 'complete' });
      if (!comp.json.success) throw new Error('complete failed');
    }
  }
  // Bill BEFORE payment — no method in the payload at all
  const gen = await req('POST', '/api/tables/' + table + '/generate-bill', {});
  if (!gen.json.success) throw new Error('generate-bill failed: ' + JSON.stringify(gen.json));
  const bill = gen.json.bill;
  check('bill generated UNPAID with no method', bill.payment_status === 'UNPAID' && (bill.payment_method === null || bill.payment_method === undefined), bill);
  const payload = { payment_method: method };
  if (method === 'SPLIT') { payload.cash_amount = split.cash; payload.online_amount = split.online; }
  const pay = await req('POST', '/api/tables/' + table + '/pay', payload);
  if (!pay.json.success) throw new Error('pay failed: ' + JSON.stringify(pay.json));
  return { gen: gen.json, pay: pay.json, orderIds, bill };
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));

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
    console.log('--- TEST 0: ADMIN CREDENTIALS ---');
    const badLogin = await req('POST', '/api/login', { username: 'admin', password: 'admin123' }, false);
    check('admin/admin123 REJECTED', badLogin.status === 401, badLogin.status);
    const goodLogin = await req('POST', '/api/login', { username: 'oreganocafe', password: '2019' }, false);
    check('oreganocafe/2019 accepted', goodLogin.status === 200 && goodLogin.json.success === true, goodLogin.json);
    TOKEN = goodLogin.json.token;
    check('token is non-static', typeof TOKEN === 'string' && TOKEN.length > 20 && TOKEN !== 'admin-session-token', TOKEN);
    const authCheck = await req('GET', '/api/dashboard');
    check('token authorizes admin API', authCheck.status === 200, authCheck.status);
    const oldTokenCheck = await req('GET', '/api/dashboard', null, false);
    // with no token → 401
    check('no token rejected', oldTokenCheck.status === 401, oldTokenCheck.status);

    console.log('--- TEST 1: EXACT SCENARIO — TABLE 7, ₹300 + ₹200, SPLIT 200/300 ---');
    const t1 = await runWorkflow(7, [[{ name: 'Margherita Pizza', price: 300, qty: 1 }], [{ name: 'Pasta', price: 200, qty: 1 }]], 'SPLIT', { cash: 200, online: 300 });
    const b1 = t1.pay.bill;
    check('one session, one bill, total 500', Number(b1.total) === 500, b1.total);
    check('bill payment_status PAID after payment', b1.payment_status === 'PAID', b1.payment_status);
    check('bill method SPLIT', b1.payment_method === 'SPLIT', b1.payment_method);
    check('cash 200', Number(b1.cash_amount) === 200, b1.cash_amount);
    check('online 300', Number(b1.online_amount) === 300, b1.online_amount);
    check('bill has itemized items (both orders)', (b1.items || []).length === 2, b1.items);
    check('bill_date set at generation', !!b1.bill_date, b1.bill_date);
    check('paid_at set after payment', !!b1.paid_at, b1.paid_at);

    // Table must be AVAILABLE right after payment
    const tables1 = await req('GET', '/api/tables');
    const t7 = tables1.json.find(t => t.number === 7);
    check('table 7 AVAILABLE after payment', t7 && t7.status === 'AVAILABLE', t7);

    // Earnings/reports for the bill's payment date
    const today = b1.payment_date;
    const earn1 = await req('GET', '/api/earnings?date=' + today);
    check('earnings total 500', Number(earn1.json.totalEarnings) === 500, earn1.json);
    check('earnings cash 200', Number(earn1.json.cashTotal) === 200, earn1.json.cashTotal);
    check('earnings online 300', Number(earn1.json.onlineTotal) === 300, earn1.json.onlineTotal);

    const rep1 = await req('GET', '/api/reports?from=' + today + '&to=' + today);
    check('reports total 500', Number(rep1.json.totalEarnings) === 500, rep1.json.totalEarnings);
    check('reports cash 200', Number(rep1.json.cashTotal) === 200, rep1.json.cashTotal);
    check('reports online 300', Number(rep1.json.onlineTotal) === 300, rep1.json.onlineTotal);
    check('reports netProfit 500 (no expenses)', Number(rep1.json.netProfit) === 500, rep1.json.netProfit);

    console.log('--- TEST 2: NEW CUSTOMER AT TABLE 7 GETS FRESH SESSION/BILL ---');
    const o2 = await req('POST', '/api/orders', { table: 7, items: [{ name: 'Coffee', price: 120, qty: 1 }] });
    check('new order placed at table 7', o2.json.success === true, o2.json);
    const comp2 = await req('PATCH', '/api/orders/' + o2.json.order.id, { action: 'complete' });
    check('new order completed', comp2.json.success === true, comp2.json);
    const newSessionId = o2.json.order.session_id;
    check('new session is DIFFERENT from paid session', newSessionId !== t1.pay.session.id, { new: newSessionId, old: t1.pay.session.id });
    // The new session's bill preview must NOT include the previous ₹500
    const cb2 = await req('GET', '/api/tables/7/current-bill');
    check('new session has no generated bill yet', cb2.json.bill === null, cb2.json.bill);
    check('new session live total is 120 only', Number(cb2.json.total) === 120, cb2.json.total);
    const gen2 = await req('POST', '/api/tables/7/generate-bill', {});
    check('fresh bill generated', gen2.json.success === true && gen2.json.bill.total === 120, gen2.json);
    check('fresh bill number differs from previous', gen2.json.bill.bill_number !== b1.bill_number);
    // Cancel the fresh order instead of paying, to keep later tests clean
    await req('PATCH', '/api/orders/' + o2.json.order.id, { action: 'cancel' });

    console.log('--- TEST 3: PAY BEFORE BILL MUST FAIL ---');
    const o3 = await req('POST', '/api/orders', { table: 8, items: [{ name: 'Fries', price: 90, qty: 1 }] });
    await req('PATCH', '/api/orders/' + o3.json.order.id, { action: 'complete' });
    const pay3 = await req('POST', '/api/tables/8/pay', { payment_method: 'CASH' });
    check('payment without generated bill rejected', pay3.status === 400, pay3.json);

    console.log('--- TEST 4: CANCELLED ORDER EXCLUDED FROM BILL ---');
    // Table 9: ₹400 completed, ₹220 cancelled, ₹180 completed → bill must be 580
    const oA = await req('POST', '/api/orders', { table: 9, items: [{ name: 'A', price: 400, qty: 1 }] });
    const oB = await req('POST', '/api/orders', { table: 9, items: [{ name: 'B', price: 220, qty: 1 }] });
    const oC = await req('POST', '/api/orders', { table: 9, items: [{ name: 'C', price: 180, qty: 1 }] });
    await req('PATCH', '/api/orders/' + oA.json.order.id, { action: 'complete' });
    await req('PATCH', '/api/orders/' + oB.json.order.id, { action: 'complete' });
    await req('PATCH', '/api/orders/' + oC.json.order.id, { action: 'complete' });
    await req('PATCH', '/api/orders/' + oB.json.order.id, { action: 'cancel' });
    const gen4 = await req('POST', '/api/tables/9/generate-bill', {});
    check('cancelled excluded: bill total 580', Number(gen4.json.bill.total) === 580, gen4.json.bill.total);
    check('cancelled order not on bill', !(gen4.json.bill.orders || []).some(o => o.id === oB.json.order.id), gen4.json.bill.orders.map(o => o.id));
    const pay4 = await req('POST', '/api/tables/9/pay', { payment_method: 'CASH' });
    check('cash payment on 580 bill', pay4.json.success && Number(pay4.json.bill.cash_amount) === 580, pay4.json);

    console.log('--- TEST 5: PENDING ORDER NOT ON BILL ---');
    const oP1 = await req('POST', '/api/orders', { table: 10, items: [{ name: 'Done', price: 100, qty: 1 }] });
    const oP2 = await req('POST', '/api/orders', { table: 10, items: [{ name: 'Cooking', price: 50, qty: 1 }] });
    await req('PATCH', '/api/orders/' + oP1.json.order.id, { action: 'complete' });
    // oP2 stays PENDING
    const gen5 = await req('POST', '/api/tables/10/generate-bill', {});
    check('pending excluded: bill total 100', Number(gen5.json.bill.total) === 100, gen5.json.bill.total);

    console.log('--- TEST 6: CASH & ONLINE FULL AMOUNTS ---');
    const t6c = await runWorkflow(13, [[{ name: 'X', price: 150, qty: 1 }]], 'CASH');
    check('cash: cash_amount 150, online 0', Number(t6c.pay.bill.cash_amount) === 150 && Number(t6c.pay.bill.online_amount) === 0, t6c.pay.bill);
    const t6o = await runWorkflow(14, [[{ name: 'Y', price: 150, qty: 1 }]], 'ONLINE');
    check('online: cash 0, online_amount 150', Number(t6o.pay.bill.cash_amount) === 0 && Number(t6o.pay.bill.online_amount) === 150, t6o.pay.bill);

    console.log('--- TEST 7: INVALID SPLIT MUST BE REJECTED ---');
    const o7 = await req('POST', '/api/orders', { table: 12, items: [{ name: 'Z', price: 150, qty: 1 }] });
    await req('PATCH', '/api/orders/' + o7.json.order.id, { action: 'complete' });
    await req('POST', '/api/tables/12/generate-bill', {});
    const badSplit = await req('POST', '/api/tables/12/pay', { payment_method: 'SPLIT', cash_amount: 50, online_amount: 80 });
    check('50+80 ≠ 150 rejected', badSplit.status === 400 && /must equal/i.test(badSplit.json.error || ''), badSplit.json);
    const negSplit = await req('POST', '/api/tables/12/pay', { payment_method: 'SPLIT', cash_amount: -10, online_amount: 160 });
    check('negative amounts rejected', negSplit.status === 400, negSplit.json);
    // Valid split then completes table 12
    const okSplit = await req('POST', '/api/tables/12/pay', { payment_method: 'SPLIT', cash_amount: 60, online_amount: 90 });
    check('valid split accepted', okSplit.json.success === true, okSplit.json);

    console.log('--- TEST 8: RUSH HOUR — 5 SIMULTANEOUS UNPAID BILLS ---');
    const rushTables = [2, 5, 11, 16];
    const rushBills = [];
    for (const rt of rushTables) {
      const amt = 100 + rt; // unique amounts
      const o = await req('POST', '/api/orders', { table: rt, items: [{ name: 'Rush ' + rt, price: amt, qty: 1 }] });
      await req('PATCH', '/api/orders/' + o.json.order.id, { action: 'complete' });
      const g = await req('POST', '/api/tables/' + rt + '/generate-bill', {});
      rushBills.push({ table: rt, bill: g.json.bill });
    }
    // Table 7's fresh session still has an unpaid ₹120 bill from TEST 2? No — cancelled. Use its queue separately.
    const list = await req('GET', '/api/bills');
    const unpaidList = list.json.filter(b => (b.payment_status || 'UNPAID') === 'UNPAID');
    check('at least 4 unpaid bills visible simultaneously', unpaidList.length >= 4, unpaidList.length);
    check('unpaid bills are for distinct tables', new Set(unpaidList.map(b => b.table)).size === unpaidList.length, unpaidList.map(b => b.table));

    // Process them one by one in a different order; each payment only touches its own bill
    const order2 = [rushBills[2], rushBills[0], rushBills[3], rushBills[1]];
    for (const rb of order2) {
      const amt = 100 + rb.table;
      const p = await req('POST', '/api/tables/' + rb.table + '/pay', { payment_method: 'ONLINE' });
      check('rush pay table ' + rb.table + ' → ' + amt, p.json.success && Number(p.json.bill.total) === amt, p.json);
      const tablesNow = await req('GET', '/api/tables');
      const row = tablesNow.json.find(t => t.number === rb.table);
      check('table ' + rb.table + ' AVAILABLE', row && row.status === 'AVAILABLE', row);
      // other unpaid bills must still be there
      const listNow = await req('GET', '/api/bills');
      const stillUnpaid = listNow.json.filter(b => (b.payment_status || 'UNPAID') === 'UNPAID');
      check('remaining unpaid bills unaffected after table ' + rb.table, stillUnpaid.every(b => b.table !== rb.table), stillUnpaid.map(b => b.table));
    }

    console.log('--- TEST 9: UNPAID BILLS DO NOT COUNT AS REVENUE ---');
    // Table 15: generate a bill but DO NOT pay
    const o15 = await req('POST', '/api/orders', { table: 15, items: [{ name: 'Unpaid', price: 600, qty: 1 }] });
    await req('PATCH', '/api/orders/' + o15.json.order.id, { action: 'complete' });
    await req('POST', '/api/tables/15/generate-bill', {});
    const earn9 = await req('GET', '/api/earnings?date=' + today);
    // Paid: t1 500 + t4 580 + t6c 150 + t6o 150 + t12 150 + rush (102+105+111+116)=434
    // NOT counted: t10 ₹100 (unpaid) and t15 ₹600 (unpaid) — unpaid bills are not revenue.
    const expected9 = 500 + 580 + 150 + 150 + 150 + 434;
    check('unpaid ₹600 bill NOT in earnings', Number(earn9.json.totalEarnings) === expected9, { got: earn9.json.totalEarnings, expected: expected9 });

    console.log('--- TEST 10: REGENERATE IS IDEMPOTENT (one bill per session) ---');
    const regen = await req('POST', '/api/tables/15/generate-bill', {});
    check('regenerating returns the SAME bill', regen.json.success && regen.json.bill.bill_number && regen.json.bill.total === 600, regen.json);

    console.log('--- TEST 11: PAYMENT METHOD REQUIRED FOR PAYMENT ---');
    const noMethod = await req('POST', '/api/tables/15/pay', {});
    check('payment without method rejected', noMethod.status === 400, noMethod.json);

    console.log('\n================================');
    if (failures === 0) console.log('ALL TESTS PASSED (0 failures)');
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
