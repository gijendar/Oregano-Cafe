// Browser E2E harness — injected into index.html ONLY when #e2e is in the URL.
// Self-contained: runs the bill-before-payment workflow in-page and posts results
// to /__e2e_results. Never executes for normal customers/admins.
if (window.location.hash === '#e2e') {
(async function () {
  const results = [];
  let failures = 0;
  const report = () => { try { navigator.sendBeacon('/__e2e_results', new Blob([JSON.stringify({ results, failures })], { type: 'application/json' })); } catch (e) {} };
  function check(name, cond, detail) {
    if (cond) { results.push('PASS  ' + name); }
    else { failures++; results.push('FAIL  ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); }
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  try {
    // ---- CUSTOMER SIDE ----
    // Already loaded as /?table=7#e2e — act as the customer directly.
    history.replaceState(null, '', '/?table=7');

    check('customer: table badge TABLE 7', document.getElementById('tableBadge').textContent === 'TABLE 7');
    check('customer: MY BILL button present', !!document.getElementById('myBillBtn'));

    document.getElementById('myBillBtn').click();
    await wait(1000);
    let billBox = document.getElementById('myBillContent').innerText;
    check('customer: MY BILL empty state (nothing served yet)', /No items on your bill yet|staff/i.test(billBox || ''), billBox);
    closeMyBill();

    // Order 1 (₹300) via page fetch (production code path) — starts as PENDING
    window.__o1 = await fetch(API_BASE + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 7, items: [{ name: 'Margherita Pizza', price: 300, qty: 1, options: [] }] }) }).then(r => r.json());
    check('order 1 (₹300) placed', window.__o1 && window.__o1.success === true, window.__o1);

    // ---- ADMIN SIDE ----
    history.replaceState(null, '', '/#admin');
    window.location.hash = '#admin';
    window.dispatchEvent(new Event('hashchange'));
    await wait(600);

    document.getElementById('adminEmail').value = 'oreganocafe';
    document.getElementById('adminPassword').value = '2019';
    document.getElementById('adminLoginBtn').click();
    await wait(1800);
    check('admin: oreganocafe/2019 → dashboard visible', document.getElementById('adminLayout').classList.contains('active'));

    const badStatus = await fetch(API_BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(r => r.status);
    check('admin: admin/admin123 rejected 401', badStatus === 401, badStatus);

    // Serve (complete) order 1 — then the customer preview must show it
    await fetch(API_BASE + '/orders/' + window.__o1.order.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': API_TOKEN }, body: JSON.stringify({ action: 'complete' }) }).then(r => r.json());

    // Customer preview (public endpoint, no login) — completed+unpaid items visible
    const prev = await fetch(API_BASE + '/customer/tables/7/current-bill').then(r => r.json());
    check('customer preview shows served ₹300 item', prev && prev.total === 300 && (prev.orders || []).length === 1, prev);
    check('customer preview has NO generated bill yet', prev && prev.bill === null, prev);
    window.__gen = await fetch(API_BASE + '/tables/7/generate-bill', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': API_TOKEN }, body: JSON.stringify({}) }).then(r => r.json());
    check('bill generated UNPAID, no method', window.__gen.success && window.__gen.bill.payment_status === 'UNPAID' && !window.__gen.bill.payment_method, window.__gen);
    const billNum = window.__gen.bill.bill_number;

    // Order 2 (₹200) placed and completed AFTER bill generation → must NOT be on the unpaid bill (one bill, generated snapshot)
    window.__o2 = await fetch(API_BASE + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: 7, items: [{ name: 'Penne Rosa', price: 200, qty: 1, options: [] }] }) }).then(r => r.json());
    await fetch(API_BASE + '/orders/' + window.__o2.order.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': API_TOKEN }, body: JSON.stringify({ action: 'complete' }) }).then(r => r.json());

    // BILLS queue
    await renderAdminSection('bills');
    await wait(900);
    const billsTxt = document.getElementById('adminContent').innerText;
    check('BILLS queue shows UNPAID bill', /UNPAID/.test(billsTxt || ''), (billsTxt || '').slice(0, 150));
    check('BILLS queue shows bill number', new RegExp(billNum).test(billsTxt || ''));
    check('BILLS queue has RECORD PAYMENT', /RECORD PAYMENT/.test(billsTxt || ''));
    check('UNPAID filter chip with count', /UNPAID\s*\(\d+\)/.test(billsTxt || ''));

    // Bill detail receipt
    await viewHistoricalBill(billNum);
    await wait(700);
    const receipt = (document.querySelector('.receipt-bill') || {}).innerText || '';
    check('receipt: Oregano header', /THE OREGANO CAFE/.test(receipt));
    check('receipt: bill no + table + session', /Bill No/.test(receipt) && /Table No/.test(receipt) && /Session/.test(receipt));
    check('receipt: UNPAID and NO method', /UNPAID/.test(receipt) && !/(CASH|ONLINE|SPLIT)/.test(receipt.toUpperCase()), receipt);
    check('receipt: A4 + thermal buttons', document.body.innerHTML.includes('PRINT (A4)') && document.body.innerHTML.includes('80mm THERMAL'));
    check('receipt: total is ₹300 (bill-before-order-2)', /300/.test(receipt), receipt.slice(0, 300));

    // RECORD PAYMENT modal + invalid split
    recordPaymentFromQueue(billNum);
    await wait(500);
    check('RECORD PAYMENT modal opens', document.getElementById('adminModal').classList.contains('active'));
    selectPayment('SPLIT');
    await wait(200);
    document.getElementById('splitCash').value = '100';
    document.getElementById('splitOnline').value = '100';
    document.getElementById('splitCash').dispatchEvent(new Event('input'));
    await wait(100);
    check('split live calc: total paid ₹200 shown', /200/.test(document.getElementById('splitTotalPaid').textContent || ''));
    confirmRecordPayment(7);
    await wait(400);
    check('invalid split (100+100≠300) BLOCKED at confirm', !document.getElementById('adminConfirm').classList.contains('active'));
    check('modal still open — nothing paid', document.getElementById('adminModal').classList.contains('active'));

    // Valid payment: ONLINE ₹300
    selectPayment('ONLINE');
    await wait(150);
    confirmRecordPayment(7);
    await wait(300);
    await doSettlePayment(7);
    // Read the success receipt SYNCHRONOUSLY — SSE re-renders the section within ~100ms
    const paidReceipt = (document.querySelector('.receipt-bill') || {}).innerText || '';
    check('paid receipt: PAID status', /PAID/.test(paidReceipt || ''), paidReceipt.slice(0, 200));
    check('paid receipt: Total Paid shown', /Total Paid/.test(paidReceipt || ''));
    check('paid receipt: ONLINE method shown', /ONLINE/.test(paidReceipt || ''));
    await wait(1500); // let the SSE-driven refresh settle

    // Thermal print doc (built in-page, no popup needed to assert content)
    const b = await getBill(billNum);
    const thermal = printBillThermalHTML(b);
    check('thermal doc: 80mm page', /size:\s*80mm/.test(thermal));
    check('thermal doc: PAID + method', /\*\*\* PAID \*\*\*/.test(thermal) && /ONLINE/.test(thermal));
    check('thermal doc: items + total', /Margherita Pizza/.test(thermal) && /TOTAL/.test(thermal));

    // Table 7 available
    await renderAdminSection('tables');
    await wait(900);
    const tablesTxt = document.getElementById('adminContent').innerText;
    check('TABLES: table 7 AVAILABLE after payment', /TABLE 7[\s\S]{0,80}AVAILABLE/.test(tablesTxt || ''), (tablesTxt || '').slice(0, 250));

    // Customer API (public, no login) — session closed, no unpaid bill remains
    const cb = await fetch(API_BASE + '/customer/tables/7/current-bill').then(r => r.json());
    check('post-payment: public current-bill shows session settled (no unpaid bill)', cb && !cb.bill, cb);
    const cbPaid = await fetch(API_BASE + '/bills').then(r => r.status); // should 401 without token
    check('customer cannot list all bills (401)', cbPaid === 401, cbPaid);
  } catch (e) {
    failures++;
    results.push('FAIL  E2E RUN ERROR — ' + (e && e.message));
  }

  results.push('SUMMARY ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURES'));
  report();
  try {
    await fetch('/__e2e_results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results, failures }) });
  } catch (e) { /* reporting endpoint may be absent */ }
})();
}
