// ===========================
// ADMIN APP LOGIC
// Table-Based Billing / Dining Session Workflow
// ===========================

let currentAdminSection = 'dashboard';
let sseSource = null;
let selectedPaymentMethod = null;
let currentTableBillNum = null;
let currentBillTotal = 0; // authoritative total for SPLIT validation (from server)

// Validate a SPLIT payment client-side. Mirrors the server rule:
// cash_amount + online_amount MUST equal the bill total exactly.
function validateSplitAmounts(total) {
  const cashInput = document.getElementById('splitCash');
  const onlineInput = document.getElementById('splitOnline');
  const cash = cashInput ? (parseFloat(cashInput.value) || 0) : 0;
  const online = onlineInput ? (parseFloat(onlineInput.value) || 0) : 0;
  if (cash < 0 || online < 0) return 'Cash and Online amounts cannot be negative.';
  if (cash === 0 && online === 0) return 'Please enter the Cash and/or Online amounts for the split payment.';
  const paid = Math.round((cash + online) * 100) / 100;
  const expected = Math.round(total * 100) / 100;
  if (paid !== expected) {
    return 'Cash (\u20B9' + cash + ') + Online (\u20B9' + online + ') = \u20B9' + paid + ' must equal the bill total (\u20B9' + expected + ').';
  }
  return null; // valid
}

// ===========================
// IST TIMEZONE UTILITIES (Asia/Kolkata, UTC+05:30)
// ===========================
function getISTNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 60 * 60 * 1000);
}
function formatISTDateTime(date) {
  const d = date instanceof Date ? date : getISTNow();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  let hours = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return {
    date: yyyy + '-' + mm + '-' + dd,
    dateDisplay: dd + '/' + mm + '/' + yyyy,
    time12h: String(hours).padStart(2, '0') + ':' + min + ' ' + ampm,
    time24h: String(d.getHours()).padStart(2, '0') + ':' + min,
    timestamp: d.toISOString()
  };
}
function getISTDateStr() {
  return formatISTDateTime(getISTNow()).date;
}
function getISTTimeStr() {
  return formatISTDateTime(getISTNow()).time12h + ' IST';
}

// ===========================
// SSE REALTIME CONNECTION
// ===========================
function connectRealtime() {
  if (typeof EventSource === 'undefined') {
    console.warn('[SSE] EventSource not supported in this browser');
    return;
  }
  try {
    connectSSE();
  } catch(e) {
    console.warn('[SSE] Realtime connection failed:', e.message);
  }
}

function connectSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  try {
    sseSource = new EventSource(API_BASE + '/events?token=' + API_TOKEN);
    console.log('[SSE] Connected to', API_BASE + '/events?token=' + API_TOKEN.substring(0, 20) + '...');
  } catch(e) {
    console.warn('SSE connection failed:', e.message);
    sseSource = null;
    return;
  }
  sseSource.addEventListener('new_order', e => {
    showToast('🔔 New order received!');
    console.log('[SSE] new_order received, refreshing current section:', currentAdminSection);
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('order_completed', e => {
    console.log('[SSE] order_completed received, refreshing current section:', currentAdminSection);
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('order_cancelled', e => {
    console.log('[SSE] order_cancelled received, refreshing current section:', currentAdminSection);
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('order_deleted', e => {
    console.log('[SSE] order_deleted received, refreshing current section:', currentAdminSection);
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('table_paid', e => {
    console.log('[SSE] table_paid received, refreshing current section:', currentAdminSection);
    showToast('💰 Table payment settled!');
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('session_deleted', e => {
    console.log('[SSE] session_deleted received, refreshing current section:', currentAdminSection);
    showToast('🗑️ Session removed');
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.onmessage = function(e) {
    console.log('[SSE] unhandled message:', e.event, e.data);
  };
  sseSource.onerror = () => {
    sseSource.close();
    sseSource = null;
  };
}

// ===========================
// SESSION VERIFICATION
// Uses a lightweight GET to verify the saved token is still valid.
// ===========================
async function tryRestoreSession() {
  if (!loadAdminAuth()) return false;
  if (!API_TOKEN) return false;
  try {
    const res = await fetch(API_BASE + '/dashboard', {
      method: 'GET',
      headers: { 'X-Admin-Token': API_TOKEN }
    });
    return res.ok;
  } catch(e) {
    console.warn('Session verification failed:', e.message);
  }
  return false;
}

// ===========================
// ADMIN INIT
// ===========================
if (isAdminPage) {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('header').style.display = 'none';
  document.getElementById('footer').style.display = 'none';
  document.getElementById('floatingCart').style.display = 'none';
  document.getElementById('mainContent').style.display = 'none';

  // If we have a saved token, verify it before showing dashboard
  if (loadAdminAuth() && API_TOKEN) {
    tryRestoreSession().then(valid => {
      if (valid) {
        showAdminDashboard();
      } else {
        // Token expired or invalid — clear and show login
        saveAdminAuth(false);
        showAdminLogin();
      }
    }).catch(() => {
      // Network error — still show login
      showAdminLogin();
    });
  } else {
    showAdminLogin();
  }
}

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#admin') {
    document.getElementById('landing').style.display = 'none';
    document.getElementById('header').style.display = 'none';
    document.getElementById('footer').style.display = 'none';
    document.getElementById('floatingCart').style.display = 'none';
    document.getElementById('mainContent').style.display = 'none';

    if (loadAdminAuth() && API_TOKEN) {
      tryRestoreSession().then(valid => {
        if (valid) {
          showAdminDashboard();
        } else {
          saveAdminAuth(false);
          showAdminLogin();
        }
      }).catch(() => {
        showAdminLogin();
      });
    } else {
      showAdminLogin();
    }
  } else if (window.location.hash === '' || window.location.hash !== '#admin') {
    if ($('adminLayout').classList.contains('active') || $('adminLoginPage').style.display === 'flex') {
      window.location.reload();
    }
  }
});

async function showAdminLogin() {
  $('adminLoginPage').style.display = 'flex';
  $('adminLayout').classList.remove('active');
  const landing = $('landing'); if (landing) landing.style.display = 'none';
  const hdr = $('header'); if (hdr) hdr.style.display = 'none';
  const ftr = $('footer'); if (ftr) ftr.style.display = 'none';
  const fc = $('floatingCart'); if (fc) fc.style.display = 'none';
  const mc = $('mainContent'); if (mc) mc.style.display = 'none';

  // Clear any previous loading state in adminContent
  const content = $('adminContent');
  if (content) content.innerHTML = '';

  $('adminLoginBtn').onclick = async () => {
    const email = $('adminEmail').value.trim();
    const pass = $('adminPassword').value;

    if (!email || !pass) {
      $('adminError').textContent = 'Please enter both username and password.';
      $('adminError').classList.add('show');
      return;
    }

    // Disable button and show loading state
    $('adminLoginBtn').disabled = true;
    $('adminLoginBtn').textContent = 'SIGNING IN...';
    $('adminError').classList.remove('show');

    try {
      const res = await fetch(API_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password: pass })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        // Successful authentication — save session and initialize dashboard
        setApiToken(data.token);
        saveAdminAuth(true);
        $('adminError').classList.remove('show');
        // Initialize dashboard directly from confirmed auth state
        showAdminDashboard();
      } else if (res.status === 401) {
        $('adminError').textContent = 'Invalid credentials. Please check your ID and password.';
        $('adminError').classList.add('show');
      } else {
        $('adminError').textContent = 'Unable to connect to the server. Please try again.';
        $('adminError').classList.add('show');
      }
    } catch(e) {
      console.error('Login error:', e);
      $('adminError').textContent = 'Unable to connect to the server. Please try again.';
      $('adminError').classList.add('show');
    } finally {
      $('adminLoginBtn').disabled = false;
      $('adminLoginBtn').textContent = 'LOGIN';
    }
  };
  // Remove old keydown listener by cloning (prevents duplicate listeners)
  const oldPw = $('adminPassword');
  const newPw = oldPw.cloneNode(true);
  oldPw.parentNode.replaceChild(newPw, oldPw);
  newPw.addEventListener('keydown', e => { if (e.key === 'Enter') $('adminLoginBtn').click() });
  $('adminEmail').focus();
}

function showAdminDashboard() {
  try {
    // Hide all non-admin elements
    $('adminLoginPage').style.display = 'none';
    const landing = $('landing'); if (landing) landing.style.display = 'none';
    const hdr = $('header'); if (hdr) hdr.style.display = 'none';
    const ftr = $('footer'); if (ftr) ftr.style.display = 'none';
    const fc = $('floatingCart'); if (fc) fc.style.display = 'none';
    const mc = $('mainContent'); if (mc) mc.style.display = 'none';

    // Show admin layout immediately — dashboard shell visible before data loads
    $('adminLayout').classList.add('active');

    // Load data asynchronously — one failed request won't hide the dashboard
    renderAdminSection(currentAdminSection).catch(err => {
      console.error('Dashboard section load failed:', err);
      const content = $('adminContent');
      if (content) content.innerHTML = '<div class="admin-empty"><h3>Unable to load this section</h3><p>Please try refreshing the page.</p></div>';
    });

    // Connect realtime — wrapped to prevent errors from blocking UI
    connectRealtime();

    // Nav item clicks — only attach once
    document.querySelectorAll('.admin-nav-item').forEach(item => {
      item.addEventListener('click', () => {
        currentAdminSection = item.dataset.section;
        document.querySelectorAll('.admin-nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        renderAdminSection(currentAdminSection).catch(() => {});
        $('adminSidebar').classList.remove('open');
      });
    });

    $('adminHamburger').onclick = () => $('adminSidebar').classList.toggle('open');

    $('adminLogoutBtn').onclick = () => {
      if (sseSource) { sseSource.close(); sseSource = null; }
      saveAdminAuth(false);
      window.location.href = '/';
    };
  } catch(e) {
    console.error('Dashboard initialization error:', e);
    // Ensure layout is visible even if something fails
    $('adminLayout').classList.add('active');
    const content = $('adminContent');
    if (content) content.innerHTML = '<div class="admin-empty"><h3>Something went wrong</h3><p>Please refresh the page.</p></div>';
  }
}

// ===========================
// RENDER ADMIN SECTION
// ===========================
async function renderAdminSection(section) {
  const title = $('adminPageTitle');
  const content = $('adminContent');
  if (!content) {
    console.error('renderAdminSection: adminContent not found');
    return;
  }
  content.innerHTML = '<div class="loading-spinner">Loading...</div>';
  try {
    // Load orders, expenses, and tables in parallel for faster response
    const [orders, expenses, tables] = await Promise.all([
      loadOrders().catch(e => { console.warn('loadOrders failed:', e.message); return []; }),
      loadExpenses().catch(e => { console.warn('loadExpenses failed:', e.message); return []; }),
      apiCall('GET', '/tables').catch(e => { console.warn('loadTables failed:', e.message); return []; })
    ]);
    switch (section) {
      case 'dashboard': await renderDashboard(content, orders, expenses, tables); title.textContent = 'DASHBOARD'; break;
      case 'pending': renderOrders(content, orders, 'PENDING'); title.textContent = 'PENDING ORDERS'; break;
      case 'completed': renderOrders(content, orders, 'COMPLETED'); title.textContent = 'COMPLETED ORDERS'; break;
      case 'cancelled': renderOrders(content, orders, 'CANCELLED'); title.textContent = 'CANCELLED ORDERS'; break;
      case 'history': await renderOrderHistory(content); title.textContent = 'ORDER HISTORY'; break;
      case 'earnings': await renderEarnings(content, orders, expenses); title.textContent = 'DAILY EARNINGS'; break;
      case 'expenses': renderExpenses(content, expenses); title.textContent = 'EXPENSES'; break;
      case 'reports': renderReports(content, orders, expenses); title.textContent = 'FINANCIAL REPORTS'; break;
      case 'bills': renderBills(content); title.textContent = 'BILLS'; break;
      case 'tables': renderTables(content, orders); title.textContent = 'TABLES'; break;
      case 'settings': renderSettings(content); title.textContent = 'SETTINGS'; break;
    }
  } catch(e) {
    console.error('renderAdminSection error:', e);
    content.innerHTML = '<div class="admin-empty"><h3>Unable to load this section</h3><p>Please try again.</p></div>';
  }
}

// ===========================
// DASHBOARD
// ===========================
async function renderDashboard(el, orders, expenses, tables) {
  const today = getISTDateStr();
  const pending = orders.filter(o => o.order_status === 'PENDING');

  // Fetch authoritative dashboard data from server (uses bills for earnings)
  const dashData = await apiCall('GET', '/dashboard');

  const todayOrdersCount = dashData ? dashData.todayOrdersCount : 0;
  const earnings = dashData ? dashData.earnings : 0;
  const cashTotal = dashData ? dashData.cashTotal : 0;
  const onlineTotal = dashData ? dashData.onlineTotal : 0;
  const todayExpenses = dashData ? dashData.expenses : 0;
  const profit = dashData ? dashData.profit : 0;
  const completedTodayCount = dashData ? dashData.completedTodayCount : 0;
  const cancelledTodayCount = dashData ? dashData.cancelledTodayCount : 0;

  console.log('[DASHBOARD] Server data - Sessions:', todayOrdersCount, 'Earnings:', earnings);

  // Calculate available/occupied tables from tables API data
  const totalTables = 20;
  const occupiedTables = (tables || []).filter(t => t.status === 'OCCUPIED').length;
  const availableTables = totalTables - occupiedTables;

  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-label">TODAY'S ORDERS</div><div class="stat-card-value">${todayOrdersCount}</div></div>
      <div class="stat-card"><div class="stat-card-label">PENDING ORDERS</div><div class="stat-card-value pending">${pending.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">COMPLETED TODAY</div><div class="stat-card-value completed">${completedTodayCount}</div></div>
      <div class="stat-card"><div class="stat-card-label">CANCELLED TODAY</div><div class="stat-card-value cancelled">${cancelledTodayCount}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S EARNINGS</div><div class="stat-card-value">${formatPrice(earnings)}</div></div>
      <div class="stat-card"><div class="stat-card-label">CASH</div><div class="stat-card-value">${formatPrice(cashTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">ONLINE</div><div class="stat-card-value">${formatPrice(onlineTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S EXPENSES</div><div class="stat-card-value">${formatPrice(todayExpenses)}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S NET</div><div class="stat-card-value ${profit >= 0 ? 'profit' : 'loss'}">${profit >= 0 ? '+' : ''}${formatPrice(profit)}</div></div>
      <div class="stat-card"><div class="stat-card-label">AVAILABLE TABLES</div><div class="stat-card-value">${availableTables}</div></div>
      <div class="stat-card"><div class="stat-card-label">OCCUPIED TABLES</div><div class="stat-card-value pending">${occupiedTables}</div></div>
    </div>
    <h3 style="font-family:'Playfair Display',serif;font-size:20px;color:var(--olive-dark);margin-bottom:16px">Recent Pending Orders</h3>
    ${pending.length === 0 ? '<div class="admin-empty"><h3>NO PENDING ORDERS</h3><p>All caught up! No orders are waiting.</p></div>' : ''}
    ${pending.slice(-5).reverse().map(o => orderCardHTML(o)).join('')}
  `;
}

// ===========================
// ORDERS (PENDING / COMPLETED / CANCELLED)
// ===========================
function renderOrders(el, orders, status) {
  const filtered = orders.filter(o => o.order_status === status);
  const title = status.charAt(0) + status.slice(1).toLowerCase();

  if (status === 'COMPLETED') {
    el.innerHTML = `
      ${filtered.length === 0 ? '<div class="admin-empty"><h3>NO COMPLETED ORDERS</h3><p>No orders have been completed yet.</p></div>' : ''}
      ${filtered.slice().reverse().map(o => orderCardHTML(o)).join('')}
    `;
  } else {
    el.innerHTML = `
      ${filtered.length === 0 ? '<div class="admin-empty"><h3>NO ' + title.toUpperCase() + ' ORDERS</h3><p>' + (status === 'PENDING' ? 'All caught up! No orders are waiting.' : 'No orders found with this status.') + '</p></div>' : ''}
      ${filtered.slice().reverse().map(o => orderCardHTML(o)).join('')}
    `;
  }
}

function orderCardHTML(o) {
  const items = o.items.map(i => i.qty + ' × ' + i.name).join('<br>');
  let paymentInfo = '';
  if (o.payment_status === 'PAID') {
    const methodLabel = o.payment_method === 'SPLIT' ? 'SPLIT' : (o.payment_method || '');
    paymentInfo = `<span class="status-badge status-paid">PAID — ${methodLabel}</span>`;
  } else if (o.payment_status === 'UNPAID' && o.order_status === 'COMPLETED') {
    paymentInfo = `<span class="status-badge status-unpaid">UNPAID</span>`;
  } else if (o.payment_status === 'NOT_APPLICABLE') {
    paymentInfo = `<span class="status-badge status-na">N/A</span>`;
  }
  let typeInfo = '';

  let actions = '';
  if (o.order_status === 'PENDING') {
    actions = `
      <div class="order-card-actions">
        <button class="btn-view" onclick="viewOrder('${o.id}')">VIEW ORDER</button>
        <button class="btn-complete" onclick="confirmAction('${o.id}','complete')">✓ COMPLETE</button>
        <button class="btn-cancel" onclick="confirmAction('${o.id}','cancel')">✕ CANCEL</button>
      </div>
    `;
  } else if (o.order_status === 'COMPLETED') {
    actions = `
      <div class="order-card-actions">
        <span class="status-badge status-completed">COMPLETED</span>
        ${paymentInfo}
        <button class="btn-remove" onclick="confirmDeleteOrder('${o.id}')">REMOVE ORDER</button>
      </div>
    `;
  } else if (o.order_status === 'CANCELLED') {
    actions = `
      <div class="order-card-actions">
        <span class="status-badge status-cancelled">CANCELLED</span>
        ${paymentInfo}
        <button class="btn-remove" onclick="confirmDeleteOrder('${o.id}')">REMOVE ORDER</button>
      </div>
    `;
  }

  return `
    <div class="order-card">
      <div class="order-card-header">
        <div><div class="order-card-id">${o.id}</div><div class="order-card-table">TABLE ${o.table}</div></div>
        <div class="order-card-time">${o.time}${o.date ? ' · ' + o.date : ''}</div>
      </div>
      ${typeInfo}
      <div class="order-card-items">${items}</div>
      <div class="order-card-total">${formatPrice(o.total)}</div>
      ${actions}
    </div>
  `;
}

// ===========================
// VIEW ORDER MODAL
// ===========================
async function viewOrder(orderId) {
  const orders = await loadOrders();
  const o = orders.find(or => or.id === orderId);
  if (!o) return;
  const items = o.items.map(i => `<div class="report-row"><span>${i.qty} × ${i.name}</span><span>${formatPrice(i.price * i.qty)}</span></div>`).join('');

  let paymentInfo = '';
  if (o.payment_status === 'PAID') {
    paymentInfo = `<div style="margin-bottom:8px"><span class="status-badge status-paid">PAID — ${o.payment_method || ''}</span></div>`;
  } else if (o.payment_status === 'UNPAID' && o.order_status === 'COMPLETED') {
    paymentInfo = `<div style="margin-bottom:8px"><span class="status-badge status-unpaid">UNPAID</span></div>`;
  } else if (o.payment_status === 'NOT_APPLICABLE') {
    paymentInfo = `<div style="margin-bottom:8px"><span class="status-badge status-na">NOT APPLICABLE</span></div>`;
  }

  let typeLine='';
  $('adminModalBox').innerHTML = `
    <h3>ORDER #${o.id}</h3>
    <div style="margin-bottom:8px"><strong>TABLE ${o.table}</strong></div>
    ${typeLine}
    ${o.session_id ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Session: ' + o.session_id + '</div>' : ''}
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">ORDERED AT: ${o.time} · ${o.date}</div>
    <div style="margin-bottom:8px"><span class="status-badge status-${o.order_status.toLowerCase()}">${o.order_status}</span></div>
    ${paymentInfo}
    ${o.completed_at ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Served: ' + formatISTFull(new Date(o.completed_at)) + '</div>' : ''}
    ${o.cancelled_at ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Cancelled: ' + formatISTFull(new Date(o.cancelled_at)) + '</div>' : ''}
    ${o.paid_at ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Paid: ' + formatISTFull(new Date(o.paid_at)) + '</div>' : ''}
    <div style="border-top:1px solid var(--border);padding-top:12px">${items}</div>
    <div class="report-row total-row" style="margin-top:12px"><span>TOTAL</span><span>${formatPrice(o.total)}</span></div>
    <div class="modal-admin-actions" style="margin-top:20px">
      ${o.order_status === 'PENDING' ? `<button class="btn-save" onclick="confirmAction('${o.id}','complete');$('adminModal').classList.remove('active')">✓ COMPLETE</button><button class="btn-cancel-modal" style="background:var(--cancelled-red);color:#fff;border:none" onclick="confirmAction('${o.id}','cancel');$('adminModal').classList.remove('active')">✕ CANCEL</button>` : ''}
      <button class="btn-cancel-modal" onclick="$('adminModal').classList.remove('active')">CLOSE</button>
    </div>
  `;
  $('adminModal').classList.add('active');
}
$('adminModal').addEventListener('click', e => { if (e.target === $('adminModal')) $('adminModal').classList.remove('active') });

// ===========================
// CONFIRM ACTIONS (COMPLETE / CANCEL)
// ===========================
async function confirmAction(orderId, action) {
  const orders = await loadOrders();
  const o = orders.find(or => or.id === orderId);
  if (!o) return;

  if (action === 'complete') {
    $('adminConfirmBox').innerHTML = `
      <h3>MARK THIS ORDER AS COMPLETED?</h3>
      <p>This means the food has been <strong>served</strong> to the table.<br>It does NOT mean the customer has paid.<br><br><strong>${o.id}</strong><br>Table ${o.table}<br>Total ${formatPrice(o.total)}</p>
      <div class="confirm-admin-actions">
        <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">GO BACK</button>
        <button class="btn-save" onclick="doAction('${orderId}','complete')">YES, COMPLETE ORDER</button>
      </div>
    `;
  } else {
    $('adminConfirmBox').innerHTML = `
      <h3>CANCEL THIS ORDER?</h3>
      <p>Are you sure you want to cancel:<br><br><strong>${o.id}</strong><br>Table ${o.table}<br>Total ${formatPrice(o.total)}</p>
      <div class="confirm-admin-actions">
        <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">GO BACK</button>
        <button class="btn-save" style="background:var(--cancelled-red)" onclick="doAction('${orderId}','cancel')">YES, CANCEL ORDER</button>
      </div>
    `;
  }
  $('adminConfirm').classList.add('active');
}
$('adminConfirm').addEventListener('click', e => { if (e.target === $('adminConfirm')) $('adminConfirm').classList.remove('active') });

async function doAction(orderId, action) {
  const result = await apiCall('PATCH', '/orders/' + orderId, { action });
  $('adminConfirm').classList.remove('active');
  showToast('✓ Order ' + (action === 'complete' ? 'completed' : 'cancelled') + ' successfully');
  renderAdminSection(currentAdminSection);
}

// ===========================
// PERMANENT ORDER DELETION
// ===========================
function confirmDeleteOrder(orderId) {
  $('adminConfirmBox').innerHTML = `
    <h3>Remove this order permanently?</h3>
    <p><strong>Warning:</strong> This action cannot be undone.</p>
    <p>This will permanently delete this order and its associated records from the database.</p>
    <p style="font-size:12px;color:var(--cancelled-red)"><strong>${orderId}</strong></p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">CANCEL</button>
      <button class="btn-save" style="background:var(--cancelled-red)" onclick="permanentlyDeleteOrder('${orderId}')">DELETE PERMANENTLY</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function permanentlyDeleteOrder(orderId) {
  const result = await apiCall('DELETE', '/orders/' + orderId);
  $('adminConfirm').classList.remove('active');
  if (result && result.success) {
    showToast('✓ Order removed successfully');
    renderAdminSection(currentAdminSection);
  } else {
    showToast('Error removing order. Please try again.');
  }
}

// ===========================
// ORDER HISTORY — Session-Grouped
// ===========================
async function renderOrderHistory(el) {
  el.innerHTML = '<div class="loading-spinner">Loading order history...</div>';

  // Fetch session-grouped data from server
  const sessions = await apiCall('GET', '/sessions/history');
  if (!sessions) {
    el.innerHTML = '<div class="admin-empty"><h3>UNABLE TO LOAD ORDER HISTORY</h3><p>Please try again.</p></div>';
    return;
  }

  let html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"><input type="text" id="historySearch" placeholder="Search by Session ID or Table..." style="flex:1;min-width:200px;padding:10px 14px;border:2px solid var(--border);border-radius:var(--radius-md);background:var(--cream);outline:none;font-size:14px"></div>';
  html += '<div class="filter-row" id="historyFilters">';
  ['ALL', 'ACTIVE', 'SETTLED'].forEach(f => {
    html += '<button class="admin-chip' + (f === 'ALL' ? ' active' : '') + '" data-hfilter="' + f + '">' + f + '</button>';
  });
  html += '</div>';
  html += '<div id="historyList">';
  html += sessionListHTML(sessions, 'ALL', '');
  html += '</div>';
  el.innerHTML = html;

  $('historySearch').addEventListener('input', function () {
    const f = document.querySelector('.admin-chip.active[data-hfilter]').dataset.hfilter;
    $('historyList').innerHTML = sessionListHTML(sessions, f, this.value);
  });
  document.querySelectorAll('.admin-chip[data-hfilter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.admin-chip[data-hfilter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const search = $('historySearch') ? $('historySearch').value : '';
      $('historyList').innerHTML = sessionListHTML(sessions, chip.dataset.hfilter, search);
    });
  });
}

function sessionListHTML(sessions, filter, search) {
  let filtered = sessions;
  if (filter !== 'ALL') {
    filtered = filtered.filter(s => s.status === filter || s.original_status === filter);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(s => s.session_id.toLowerCase().includes(q) || ('' + s.table).includes(q));
  }
  if (filtered.length === 0) return '<div class="admin-empty"><h3>NO SESSIONS FOUND</h3></div>';

  return filtered.map(s => {
    const createdDate = formatISTFull(new Date(s.created_at));
    let statusBadge = '';
    if (s.original_status === 'SETTLED') {
      statusBadge = '<span class="status-badge status-paid">SETTLED</span>';
    } else if (s.status === 'ALL_CANCELLED') {
      statusBadge = '<span class="status-badge status-cancelled">ALL CANCELLED</span>';
    } else {
      statusBadge = '<span class="status-badge status-pending">ACTIVE</span>';
    }

    // Payment info if settled
    let paymentInfo = '';
    if (s.bill) {
      const method = s.bill.payment_method || s.payment_method || '';
      paymentInfo = '<span class="status-badge status-paid">PAID — ' + method + '</span>';
    }

    return '<div class="order-card" style="cursor:pointer" onclick="viewSession(\'' + s.session_id + '\')">' +
      '<div class="order-card-header">' +
        '<div>' +
          '<div class="order-card-id">SESSION ' + s.session_id + '</div>' +
          '<div class="order-card-table">TABLE ' + s.table + ' · CUSTOMER SESSION</div>' +
        '</div>' +
        '<div class="order-card-time">' + createdDate + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">' +
        statusBadge + paymentInfo +
      '</div>' +
      '<div class="order-card-items">' + s.order_count + ' order submission' + (s.order_count !== 1 ? 's' : '') +
        (s.cancelled_count > 0 ? ' · <span style="color:var(--cancelled-red)">' + s.cancelled_count + ' cancelled</span>' : '') +
      '</div>' +
      '<div class="order-card-total">' + formatPrice(s.total) + '</div>' +
      '<div class="order-card-actions">' +
        '<button class="btn-view" onclick="event.stopPropagation();viewSession(\'' + s.session_id + '\')">VIEW FULL HISTORY</button>' +
        '<button class="btn-remove" onclick="event.stopPropagation();confirmRemoveSession(\'' + s.session_id + '\')">REMOVE ORDER</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function viewSession(sessionId) {
  const content = $('adminContent');
  content.innerHTML = '<div class="loading-spinner">Loading session timeline...</div>';

  const data = await apiCall('GET', '/sessions/' + sessionId);
  if (!data || !data.session) {
    content.innerHTML = '<div class="admin-empty"><h3>SESSION NOT FOUND</h3></div>';
    return;
  }

  const { session, orders, bill } = data;
  const createdDate = formatISTFull(new Date(session.created_at));

  // Session summary
  const completed = orders.filter(o => o.order_status === 'COMPLETED');
  const cancelled = orders.filter(o => o.order_status === 'CANCELLED');
  const pending = orders.filter(o => o.order_status === 'PENDING');
  const nonCancelled = orders.filter(o => o.order_status !== 'CANCELLED');
  const sessionTotal = nonCancelled.reduce((sum, o) => sum + Number(o.total), 0);

  // Session status
  let sessionStatus = '';
  if (session.status === 'SETTLED') {
    sessionStatus = '<span class="status-badge status-paid">SETTLED</span>';
  } else if (nonCancelled.length === 0 && orders.length > 0) {
    sessionStatus = '<span class="status-badge status-cancelled">ALL CANCELLED</span>';
  } else {
    sessionStatus = '<span class="status-badge status-pending">ACTIVE</span>';
  }

  // Build order timeline
  let timelineHTML = '';
  orders.forEach((o, idx) => {
    const orderTime = o.time || (o.timestamp ? formatISTFull(new Date(o.timestamp)) : 'Unknown');
    const orderStatus = o.order_status;
    let statusColor = 'var(--pending-amber)';
    if (orderStatus === 'COMPLETED') statusColor = 'var(--completed-green)';
    else if (orderStatus === 'CANCELLED') statusColor = 'var(--cancelled-red)';

    const items = (o.items || []).map(item => {
      const opts = item.options && item.options.length > 0 ? '<br><span style="color:var(--muted);font-size:11px">' + item.options.join(', ') + '</span>' : '';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0">' +
        '<span>' + item.qty + ' × ' + item.name + opts + '</span>' +
        '<span>' + formatPrice(item.price * item.qty) + '</span>' +
      '</div>';
    }).join('');

    timelineHTML += '<div style="padding:18px;border-left:3px solid ' + statusColor + ';margin-bottom:16px;background:rgba(252,249,243,0.4);border-radius:0 var(--radius-md) var(--radius-md) 0">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">' +
        '<div>' +
          '<div style="font-weight:600;color:var(--espresso);font-size:14px">ORDER ' + (idx + 1) + ' — ' + o.id + '</div>' +
          '<div style="font-size:12px;color:var(--charcoal)">' + orderTime + '</div>' +
        '</div>' +
        '<span class="status-badge status-' + orderStatus.toLowerCase() + '">' + orderStatus + '</span>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:10px">' + items + '</div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">' +
        '<span style="font-size:13px;font-weight:500;color:var(--charcoal)">Total</span>' +
        '<span style="font-family:\"DM Serif Display\",serif;font-size:16px;color:var(--olive)">' + formatPrice(o.total) + '</span>' +
      '</div>' +
      (o.cancelled_at ? '<div style="font-size:11px;color:var(--cancelled-red);margin-top:4px">Cancelled at: ' + formatISTFull(new Date(o.cancelled_at)) + '</div>' : '') +
      (o.completed_at ? '<div style="font-size:11px;color:var(--completed-green);margin-top:4px">Completed at: ' + formatISTFull(new Date(o.completed_at)) + '</div>' : '') +
      '<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border)">' +
        (o.payment_status === 'PAID' ?
          '<span style="font-size:11px;color:var(--text-muted);font-style:italic">PAID — Cannot remove</span>' :
          '<button class="btn-remove" onclick="confirmRemoveOrderFromSession(\'' + o.id + '\', \'' + sessionId + '\')">REMOVE ORDER</button>'
        ) +
      '</div>' +
    '</div>';
  });

  // Payment section
  let paymentHTML = '';
  if (bill) {
    paymentHTML = '<div style="margin-top:24px;padding:20px;background:rgba(46,125,50,0.04);border-radius:var(--radius-md);border:1px solid rgba(46,125,50,0.1)">' +
      '<h4 style="font-family:\"DM Serif Display\",serif;font-size:16px;color:var(--olive);margin-bottom:14px">PAYMENT INFORMATION</h4>' +
      '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Bill Number</span><strong>' + bill.bill_number + '</strong></div>' +
      '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Payment Method</span><strong>' + bill.payment_method + '</strong></div>';
    if (bill.payment_method === 'SPLIT') {
      paymentHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Cash Paid</span><strong>' + formatPrice(bill.cash_amount || 0) + '</strong></div>';
      paymentHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Online Paid</span><strong>' + formatPrice(bill.online_amount || 0) + '</strong></div>';
    }
    paymentHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-top:1px solid var(--border);margin-top:6px;padding-top:10px"><span>Total Paid</span><strong style="font-size:15px;color:var(--olive)">' + formatPrice(bill.total) + '</strong></div>';
    paymentHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;color:var(--text-muted)"><span>Payment Date</span><span>' + bill.payment_date + '</span></div>';
    paymentHTML += '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;color:var(--text-muted)"><span>Payment Time</span><span>' + bill.payment_time + '</span></div>';
    paymentHTML += '</div>';
  }

  content.innerHTML =
    '<div style="margin-bottom:16px"><button class="btn-view" onclick="renderAdminSection(\'history\')">&larr; Back to Order History</button></div>' +
    '<div class="bill-view" style="max-width:700px">' +
      '<div class="bill-view-header" style="border-bottom:2px double #E8DDCC;padding-bottom:20px">' +
        '<h2 style="font-size:22px;letter-spacing:1px">TABLE ' + session.table + ' — SESSION HISTORY</h2>' +
        '<div style="font-size:11px;color:var(--gold);font-weight:600;letter-spacing:2px;margin-top:6px">SESSION ' + session.id + '</div>' +
        '<div style="font-size:12px;color:var(--charcoal);margin-top:6px">Started: ' + createdDate + '</div>' +
        '<div style="margin-top:8px">' + sessionStatus + '</div>' +
      '</div>' +
      '<div style="padding:20px 0">' +
        '<h4 style="font-family:\"DM Serif Display\",serif;font-size:16px;color:var(--espresso);margin-bottom:16px">ORDER TIMELINE</h4>' +
        (orders.length === 0 ? '<div style="text-align:center;padding:24px;color:var(--text-muted)">No orders in this session</div>' : timelineHTML) +
      '</div>' +
      '<div style="padding:20px 0;border-top:2px solid var(--forest)">' +
        '<h4 style="font-family:\"DM Serif Display\",serif;font-size:16px;color:var(--espresso);margin-bottom:14px">SESSION SUMMARY</h4>' +
        '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Orders Placed</span><strong>' + orders.length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Completed</span><strong style="color:var(--completed-green)">' + completed.length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Cancelled</span><strong style="color:var(--cancelled-red)">' + cancelled.length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span>Pending</span><strong>' + pending.length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:10px 0 0;margin-top:8px;border-top:2px solid var(--forest);font-size:16px;font-weight:700">' +
          '<span>SESSION TOTAL</span><span style="font-family:\"DM Serif Display\",serif;color:var(--olive)">' + formatPrice(sessionTotal) + '</span>' +
        '</div>' +
      '</div>' +
      paymentHTML +
    '</div>' +
    '<div style="text-align:center;margin-top:20px">' +
      '<button class="btn-view" onclick="renderAdminSection(\'history\')">BACK TO ORDER HISTORY</button>' +
    '</div>';
}

// ===========================
// REMOVE ORDER FROM SESSION DETAIL
// ===========================
function confirmRemoveOrderFromSession(orderId, sessionId) {
  $('adminConfirmBox').innerHTML = `
    <h3>REMOVE THIS ORDER?</h3>
    <p>Are you sure you want to permanently remove this order?</p>
    <p style="color:var(--cancelled-red)"><strong>This action cannot be undone.</strong></p>
    <p style="font-size:12px;margin-top:8px"><strong>${orderId}</strong></p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">CANCEL</button>
      <button class="btn-save" style="background:var(--cancelled-red)" onclick="removeOrderFromSession('${orderId}', '${sessionId}')">REMOVE ORDER</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function removeOrderFromSession(orderId, sessionId) {
  $('adminConfirm').classList.remove('active');
  const result = await apiCall('DELETE', '/orders/' + orderId);
  if (result && result.success) {
    showToast('✓ Order removed successfully');
    // Refresh the session detail view to reflect changes
    viewSession(sessionId);
  } else {
    showToast('Error removing order. Please try again.');
  }
}

// ===========================
// REMOVE SESSION (all orders for a session)
// ===========================
function confirmRemoveSession(sessionId) {
  $('adminConfirmBox').innerHTML = `
    <h3>Remove this order session?</h3>
    <p>All orders and related information for this session will be permanently deleted. This action cannot be undone.</p>
    <p style="font-size:12px;margin-top:8px;color:var(--text-muted)"><strong>${sessionId}</strong></p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">CANCEL</button>
      <button class="btn-save" style="background:var(--cancelled-red)" onclick="doRemoveSession('${sessionId}')">REMOVE</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function doRemoveSession(sessionId) {
  $('adminConfirm').classList.remove('active');
  const result = await apiCall('DELETE', '/sessions/' + sessionId);
  if (result && result.success) {
    showToast('✓ Session removed successfully');
    renderAdminSection(currentAdminSection);
  } else {
    const errMsg = (result && result.error) ? result.error : 'Error removing session. Please try again.';
    showToast(errMsg);
  }
}

// ===========================
// TABLES — BILLING CENTER
// ===========================
async function renderTables(el, orders) {
  console.log('[TABLES] renderTables called, API_TOKEN present:', !!API_TOKEN);
  const result = await apiCall('GET', '/tables');
  console.log('[TABLES] apiCall result:', result ? 'success' : 'null/undefined');
  const tables = result || [];
  console.log('[TABLES] tables array length:', tables.length);
  const occupied = tables.filter(t => t.status === 'OCCUPIED').map(t => t.number);
  console.log('[TABLES] occupied tables:', occupied);

  let html = '<div class="stat-cards">';
  tables.forEach(t => {
    const isOccupied = t.status === 'OCCUPIED';
    const borderColor = isOccupied ? 'var(--pending-amber)' : 'var(--border)';
    
    html += `
      <div class="table-billing-card ${isOccupied ? 'has-bill' : ''}" style="border-left:4px solid ${borderColor}" onclick="viewTableBill(${t.number})">
        <div class="table-num">TABLE ${t.number}</div>
        <div class="table-status ${isOccupied ? 'occupied' : 'available'}">${t.status}</div>
        <div class="table-orders-count">Orders: ${t.total_orders}${t.pending_count > 0 ? ' · Pending: ' + t.pending_count : ''}</div>
        ${t.running_bill > 0 ? '<div class="table-bill-amount">' + formatPrice(t.running_bill) + '</div>' : ''}
      </div>
    `;
  });
  html += '</div>';
  el.innerHTML = html;
}

async function viewTableBill(tableNum) {
  currentTableBillNum = tableNum;
  selectedPaymentMethod = null;
  const content = $('adminContent');
  const result = await apiCall('GET', '/tables/' + tableNum + '/bill');

  if (!result || !result.session) {
    content.innerHTML = `
      <div style="margin-bottom:16px"><button class="btn-view" onclick="renderAdminSection('tables')">← Back to Tables</button></div>
      <div class="bill-view">
        <div class="bill-view-header">
          <h2>THE OREGANO CAFE</h2>
          <p>TABLE ${tableNum} — NO ACTIVE SESSION</p>
        </div>
        <div class="admin-empty"><h3>NO ACTIVE BILL</h3><p>This table has no active dining session.</p></div>
      </div>
    `;
    return;
  }

  const { session, orders: billOrders, total } = result;
  currentBillTotal = Number(total) || 0;

  let ordersHTML = '';
  if (billOrders.length === 0) {
    ordersHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No unpaid completed orders yet.</div>';
  } else {
    billOrders.forEach(o => {
      ordersHTML += `
        <div class="bill-order-item">
          <div class="bill-order-id">${o.id}</div>
          <div class="bill-order-time">${o.time}</div>
          <div class="bill-order-items">${o.items.map(i => i.qty + ' × ' + i.name).join('<br>')}</div>
          <div class="bill-order-total">${formatPrice(o.total)}</div>
          <div class="bill-order-status">
            <span class="status-badge status-completed">COMPLETED</span>
            <span class="status-badge status-unpaid">UNPAID</span>
          </div>
        </div>
      `;
    });
  }

  content.innerHTML = `
    <div style="margin-bottom:16px"><button class="btn-view" onclick="renderAdminSection('tables')">← Back to Tables</button></div>
    <div class="bill-view">
      <div class="bill-view-header">
        <h2>THE OREGANO CAFE</h2>
        <p>TABLE ${tableNum} — CURRENT BILL</p>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Session: ${session.id}</div>
      </div>
      ${ordersHTML}
      <div class="bill-total-section">
        <div class="bill-total-label">TOTAL BILL</div>
        <div class="bill-total-amount">${formatPrice(total)}</div>
      </div>
      ${total > 0 ? `
        <div class="bill-payment-section">
          <h4>PAYMENT METHOD</h4>
          <div class="payment-options">
            <div class="payment-option" id="payCash" onclick="selectPayment('CASH')">💵 CASH</div>
            <div class="payment-option" id="payOnline" onclick="selectPayment('ONLINE')">📱 ONLINE</div>
            <div class="payment-option" id="paySplit" onclick="selectPayment('SPLIT')">🔀 SPLIT PAYMENT</div>
          </div>
          <div id="splitPaymentForm" style="display:none;margin-top:16px;padding:16px;background:var(--warm-white);border-radius:var(--radius-md);border:1px solid var(--border)">
            <div style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">Total Due: <strong style="color:var(--espresso)">${formatPrice(total)}</strong></div>
            <div class="field" style="margin-bottom:10px">
              <label style="font-size:11px;font-weight:600;letter-spacing:1px;color:var(--charcoal)">CASH AMOUNT</label>
              <input type="number" id="splitCash" placeholder="₹ 0" min="0" style="width:100%;padding:10px;border:2px solid var(--border);border-radius:var(--radius-md);background:#fff;font-size:14px">
            </div>
            <div class="field" style="margin-bottom:10px">
              <label style="font-size:11px;font-weight:600;letter-spacing:1px;color:var(--charcoal)">ONLINE AMOUNT</label>
              <input type="number" id="splitOnline" placeholder="₹ 0" min="0" style="width:100%;padding:10px;border:2px solid var(--border);border-radius:var(--radius-md);background:#fff;font-size:14px">
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-top:1px solid var(--border)">
              <span>Total Paid</span><strong id="splitTotalPaid">₹0</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border)">
              <span>Remaining</span><strong id="splitRemaining" style="color:var(--pending-amber)">${formatPrice(total)}</strong>
            </div>
            <div id="splitError" style="display:none;color:var(--cancelled-red);font-size:12px;margin-top:8px"></div>
          </div>
          <button class="btn-settle" id="settleBtn" onclick="settleTablePayment()" style="display:none;margin-top:12px">CONFIRM PAYMENT</button>
        </div>
      ` : '<div style="text-align:center;padding:24px;color:var(--text-muted)">No amount to settle.</div>'}
    </div>
  `;
}

function selectPayment(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.payment-option').forEach(el => el.classList.remove('selected'));
  if (method === 'CASH') document.getElementById('payCash').classList.add('selected');
  else if (method === 'ONLINE') document.getElementById('payOnline').classList.add('selected');
  else document.getElementById('paySplit').classList.add('selected');

  const splitForm = document.getElementById('splitPaymentForm');
  if (splitForm) splitForm.style.display = (method === 'SPLIT') ? 'block' : 'none';
  document.getElementById('settleBtn').style.display = 'block';

  // Bind live calculation for split payment
  if (method === 'SPLIT') {
    const cashInput = document.getElementById('splitCash');
    const onlineInput = document.getElementById('splitOnline');
    const handler = function() {
      // Get the total from the bill view
      const totalEl = document.querySelector('.bill-total-amount');
      if (!totalEl) return;
      const totalText = totalEl.textContent.replace(/[^0-9.]/g, '');
      const total = parseFloat(totalText) || 0;
      const cash = parseFloat(cashInput.value) || 0;
      const online = parseFloat(onlineInput.value) || 0;
      const paid = cash + online;
      const remaining = total - paid;
      document.getElementById('splitTotalPaid').textContent = formatPrice(paid);
      const remEl = document.getElementById('splitRemaining');
      remEl.textContent = formatPrice(Math.max(0, remaining));
      remEl.style.color = remaining < 0 ? 'var(--cancelled-red)' : remaining > 0 ? 'var(--pending-amber)' : 'var(--completed-green)';
    };
    cashInput.removeEventListener('input', cashInput._handler);
    onlineInput.removeEventListener('input', onlineInput._handler);
    cashInput.addEventListener('input', handler);
    onlineInput.addEventListener('input', handler);
    cashInput._handler = handler;
    onlineInput._handler = handler;
  }
}

async function settleTablePayment() {
  if (!selectedPaymentMethod || !currentTableBillNum) return;

  $('adminConfirmBox').innerHTML = `
    <h3>Confirm Table Payment</h3>
    <p>Table: <strong>${currentTableBillNum}</strong></p>
    <p>Payment Method: <strong>${selectedPaymentMethod}</strong></p>
    <p>Are you sure you want to mark this table bill as PAID?</p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">GO BACK</button>
      <button class="btn-save" onclick="doSettlePayment()">CONFIRM PAYMENT</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function doSettlePayment() {
  // Frontend validation for SPLIT — the server re-validates authoritatively.
  if (selectedPaymentMethod === 'SPLIT') {
    const splitErr = validateSplitAmounts(currentBillTotal);
    if (splitErr) {
      $('adminConfirm').classList.remove('active');
      showToast(splitErr);
      const splitErrEl = document.getElementById('splitError');
      if (splitErrEl) {
        splitErrEl.textContent = splitErr;
        splitErrEl.style.display = 'block';
      }
      return;
    }
  }

  const payload = { payment_method: selectedPaymentMethod };

  if (selectedPaymentMethod === 'SPLIT') {
    const cashInput = document.getElementById('splitCash');
    const onlineInput = document.getElementById('splitOnline');
    payload.cash_amount = Number(cashInput ? cashInput.value : 0);
    payload.online_amount = Number(onlineInput ? onlineInput.value : 0);
  }

  const result = await apiCall('POST', '/tables/' + currentTableBillNum + '/pay', payload);
  $('adminConfirm').classList.remove('active');
  if (result && result.success) {
    showToast('💰 Payment successful!');
    showPaymentSuccessBill(result.bill, currentTableBillNum, result.session);
  } else {
    const errMsg = (result && result.error) ? result.error : 'Error settling payment. Please try again.';
    showToast(errMsg);
    // Show error in split form if applicable
    const splitErr = document.getElementById('splitError');
    if (splitErr && selectedPaymentMethod === 'SPLIT') {
      splitErr.textContent = errMsg;
      splitErr.style.display = 'block';
    }
  }
}

function showPaymentSuccessBill(bill, tableNum, session) {
  if (!bill) {
    showToast('Payment processed but bill generation failed.');
    viewTableBill(tableNum);
    return;
  }
  const content = $('adminContent');

  let tableRows = '';
  (bill.orders || []).forEach(function(o) {
    (o.items || []).forEach(function(item) {
      const opts = item.options && item.options.length > 0 ? '<br><span style="color:#7A756D;font-size:10px">' + item.options.join(', ') + '</span>' : '';
      tableRows += '<tr style="border-bottom:1px solid #E8DDCC">' +
        '<td style="padding:8px 0;color:#2B211B">' + item.name + opts + '</td>' +
        '<td style="padding:8px 0;text-align:center;color:#34322D">' + item.qty + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#34322D">' + formatPrice(item.price) + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#2B211B;font-weight:600">' + formatPrice(item.price * item.qty) + '</td>' +
        '</tr>';
    });
  });

  content.innerHTML =
    '<div style="margin-bottom:16px"><button class="btn-view" onclick="renderAdminSection(\'tables\')">&larr; Back to Tables</button></div>' +
    '<div class="bill-view" id="printableBill">' +
      '<div class="bill-view-header" style="border-bottom:2px double #E8DDCC;padding-bottom:20px">' +
        '<div style="font-size:10px;letter-spacing:3px;color:#B89A5A;margin-bottom:4px">&#9733; &#9733; &#9733;</div>' +
        '<h2 style="font-size:28px;letter-spacing:2px">THE OREGANO CAFE</h2>' +
        '<p style="font-size:10px;color:#B89A5A;font-weight:600;letter-spacing:4px;margin-top:4px">EST. 2019 &middot; BHIWANDI</p>' +
      '</div>' +
      '<div style="padding:16px 0;text-align:center;border-bottom:1px solid #E8DDCC">' +
        '<div style="font-size:13px;font-weight:600;color:#243B2A;letter-spacing:2px;margin-bottom:6px">PAYMENT SUCCESSFUL</div>' +
        '<div style="font-size:22px;color:#2B211B;margin-bottom:4px">Table ' + tableNum + '</div>' +
        '<div style="font-size:28px;color:#394B32;margin-bottom:6px">' + formatPrice(bill.total) + '</div>' +
        '<div style="font-size:12px;color:#7A756D">Payment Method: <strong>' + bill.payment_method + '</strong></div>' +
      '</div>' +
      '<div style="padding:16px 0;border-bottom:1px solid #E8DDCC">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D;margin-bottom:6px">' +
          '<span>Bill No: <strong>' + bill.bill_number + '</strong></span>' +
          '<span>Session: ' + bill.session_id + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D">' +
          '<span>Date: ' + bill.payment_date + '</span>' +
          '<span>Time: ' + bill.payment_time + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 0">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="border-bottom:2px solid #243B2A">' +
            '<th style="text-align:left;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">ITEM</th>' +
            '<th style="text-align:center;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">QTY</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">PRICE</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">TOTAL</th>' +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
          '<tfoot><tr style="border-top:2px solid #243B2A">' +
            '<td colspan="3" style="padding:12px 0;font-size:13px;font-weight:700;text-align:right;color:#2B211B">TOTAL</td>' +
            '<td style="padding:12px 0;font-size:18px;font-weight:700;text-align:right;color:#394B32">' + formatPrice(bill.total) + '</td>' +
          '</tr></tfoot>' +
        '</table>' +
      '</div>' +
      '<div style="padding:16px 0;border-top:1px solid #E8DDCC;text-align:center">' +
        '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Payment: <strong>' + bill.payment_method + '</strong></div>' +
        (bill.payment_method === 'SPLIT' ?
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Cash Paid: <strong>' + formatPrice(bill.cash_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Online Paid: <strong>' + formatPrice(bill.online_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Total Paid: <strong>' + formatPrice(bill.total) + '</strong></div>'
        :
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">' + bill.payment_date + ', ' + bill.payment_time + '</div>'
        ) +
      '</div>' +
      '<div style="text-align:center;padding-top:12px;border-top:1px solid #E8DDCC">' +
        '<div style="font-size:10px;color:#B89A5A;letter-spacing:3px">THANK YOU FOR DINING WITH US</div>' +
      '</div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:20px;display:flex;gap:12px;justify-content:center">' +
      '<button class="btn-settle" onclick="printBill()" style="width:auto;padding:14px 32px">&#128424; PRINT BILL</button>' +
      '<button class="btn-view" onclick="renderAdminSection(\'tables\')">BACK TO TABLES</button>' +
    '</div>';
}

function printBill() {
  var billEl = document.getElementById('printableBill');
  if (!billEl) {
    console.warn('[PRINT] No printableBill element found');
    return;
  }
  var billHTML = billEl.outerHTML;
  var printCSS = [
    '@page { size: portrait; margin: 15mm; }',
    'body {',
    '  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;',
    '  margin: 0; padding: 15px; background: #fff; color: #333;',
    '  -webkit-print-color-adjust: exact; print-color-adjust: exact;',
    '}',
    '.bill-view { max-width: 100%; margin: 0; padding: 0; background: #fff; box-shadow: none; border: none; border-radius: 0; backdrop-filter: none; -webkit-backdrop-filter: none; }',
    '.bill-view-header { border-bottom: 2px double #E8DDCC !important; }',
    '.bill-view-header h2 { font-size: 22px; letter-spacing: 2px; margin: 0 0 4px; }',
    'table { width: 100%; border-collapse: collapse; }',
    'th, td { padding: 6px 4px; font-size: 11px; }',
    'th { text-align: left; border-bottom: 2px solid #243B2A; font-size: 10px; letter-spacing: 1px; color: #7A756D; font-weight: 600; }',
    'td { border-bottom: 1px solid #E8DDCC; }',
    'h2, h3, h4 { font-family: serif; margin: 0; }',
  ].join('\n');
  var printDoc = '<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<title>Bill - The Oregano Cafe</title>' +
    '<style>' + printCSS + '</style>' +
    '</head><body>' + billHTML + '</body></html>';
  var printWindow = window.open('', '_blank', 'width=800,height=600');
  if (!printWindow) {
    showToast('Please allow popups to print bills.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(printDoc);
  printWindow.document.close();
  printWindow.focus();
  // Wait for styles to apply before printing
  setTimeout(function() {
    try { printWindow.print(); } catch(e) { console.warn('[PRINT] Print failed:', e.message); }
  }, 600);
}

// ===========================
// BILLS — HISTORICAL BILL ACCESS
// ===========================
async function renderBills(el) {
  const bills = await loadBills();
  if (bills.length === 0) {
    el.innerHTML = '<div class="admin-empty"><h3>NO BILLS YET</h3><p>Bills are generated automatically after successful table payments.</p></div>';
    return;
  }
  let html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"><input type="text" id="billSearch" placeholder="Search by Bill No or Table..." style="flex:1;min-width:200px;padding:10px 14px;border:2px solid var(--border);border-radius:var(--radius-md);background:var(--cream);outline:none;font-size:14px"></div>';
  html += '<div class="filter-row" id="billFilters">';
  ['ALL', 'CASH', 'ONLINE'].forEach(f => {
    html += '<button class="admin-chip' + (f === 'ALL' ? ' active' : '') + '" data-bfilter="' + f + '">' + f + '</button>';
  });
  html += '</div>';
  html += '<div id="billList">';
  html += billListHTML(bills, 'ALL', '');
  html += '</div>';
  el.innerHTML = html;

  $('billSearch').addEventListener('input', function() {
    const f = document.querySelector('.admin-chip.active[data-bfilter]').dataset.bfilter;
    $('billList').innerHTML = billListHTML(bills, f, this.value);
  });
  document.querySelectorAll('.admin-chip[data-bfilter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.admin-chip[data-bfilter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const search = $('billSearch') ? $('billSearch').value : '';
      $('billList').innerHTML = billListHTML(bills, chip.dataset.bfilter, search);
    });
  });
}

function billListHTML(bills, filter, search) {
  let filtered = bills;
  if (filter !== 'ALL') filtered = filtered.filter(b => b.payment_method === filter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(b => b.bill_number.toLowerCase().includes(q) || ('' + b.table).includes(q));
  }
  if (filtered.length === 0) return '<div class="admin-empty"><h3>NO BILLS FOUND</h3></div>';
  return filtered.map(b => {
    const totalItems = (b.orders || []).reduce((sum, o) => sum + (o.items || []).length, 0);
    return '<div class="order-card" style="cursor:pointer" onclick="viewHistoricalBill(\'' + b.bill_number + '\')">' +
      '<div class="order-card-header">' +
        '<div>' +
          '<div class="order-card-id">' + b.bill_number + '</div>' +
          '<div class="order-card-table">TABLE ' + b.table + '</div>' +
        '</div>' +
        '<div class="order-card-time">' + b.payment_date + ' · ' + b.payment_time + '</div>' +
      '</div>' +
      '<div class="order-card-items">' + totalItems + ' item' + (totalItems !== 1 ? 's' : '') + ' across ' + (b.orders || []).length + ' order' + ((b.orders || []).length !== 1 ? 's' : '') + '</div>' +
      '<div class="order-card-total">' + formatPrice(b.total) + '</div>' +
      '<div class="order-card-actions">' +
        '<span class="status-badge status-paid">PAID — ' + b.payment_method + '</span>' +
        '<button class="btn-view" onclick="event.stopPropagation();viewHistoricalBill(\'' + b.bill_number + '\')">VIEW BILL</button>' +
        '<button class="btn-view" onclick="event.stopPropagation();printHistoricalBill(\'' + b.bill_number + '\')">PRINT BILL</button>' +
        '<button class="btn-remove" onclick="event.stopPropagation();confirmDeleteBill(\'' + b.bill_number + '\',\'' + b.table + '\')">REMOVE BILL</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function viewHistoricalBill(billNumber) {
  const bill = await getBill(billNumber);
  if (!bill) { showToast('Bill not found'); return; }
  const content = $('adminContent');

  let tableRows = '';
  (bill.orders || []).forEach(function(o) {
    (o.items || []).forEach(function(item) {
      const opts = item.options && item.options.length > 0 ? '<br><span style="color:#7A756D;font-size:10px">' + item.options.join(', ') + '</span>' : '';
      tableRows += '<tr style="border-bottom:1px solid #E8DDCC">' +
        '<td style="padding:8px 0;color:#2B211B">' + item.name + opts + '</td>' +
        '<td style="padding:8px 0;text-align:center;color:#34322D">' + item.qty + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#34322D">' + formatPrice(item.price) + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#2B211B;font-weight:600">' + formatPrice(item.price * item.qty) + '</td>' +
        '</tr>';
    });
  });

  content.innerHTML =
    '<div style="margin-bottom:16px"><button class="btn-view" onclick="renderAdminSection(\'bills\')">&larr; Back to Bills</button></div>' +
    '<div class="bill-view" id="printableBill">' +
      '<div class="bill-view-header" style="border-bottom:2px double #E8DDCC;padding-bottom:20px">' +
        '<div style="font-size:10px;letter-spacing:3px;color:#B89A5A;margin-bottom:4px">&#9733; &#9733; &#9733;</div>' +
        '<h2 style="font-size:28px;letter-spacing:2px">THE OREGANO CAFE</h2>' +
        '<p style="font-size:10px;color:#B89A5A;font-weight:600;letter-spacing:4px;margin-top:4px">EST. 2019 &middot; BHIWANDI</p>' +
      '</div>' +
      '<div style="padding:16px 0;text-align:center;border-bottom:1px solid #E8DDCC">' +
        '<div style="font-size:22px;color:#2B211B;margin-bottom:4px">Table ' + bill.table + '</div>' +
        '<div style="font-size:28px;color:#394B32;margin-bottom:6px">' + formatPrice(bill.total) + '</div>' +
        '<div style="font-size:12px;color:#7A756D">Payment Method: <strong>' + bill.payment_method + '</strong></div>' +
      '</div>' +
      '<div style="padding:16px 0;border-bottom:1px solid #E8DDCC">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D;margin-bottom:6px">' +
          '<span>Bill No: <strong>' + bill.bill_number + '</strong></span>' +
          '<span>Session: ' + bill.session_id + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D">' +
          '<span>Date: ' + bill.payment_date + '</span>' +
          '<span>Time: ' + bill.payment_time + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 0">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="border-bottom:2px solid #243B2A">' +
            '<th style="text-align:left;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">ITEM</th>' +
            '<th style="text-align:center;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">QTY</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">PRICE</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">TOTAL</th>' +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
          '<tfoot><tr style="border-top:2px solid #243B2A">' +
            '<td colspan="3" style="padding:12px 0;font-size:13px;font-weight:700;text-align:right;color:#2B211B">TOTAL</td>' +
            '<td style="padding:12px 0;font-size:18px;font-weight:700;text-align:right;color:#394B32">' + formatPrice(bill.total) + '</td>' +
          '</tr></tfoot>' +
        '</table>' +
      '</div>' +
      '<div style="padding:16px 0;border-top:1px solid #E8DDCC;text-align:center">' +
        '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Payment: <strong>' + bill.payment_method + '</strong></div>' +
        (bill.payment_method === 'SPLIT' ?
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Cash Paid: <strong>' + formatPrice(bill.cash_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Online Paid: <strong>' + formatPrice(bill.online_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Total Paid: <strong>' + formatPrice(bill.total) + '</strong></div>'
        :
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">' + bill.payment_date + ', ' + bill.payment_time + '</div>'
        ) +
      '</div>' +
      '<div style="text-align:center;padding-top:12px;border-top:1px solid #E8DDCC">' +
        '<div style="font-size:10px;color:#B89A5A;letter-spacing:3px">THANK YOU FOR DINING WITH US</div>' +
      '</div>' +
    '</div>' +
    '<div style="text-align:center;margin-top:20px;display:flex;gap:12px;justify-content:center">' +
      '<button class="btn-settle" onclick="printBill()" style="width:auto;padding:14px 32px">&#128424; PRINT BILL</button>' +
      '<button class="btn-view" onclick="renderAdminSection(\'bills\')">BACK TO BILLS</button>' +
    '</div>';
}

async function printHistoricalBill(billNumber) {
  const bill = await getBill(billNumber);
  if (!bill) { showToast('Bill not found'); return; }
  // Build bill HTML and print in a clean window
  let tableRows = '';
  (bill.orders || []).forEach(function(o) {
    (o.items || []).forEach(function(item) {
      const opts = item.options && item.options.length > 0 ? '<br><span style="color:#7A756D;font-size:10px">' + item.options.join(', ') + '</span>' : '';
      tableRows += '<tr style="border-bottom:1px solid #E8DDCC">' +
        '<td style="padding:8px 0;color:#2B211B">' + item.name + opts + '</td>' +
        '<td style="padding:8px 0;text-align:center;color:#34322D">' + item.qty + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#34322D">' + formatPrice(item.price) + '</td>' +
        '<td style="padding:8px 0;text-align:right;color:#2B211B;font-weight:600">' + formatPrice(item.price * item.qty) + '</td>' +
        '</tr>';
    });
  });
  var billHTML =
    '<div class="bill-view" style="max-width:100%;margin:0;padding:0;background:#fff">' +
      '<div class="bill-view-header" style="border-bottom:2px double #E8DDCC;padding-bottom:20px;text-align:center">' +
        '<div style="font-size:10px;letter-spacing:3px;color:#B89A5A;margin-bottom:4px">&#9733; &#9733; &#9733;</div>' +
        '<h2 style="font-size:22px;letter-spacing:2px;margin:0 0 4px">THE OREGANO CAFE</h2>' +
        '<p style="font-size:10px;color:#B89A5A;font-weight:600;letter-spacing:4px;margin-top:4px">EST. 2019 &middot; BHIWANDI</p>' +
      '</div>' +
      '<div style="padding:16px 0;text-align:center;border-bottom:1px solid #E8DDCC">' +
        '<div style="font-size:22px;color:#2B211B;margin-bottom:4px">Table ' + bill.table + '</div>' +
        '<div style="font-size:28px;color:#394B32;margin-bottom:6px">' + formatPrice(bill.total) + '</div>' +
        '<div style="font-size:12px;color:#7A756D">Payment Method: <strong>' + bill.payment_method + '</strong></div>' +
      '</div>' +
      '<div style="padding:16px 0;border-bottom:1px solid #E8DDCC">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D;margin-bottom:6px">' +
          '<span>Bill No: <strong>' + bill.bill_number + '</strong></span>' +
          '<span>Session: ' + bill.session_id + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;color:#34322D">' +
          '<span>Date: ' + bill.payment_date + '</span>' +
          '<span>Time: ' + bill.payment_time + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 0">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="border-bottom:2px solid #243B2A">' +
            '<th style="text-align:left;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">ITEM</th>' +
            '<th style="text-align:center;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">QTY</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">PRICE</th>' +
            '<th style="text-align:right;padding:6px 0;font-size:10px;letter-spacing:1.5px;color:#7A756D;font-weight:600">TOTAL</th>' +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
          '<tfoot><tr style="border-top:2px solid #243B2A">' +
            '<td colspan="3" style="padding:12px 0;font-size:13px;font-weight:700;text-align:right;color:#2B211B">TOTAL</td>' +
            '<td style="padding:12px 0;font-size:18px;font-weight:700;text-align:right;color:#394B32">' + formatPrice(bill.total) + '</td>' +
          '</tr></tfoot>' +
        '</table>' +
      '</div>' +
      '<div style="padding:16px 0;border-top:1px solid #E8DDCC;text-align:center">' +
        '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Payment: <strong>' + bill.payment_method + '</strong></div>' +
        (bill.payment_method === 'SPLIT' ?
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Cash Paid: <strong>' + formatPrice(bill.cash_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:2px">Online Paid: <strong>' + formatPrice(bill.online_amount || 0) + '</strong></div>' +
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">Total Paid: <strong>' + formatPrice(bill.total) + '</strong></div>'
        :
          '<div style="font-size:11px;color:#7A756D;margin-bottom:4px">' + bill.payment_date + ', ' + bill.payment_time + '</div>'
        ) +
      '</div>' +
      '<div style="text-align:center;padding-top:12px;border-top:1px solid #E8DDCC">' +
        '<div style="font-size:10px;color:#B89A5A;letter-spacing:3px">THANK YOU FOR DINING WITH US</div>' +
      '</div>' +
    '</div>';
  var printCSS = [
    '@page { size: portrait; margin: 15mm; }',
    'body { font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 15px; background: #fff; color: #333; -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    'table { width: 100%; border-collapse: collapse; }',
    'th, td { padding: 6px 4px; font-size: 11px; }',
    'th { text-align: left; border-bottom: 2px solid #243B2A; font-size: 10px; letter-spacing: 1px; color: #7A756D; font-weight: 600; }',
    'td { border-bottom: 1px solid #E8DDCC; }',
    'h2, h3 { font-family: serif; margin: 0; }',
  ].join('\n');
  var printDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bill - ' + bill.bill_number + '</title><style>' + printCSS + '</style></head><body>' + billHTML + '</body></html>';
  var printWindow = window.open('', '_blank', 'width=800,height=600');
  if (!printWindow) { showToast('Please allow popups to print bills.'); return; }
  printWindow.document.open();
  printWindow.document.write(printDoc);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(function() {
    try { printWindow.print(); } catch(e) { console.warn('[PRINT] Print failed:', e.message); }
  }, 600);
}

// ===========================
// PERMANENT BILL DELETION
// ===========================
function confirmDeleteBill(billNumber, tableNum) {
  $('adminConfirmBox').innerHTML = `
    <h3>REMOVE BILL PERMANENTLY?</h3>
    <p>Are you sure you want to permanently remove this bill?</p>
    <p style="color:var(--cancelled-red)"><strong>This action cannot be undone.</strong></p>
    <p style="font-size:13px;margin-top:8px"><strong>${billNumber}</strong><br>Table ${tableNum}</p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">CANCEL</button>
      <button class="btn-save" style="background:var(--cancelled-red)" onclick="permanentlyDeleteBill('${billNumber}')">REMOVE BILL</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function permanentlyDeleteBill(billNumber) {
  const result = await apiCall('DELETE', '/bills/' + billNumber);
  $('adminConfirm').classList.remove('active');
  if (result && result.success) {
    showToast('✓ Bill removed successfully.');
    renderAdminSection(currentAdminSection);
  } else {
    showToast('Error removing bill. Please try again.');
  }
}

// ===========================
// DAILY EARNINGS
// ===========================
async function renderEarnings(el, orders, expenses) {
  const today = getISTDateStr();

  // Use bills as authoritative source — bills have payment_date in IST
  const bills = await loadBills();
  const todayBills = bills.filter(b => b.payment_date === today);

  console.log('[EARNINGS] Rendering for date:', today, '- Bills found:', todayBills.length);

  const earnings = todayBills.reduce((s, b) => s + Number(b.total || 0), 0);
  let cashTotal = 0;
  let onlineTotal = 0;
  for (const b of todayBills) {
    if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
    else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
    else if (b.payment_method === 'SPLIT') {
      cashTotal += Number(b.cash_amount || 0);
      onlineTotal += Number(b.online_amount || 0);
    }
  }

  const paidOrderCount = todayBills.reduce((sum, b) => sum + (b.orders ? b.orders.length : 0), 0);

  const todayExpenses = expenses.filter(e => e.date === today);
  const totalExp = todayExpenses.reduce((s, e) => s + e.amount, 0);
  const profit = earnings - totalExp;

  el.innerHTML = `
    <div style="text-align:center;margin-bottom:24px;font-family:'Playfair Display',serif;font-size:22px;color:var(--olive-dark)">${formatISTFull(new Date())}</div>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-label">PAID SESSIONS</div><div class="stat-card-value completed">${todayBills.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">TOTAL EARNINGS</div><div class="stat-card-value">${formatPrice(earnings)}</div></div>
      <div class="stat-card"><div class="stat-card-label">CASH COLLECTION</div><div class="stat-card-value">${formatPrice(cashTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">ONLINE COLLECTION</div><div class="stat-card-value">${formatPrice(onlineTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">TOTAL EXPENSES</div><div class="stat-card-value">${formatPrice(totalExp)}</div></div>
      <div class="stat-card"><div class="stat-card-label">NET ${profit >= 0 ? 'PROFIT' : 'LOSS'}</div><div class="stat-card-value ${profit >= 0 ? 'profit' : 'loss'}">${profit >= 0 ? '+' : ''}${formatPrice(profit)}</div></div>
    </div>
  `;
}

// ===========================
// EXPENSES
// ===========================
function renderExpenses(el, expenses) {
  let html = '<div style="margin-bottom:16px"><button class="btn-save" style="padding:10px 20px;display:inline-flex;align-items:center;gap:6px" onclick="openExpenseModal()">+ ADD EXPENSE</button></div>';
  const today = getISTDateStr();
  html += '<div style="overflow-x:auto"><table class="expense-table"><thead><tr><th>EXPENSE</th><th>AMOUNT</th><th>DATE</th><th>NOTE</th><th>ACTIONS</th></tr></thead><tbody>';
  const todayExp = expenses.filter(e => e.date === today);
  if (todayExp.length === 0) {
    html += '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No expenses recorded today</td></tr>';
  }
  todayExp.forEach(exp => {
    html += '<tr><td><strong>' + exp.name + '</strong></td><td>' + formatPrice(exp.amount) + '</td><td>' + exp.date + '</td><td>' + (exp.note || '—') + '</td><td><button class="btn-edit" onclick="openExpenseModal(\'' + exp.id + '\')">EDIT</button> <button class="btn-delete" onclick="deleteExpense(\'' + exp.id + '\')">DELETE</button></td></tr>';
  });
  html += '</tbody></table></div>';

  if (expenses.length > todayExp.length) {
    html += '<h3 style="font-family:Playfair Display,serif;font-size:18px;margin:24px 0 12px;color:var(--olive-dark)">All Expenses</h3>';
    html += '<div style="overflow-x:auto"><table class="expense-table"><thead><tr><th>EXPENSE</th><th>AMOUNT</th><th>DATE</th><th>NOTE</th><th>ACTIONS</th></tr></thead><tbody>';
    expenses.slice().reverse().forEach(exp => {
      html += '<tr><td><strong>' + exp.name + '</strong></td><td>' + formatPrice(exp.amount) + '</td><td>' + exp.date + '</td><td>' + (exp.note || '—') + '</td><td><button class="btn-edit" onclick="openExpenseModal(\'' + exp.id + '\')">EDIT</button> <button class="btn-delete" onclick="deleteExpense(\'' + exp.id + '\')">DELETE</button></td></tr>';
    });
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

async function openExpenseModal(expenseId) {
  const expenses = await loadExpenses();
  const exp = expenseId ? expenses.find(e => e.id === expenseId) : null;
  const today = getISTDateStr();

  $('adminModalBox').innerHTML = `
    <h3>${exp ? 'EDIT' : 'ADD'} EXPENSE</h3>
    <div class="field"><label>Expense Name</label><input type="text" id="expName" value="${exp ? exp.name : ''}" placeholder="e.g. Milk / Dairy"></div>
    <div class="field"><label>Amount</label><input type="number" id="expAmount" value="${exp ? exp.amount : ''}" placeholder="₹"></div>
    <div class="field"><label>Note (optional)</label><input type="text" id="expNote" value="${exp ? exp.note || '' : ''}" placeholder="Optional note"></div>
    <div class="field"><label>Date</label><input type="date" id="expDate" value="${exp ? exp.date : today}"></div>
    <div class="modal-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminModal').classList.remove('active')">CANCEL</button>
      <button class="btn-save" onclick="saveExpense(${exp ? "'" + expenseId + "'" : 'null'})">${exp ? 'UPDATE' : 'SAVE'} EXPENSE</button>
    </div>
  `;
  $('adminModal').classList.add('active');
}

async function saveExpense(expenseId) {
  const name = $('expName').value.trim();
  const amount = Number($('expAmount').value);
  const note = $('expNote').value.trim();
  const date = $('expDate').value;
  if (!name || !amount || !date) { showToast('Please fill all required fields'); return }

  if (expenseId) {
    const result = await apiCall('PUT', '/expenses/' + expenseId, { name, amount, note, date });
    showToast('✓ Expense updated successfully');
  } else {
    const result = await apiCall('POST', '/expenses', { name, amount, note, date });
    showToast('✓ Expense saved successfully');
  }
  $('adminModal').classList.remove('active');
  renderAdminSection(currentAdminSection);
}

function deleteExpense(expenseId) {
  $('adminConfirmBox').innerHTML = `
    <h3>Delete this expense?</h3>
    <p>This action cannot be undone.</p>
    <div class="confirm-admin-actions">
      <button class="btn-cancel-modal" onclick="$('adminConfirm').classList.remove('active')">CANCEL</button>
      <button class="btn-save" style="background:var(--cancelled-red)" onclick="doDeleteExpense('${expenseId}')">DELETE</button>
    </div>
  `;
  $('adminConfirm').classList.add('active');
}

async function doDeleteExpense(expenseId) {
  const result = await apiCall('DELETE', '/expenses/' + expenseId);
  $('adminConfirm').classList.remove('active');
  showToast('✓ Expense deleted successfully');
  renderAdminSection(currentAdminSection);
}

// ===========================
// FINANCIAL REPORTS
// ===========================
function renderReports(el, orders, expenses) {
  el.innerHTML = `
    <div class="filter-row" style="margin-bottom:20px;flex-wrap:wrap;gap:6px">
      <button class="admin-chip active" data-rperiod="today" onclick="setReportPeriod(this)">TODAY</button>
      <button class="admin-chip" data-rperiod="yesterday" onclick="setReportPeriod(this)">YESTERDAY</button>
      <button class="admin-chip" data-rperiod="week" onclick="setReportPeriod(this)">THIS WEEK</button>
      <button class="admin-chip" data-rperiod="month" onclick="setReportPeriod(this)">THIS MONTH</button>
      <button class="admin-chip" data-rperiod="lastmonth" onclick="setReportPeriod(this)">LAST MONTH</button>
      <button class="admin-chip" data-rperiod="year" onclick="setReportPeriod(this)">THIS YEAR</button>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;align-items:flex-end">
      <div class="field" style="margin:0"><label style="font-size:11px;font-weight:600;letter-spacing:1px;color:var(--charcoal)">FROM</label><input type="date" id="reportFrom" style="padding:10px;border:2px solid var(--border);border-radius:var(--radius-md);background:#FFFFFF;color:#000;outline:none"></div>
      <div class="field" style="margin:0"><label style="font-size:11px;font-weight:600;letter-spacing:1px;color:var(--charcoal)">TO</label><input type="date" id="reportTo" style="padding:10px;border:2px solid var(--border);border-radius:var(--radius-md);background:#FFFFFF;color:#000;outline:none"></div>
      <button class="btn-save" style="padding:10px 20px" onclick="generateCustomReport()">GENERATE REPORT</button>
    </div>
    <div id="reportResult"></div>
  `;
  setReportPeriod(document.querySelector('.admin-chip[data-rperiod="today"]'));
}

function setReportPeriod(btn) {
  document.querySelectorAll('.admin-chip[data-rperiod]').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  const period = btn.dataset.rperiod;
  const today = getISTNow();
  const todayStr = getISTDateStr();
  let from, to;

  switch (period) {
    case 'today': from = to = todayStr; break;
    case 'yesterday': { const y = new Date(today); y.setDate(y.getDate() - 1); from = to = y.toISOString().split('T')[0]; break; }
    case 'week': { const ws = new Date(today); ws.setDate(ws.getDate() - ws.getDay()); from = ws.toISOString().split('T')[0]; to = todayStr; break; }
    case 'month': from = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01'; to = todayStr; break;
    case 'lastmonth': { const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); const lme = new Date(today.getFullYear(), today.getMonth(), 0); from = lm.toISOString().split('T')[0]; to = lme.toISOString().split('T')[0]; break; }
    case 'year': from = today.getFullYear() + '-01-01'; to = todayStr; break;
  }

  $('reportFrom').value = from;
  $('reportTo').value = to;
  generateReport(from, to);
}

function generateCustomReport() {
  const from = $('reportFrom').value;
  const to = $('reportTo').value;
  if (!from || !to) { showToast('Please select dates'); return }
  generateReport(from, to);
}

async function generateReport(from, to) {
  $('reportResult').innerHTML = '<div class="loading-spinner">Generating report...</div>';
  const apiResult = await apiCall('GET', '/reports?from=' + from + '&to=' + to);

  let totalOrders, completedCount, cancelledCount, earnings, cashTotal, onlineTotal, totalExpenses, profit, expBreakdown;

  if (apiResult && apiResult.totalOrders !== undefined) {
    totalOrders = apiResult.totalOrders;
    completedCount = apiResult.completedOrders;
    cancelledCount = apiResult.cancelledOrders;
    earnings = apiResult.totalEarnings;
    cashTotal = apiResult.cashTotal || 0;
    onlineTotal = apiResult.onlineTotal || 0;
    totalExpenses = apiResult.totalExpenses;
    profit = apiResult.netProfit;
    expBreakdown = apiResult.expenseBreakdown || {};
  } else {
    const orders = await loadOrders();
    const expenses = await loadExpenses();
    const filteredOrders = orders.filter(o => o.date >= from && o.date <= to);
    const filteredExpenses = expenses.filter(e => e.date >= from && e.date <= to);
    totalOrders = filteredOrders.length;
    completedCount = filteredOrders.filter(o => o.order_status === 'COMPLETED').length;
    cancelledCount = filteredOrders.filter(o => o.order_status === 'CANCELLED').length;
    const paidOrders = filteredOrders.filter(o => o.payment_status === 'PAID');
    earnings = paidOrders.reduce((s, o) => s + o.total, 0);
    cashTotal = paidOrders.reduce((s, o) => s + (o.payment_method === 'CASH' ? o.total : 0), 0);
    onlineTotal = paidOrders.reduce((s, o) => s + (o.payment_method === 'ONLINE' ? o.total : 0), 0);
    totalExpenses = filteredExpenses.reduce((s, e) => s + e.amount, 0);
    profit = earnings - totalExpenses;
    expBreakdown = {};
    filteredExpenses.forEach(e => { expBreakdown[e.name] = (expBreakdown[e.name] || 0) + e.amount; });
  }

  let html = `
    <div class="report-card">
      <h3>THE OREGANO CAFE — FINANCIAL REPORT</h3>
      <div style="font-size:14px;color:var(--text-muted);margin-bottom:16px">${from} to ${to}</div>
      <div class="report-row"><span>TOTAL ORDERS</span><span>${totalOrders}</span></div>
      <div class="report-row"><span>COMPLETED ORDERS</span><span style="color:var(--completed-green)">${completedCount}</span></div>
      <div class="report-row"><span>CANCELLED ORDERS</span><span style="color:var(--cancelled-red)">${cancelledCount}</span></div>
      <div class="report-row"><span>TOTAL EARNINGS (PAID ONLY)</span><span>${formatPrice(earnings)}</span></div>
      <div class="report-row"><span>CASH COLLECTION</span><span>${formatPrice(cashTotal)}</span></div>
      <div class="report-row"><span>ONLINE COLLECTION</span><span>${formatPrice(onlineTotal)}</span></div>
      <div class="report-row"><span>TOTAL EXPENSES</span><span>${formatPrice(totalExpenses)}</span></div>
      <div class="report-row total-row"><span>NET ${profit >= 0 ? 'PROFIT' : 'LOSS'}</span><span style="color:${profit >= 0 ? 'var(--profit-green)' : 'var(--loss-red)'}">${profit >= 0 ? '+' : ''}${formatPrice(profit)}</span></div>
    </div>
  `;

  if (Object.keys(expBreakdown).length > 0) {
    html += '<div class="report-card"><h3>EXPENSE BREAKDOWN</h3>';
    Object.entries(expBreakdown).forEach(([name, amount]) => {
      html += '<div class="report-row"><span>' + name + '</span><span>' + formatPrice(amount) + '</span></div>';
    });
    html += '</div>';
  }

  $('reportResult').innerHTML = html;
}

// ===========================
// SETTINGS
// ===========================
function renderSettings(el) {
  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-label">CAFE NAME</div><div class="stat-card-value" style="font-size:20px">THE OREGANO CAFE</div></div>
      <div class="stat-card"><div class="stat-card-label">ESTABLISHED</div><div class="stat-card-value" style="font-size:20px">2019</div></div>
    </div>
    <div class="report-card">
      <h3>Admin Credentials</h3>
      <div class="report-row"><span>Username</span><span>admin</span></div>
      <div class="report-row"><span>Password</span><span>••••••••</span></div>
    </div>
    <div style="margin-top:16px">
      <button class="btn-logout" onclick="saveAdminAuth(false);window.location.href='/'">LOGOUT</button>
    </div>
  `;
}
