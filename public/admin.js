// ===========================
// ADMIN APP LOGIC
// Table-Based Billing / Dining Session Workflow
// ===========================

let currentAdminSection = 'dashboard';
let sseSource = null;
let selectedPaymentMethod = null;
let currentTableBillNum = null;

// ===========================
// SSE REALTIME CONNECTION
// ===========================
function connectRealtime() {
  if (typeof EventSource === 'undefined') return; // no realtime support — manual refresh only
  try {
    connectSSE();
  } catch(e) {
    console.warn('Realtime connection failed:', e.message);
  }
}

function connectSSE() {
  if (sseSource) { sseSource.close(); sseSource = null; }
  try {
    sseSource = new EventSource(API_BASE + '/events?token=' + API_TOKEN);
  } catch(e) {
    console.warn('SSE connection failed:', e.message);
    sseSource = null;
    return;
  }
  sseSource.addEventListener('new_order', e => {
    showToast('🔔 New order received!');
    if (currentAdminSection === 'dashboard' || currentAdminSection === 'pending' || currentAdminSection === 'tables')
      renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('order_completed', e => {
    if (currentAdminSection !== 'tables') renderAdminSection(currentAdminSection).catch(() => {});
    else renderAdminSection('tables').catch(() => {});
  });
  sseSource.addEventListener('order_cancelled', e => {
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('order_deleted', e => {
    renderAdminSection(currentAdminSection).catch(() => {});
  });
  sseSource.addEventListener('table_paid', e => {
    showToast('💰 Table payment settled!');
    renderAdminSection(currentAdminSection).catch(() => {});
  });
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
    // Load orders and expenses in parallel for faster response
    const [orders, expenses] = await Promise.all([
      loadOrders().catch(e => { console.warn('loadOrders failed:', e.message); return []; }),
      loadExpenses().catch(e => { console.warn('loadExpenses failed:', e.message); return []; })
    ]);
    switch (section) {
      case 'dashboard': renderDashboard(content, orders, expenses); title.textContent = 'DASHBOARD'; break;
      case 'pending': renderOrders(content, orders, 'PENDING'); title.textContent = 'PENDING ORDERS'; break;
      case 'completed': renderOrders(content, orders, 'COMPLETED'); title.textContent = 'COMPLETED ORDERS'; break;
      case 'cancelled': renderOrders(content, orders, 'CANCELLED'); title.textContent = 'CANCELLED ORDERS'; break;
      case 'history': renderOrderHistory(content, orders); title.textContent = 'ORDER HISTORY'; break;
      case 'earnings': renderEarnings(content, orders, expenses); title.textContent = 'DAILY EARNINGS'; break;
      case 'expenses': renderExpenses(content, expenses); title.textContent = 'EXPENSES'; break;
      case 'reports': renderReports(content, orders, expenses); title.textContent = 'FINANCIAL REPORTS'; break;
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
function renderDashboard(el, orders, expenses) {
  const today = new Date().toISOString().split('T')[0];
  const todayOrders = orders.filter(o => o.date === today);
  const pending = orders.filter(o => o.order_status === 'PENDING');
  const completedToday = todayOrders.filter(o => o.order_status === 'COMPLETED');
  const cancelledToday = todayOrders.filter(o => o.order_status === 'CANCELLED');

  // Earnings = only PAID orders
  const paidToday = todayOrders.filter(o => o.payment_status === 'PAID');
  const earnings = paidToday.reduce((s, o) => s + o.total, 0);
  const cashTotal = paidToday.filter(o => o.payment_method === 'CASH').reduce((s, o) => s + o.total, 0);
  const onlineTotal = paidToday.filter(o => o.payment_method === 'ONLINE').reduce((s, o) => s + o.total, 0);

  const todayExpenses = expenses.filter(e => e.date === today).reduce((s, e) => s + e.amount, 0);
  const profit = earnings - todayExpenses;

  // Active tables with open bills
  const activeSessions = orders.filter(o => o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const activeTables = [...new Set(activeSessions.map(o => o.table))];

  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-label">TODAY'S ORDERS</div><div class="stat-card-value">${todayOrders.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">PENDING ORDERS</div><div class="stat-card-value pending">${pending.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">COMPLETED TODAY</div><div class="stat-card-value completed">${completedToday.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">CANCELLED TODAY</div><div class="stat-card-value cancelled">${cancelledToday.length}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S EARNINGS</div><div class="stat-card-value">${formatPrice(earnings)}</div></div>
      <div class="stat-card"><div class="stat-card-label">CASH</div><div class="stat-card-value">${formatPrice(cashTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">ONLINE</div><div class="stat-card-value">${formatPrice(onlineTotal)}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S EXPENSES</div><div class="stat-card-value">${formatPrice(todayExpenses)}</div></div>
      <div class="stat-card"><div class="stat-card-label">TODAY'S NET</div><div class="stat-card-value ${profit >= 0 ? 'profit' : 'loss'}">${profit >= 0 ? '+' : ''}${formatPrice(profit)}</div></div>
      <div class="stat-card"><div class="stat-card-label">OPEN TABLES</div><div class="stat-card-value pending">${activeTables.length}</div></div>
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
    paymentInfo = `<span class="status-badge status-paid">PAID — ${o.payment_method || ''}</span>`;
  } else if (o.payment_status === 'UNPAID' && o.order_status === 'COMPLETED') {
    paymentInfo = `<span class="status-badge status-unpaid">UNPAID</span>`;
  } else if (o.payment_status === 'NOT_APPLICABLE') {
    paymentInfo = `<span class="status-badge status-na">N/A</span>`;
  }

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

  $('adminModalBox').innerHTML = `
    <h3>ORDER #${o.id}</h3>
    <div style="margin-bottom:8px"><strong>TABLE ${o.table}</strong></div>
    ${o.session_id ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Session: ' + o.session_id + '</div>' : ''}
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">ORDERED AT: ${o.time} · ${o.date}</div>
    <div style="margin-bottom:8px"><span class="status-badge status-${o.order_status.toLowerCase()}">${o.order_status}</span></div>
    ${paymentInfo}
    ${o.completedAt ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Served: ' + o.completedAt + '</div>' : ''}
    ${o.cancelledAt ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Cancelled: ' + o.cancelledAt + '</div>' : ''}
    ${o.paidAt ? '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Paid: ' + o.paidAt + '</div>' : ''}
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
// ORDER HISTORY
// ===========================
function renderOrderHistory(el, orders) {
  let html = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"><input type="text" id="historySearch" placeholder="Search by Order ID or Table..." style="flex:1;min-width:200px;padding:10px 14px;border:2px solid var(--border);border-radius:var(--radius-md);background:var(--warm-white);outline:none;font-size:14px"></div>';
  html += '<div class="filter-row" id="historyFilters">';
  ['ALL', 'PENDING', 'COMPLETED', 'CANCELLED'].forEach(f => {
    html += '<button class="admin-chip' + (f === 'ALL' ? ' active' : '') + '" data-hfilter="' + f + '">' + f + '</button>';
  });
  html += '</div>';
  html += '<div id="historyList">';
  html += historyListHTML(orders, 'ALL', '');
  html += '</div>';
  el.innerHTML = html;

  $('historySearch').addEventListener('input', function () {
    const f = document.querySelector('.admin-chip.active[data-hfilter]').dataset.hfilter;
    $('historyList').innerHTML = historyListHTML(orders, f, this.value);
  });
  document.querySelectorAll('.admin-chip[data-hfilter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.admin-chip[data-hfilter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const search = $('historySearch') ? $('historySearch').value : '';
      $('historyList').innerHTML = historyListHTML(orders, chip.dataset.hfilter, search);
    });
  });
}

function historyListHTML(orders, filter, search) {
  let filtered = orders;
  if (filter !== 'ALL') filtered = filtered.filter(o => o.order_status === filter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(o => o.id.toLowerCase().includes(q) || ('' + o.table).includes(q));
  }
  if (filtered.length === 0) return '<div class="admin-empty"><h3>NO ORDERS FOUND</h3></div>';
  return filtered.slice().reverse().map(o => orderCardHTML(o)).join('');
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

  let html = '<div class="stat-cards">';
  tables.forEach(t => {
    const hasBill = t.has_active_session && t.unpaid_count > 0;
    const borderColor = hasBill ? 'var(--pending-amber)' : 'var(--border)';
    html += `
      <div class="table-billing-card ${hasBill ? 'has-bill' : ''}" style="border-left:4px solid ${borderColor}" onclick="viewTableBill(${t.number})">
        <div class="table-num">TABLE ${t.number}</div>
        <div class="table-status ${hasBill ? 'open' : 'available'}">${t.status}</div>
        <div class="table-orders-count">Orders: ${t.total_orders} ${t.pending_count > 0 ? '· Pending: ' + t.pending_count : ''}</div>
        ${hasBill ? '<div style="font-size:13px;color:var(--pending-amber);font-weight:600">Unpaid: ' + t.unpaid_count + '</div>' : ''}
        <div class="table-bill-amount">${t.running_bill > 0 ? formatPrice(t.running_bill) : '—'}</div>
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
          </div>
          <button class="btn-settle" id="settleBtn" onclick="settleTablePayment()" style="display:none">CONFIRM PAYMENT</button>
        </div>
      ` : '<div style="text-align:center;padding:24px;color:var(--text-muted)">No amount to settle.</div>'}
    </div>
  `;
}

function selectPayment(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.payment-option').forEach(el => el.classList.remove('selected'));
  if (method === 'CASH') document.getElementById('payCash').classList.add('selected');
  else document.getElementById('payOnline').classList.add('selected');
  document.getElementById('settleBtn').style.display = 'block';
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
  const result = await apiCall('POST', '/tables/' + currentTableBillNum + '/pay', { payment_method: selectedPaymentMethod });
  $('adminConfirm').classList.remove('active');
  if (result && result.success) {
    showToast('💰 Table bill settled successfully!');
    viewTableBill(currentTableBillNum);
  } else {
    showToast('Error settling payment. Please try again.');
  }
}

// ===========================
// DAILY EARNINGS
// ===========================
function renderEarnings(el, orders, expenses) {
  const today = new Date().toISOString().split('T')[0];
  // Earnings = only PAID orders
  const paidToday = orders.filter(o => o.payment_status === 'PAID' && o.date === today);
  const cashOrders = paidToday.filter(o => o.payment_method === 'CASH');
  const onlineOrders = paidToday.filter(o => o.payment_method === 'ONLINE');

  const earnings = paidToday.reduce((s, o) => s + o.total, 0);
  const cashTotal = cashOrders.reduce((s, o) => s + o.total, 0);
  const onlineTotal = onlineOrders.reduce((s, o) => s + o.total, 0);

  const todayExpenses = expenses.filter(e => e.date === today);
  const totalExp = todayExpenses.reduce((s, e) => s + e.amount, 0);
  const profit = earnings - totalExp;

  el.innerHTML = `
    <div style="text-align:center;margin-bottom:24px;font-family:'Playfair Display',serif;font-size:22px;color:var(--olive-dark)">${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-label">PAID ORDERS</div><div class="stat-card-value completed">${paidToday.length}</div></div>
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
  const today = new Date().toISOString().split('T')[0];
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
  const today = new Date().toISOString().split('T')[0];

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
  const today = new Date();
  let from, to;

  switch (period) {
    case 'today': from = to = today.toISOString().split('T')[0]; break;
    case 'yesterday': const y = new Date(today); y.setDate(y.getDate() - 1); from = to = y.toISOString().split('T')[0]; break;
    case 'week': const ws = new Date(today); ws.setDate(ws.getDate() - ws.getDay()); from = ws.toISOString().split('T')[0]; to = today.toISOString().split('T')[0]; break;
    case 'month': from = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01'; to = today.toISOString().split('T')[0]; break;
    case 'lastmonth': const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); const lme = new Date(today.getFullYear(), today.getMonth(), 0); from = lm.toISOString().split('T')[0]; to = lme.toISOString().split('T')[0]; break;
    case 'year': from = today.getFullYear() + '-01-01'; to = today.toISOString().split('T')[0]; break;
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
    cashTotal = paidOrders.filter(o => o.payment_method === 'CASH').reduce((s, o) => s + o.total, 0);
    onlineTotal = paidOrders.filter(o => o.payment_method === 'ONLINE').reduce((s, o) => s + o.total, 0);
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
