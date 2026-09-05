const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ===========================
// IN-MEMORY DATABASE
// ===========================
const db = {
  admins: [{ id: 1, username: 'admin', password: 'admin123', name: 'Admin' }],
  orders: [],
  expenses: [],
  table_sessions: [],
  payments: []
};

// SSE clients
const sseClients = [];

function broadcastSSE(event, data) {
  sseClients.forEach(res => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  if (token !== 'admin-session-token') return res.status(401).json({ error: 'Invalid token' });
  next();
}

// ===========================
// SSE ENDPOINT
// ===========================
app.get('/api/events', authMiddleware, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('\n');
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx > -1) sseClients.splice(idx, 1);
  });
});

// ===========================
// AUTH ROUTES
// ===========================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.admins.find(a => a.username === username && a.password === password);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ success: true, token: 'admin-session-token', name: admin.name });
});

// ===========================
// TABLE SESSION HELPERS
// ===========================
function getActiveSession(tableNum) {
  return db.table_sessions.find(s => s.table === tableNum && s.status === 'ACTIVE');
}

function createSession(tableNum) {
  const now = new Date();
  const sessionNum = db.table_sessions.length + 1;
  const session = {
    id: 'SES-' + String(sessionNum).padStart(6, '0'),
    table: tableNum,
    status: 'ACTIVE',
    created_at: now.toISOString(),
    settled_at: null,
    total_amount: 0,
    payment_method: null
  };
  db.table_sessions.push(session);
  return session;
}

function recalcSessionTotal(sessionId) {
  const session = db.table_sessions.find(s => s.id === sessionId);
  if (!session) return 0;
  const orders = db.orders.filter(o => o.session_id === sessionId && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const total = orders.reduce((sum, o) => sum + o.total, 0);
  session.total_amount = total;
  return total;
}

// ===========================
// ORDER ROUTES
// ===========================

// Get all orders (admin)
app.get('/api/orders', authMiddleware, (req, res) => {
  let orders = [...db.orders];
  const { status, table, date, search, payment_status } = req.query;

  if (status && status !== 'ALL') {
    orders = orders.filter(o => o.order_status === status);
  }
  if (payment_status) {
    orders = orders.filter(o => o.payment_status === payment_status);
  }
  if (table) {
    orders = orders.filter(o => o.table === Number(table));
  }
  if (date) {
    orders = orders.filter(o => o.date === date);
  }
  if (search) {
    const q = search.toLowerCase();
    orders = orders.filter(o => o.id.toLowerCase().includes(q) || ('' + o.table).includes(q));
  }

  orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(orders);
});

// Get single order
app.get('/api/orders/:id', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Create order (customer-facing)
app.post('/api/orders', (req, res) => {
  const { table, items } = req.body;
  if (!table || !items || items.length === 0) {
    return res.status(400).json({ error: 'Table and items are required' });
  }

  const now = new Date();
  const ds = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  // Generate order ID
  const todayOrders = db.orders.filter(o => o.id.startsWith('ORD-' + ds));
  const num = (todayOrders.length + 1).toString().padStart(4, '0');
  const orderId = 'ORD-' + ds + '-' + num;

  // Find or create table session
  let session = getActiveSession(Number(table));
  if (!session) {
    session = createSession(Number(table));
  }

  const order = {
    id: orderId,
    table: Number(table),
    session_id: session.id,
    items: items.map(item => ({
      name: item.name,
      price: item.price,
      qty: item.qty,
      options: item.options || []
    })),
    total: items.reduce((sum, item) => sum + (item.price * item.qty), 0),
    order_status: 'PENDING',
    payment_status: 'UNPAID',
    payment_method: null,
    date: ds.substring(0, 4) + '-' + ds.substring(4, 6) + '-' + ds.substring(6, 8),
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
    timestamp: now.toISOString(),
    completedAt: null,
    cancelledAt: null,
    paidAt: null
  };

  db.orders.push(order);
  console.log(`[NEW ORDER] ${orderId} - Table ${table} - ₹${order.total} - Session ${session.id}`);
  broadcastSSE('new_order', order);
  res.json({ success: true, order });
});

// Update order status (complete / cancel)
app.patch('/api/orders/:id', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { action } = req.body;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  if (action === 'complete') {
    order.order_status = 'COMPLETED';
    order.completedAt = timeStr + ' · ' + order.date;
    // Recalculate session total
    recalcSessionTotal(order.session_id);
    console.log(`[ORDER COMPLETED] ${order.id} - Table ${order.table} - Session ${order.session_id}`);
    broadcastSSE('order_completed', { order, session_total: db.table_sessions.find(s => s.id === order.session_id)?.total_amount || 0 });
  } else if (action === 'cancel') {
    order.order_status = 'CANCELLED';
    order.payment_status = 'NOT_APPLICABLE';
    order.cancelledAt = timeStr + ' · ' + order.date;
    recalcSessionTotal(order.session_id);
    console.log(`[ORDER CANCELLED] ${order.id} - Table ${order.table}`);
    broadcastSSE('order_cancelled', order);
  }

  res.json({ success: true, order });
});

// Permanently delete order
app.delete('/api/orders/:id', authMiddleware, (req, res) => {
  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });

  const order = db.orders[idx];
  // Remove from session total if applicable
  if (order.session_id && order.order_status === 'COMPLETED' && order.payment_status === 'UNPAID') {
    recalcSessionTotal(order.session_id);
  }

  db.orders.splice(idx, 1);
  console.log(`[ORDER DELETED] ${order.id} - Table ${order.table}`);
  broadcastSSE('order_deleted', { orderId: order.id, table: order.table });
  res.json({ success: true });
});

// ===========================
// TABLE SESSION ROUTES
// ===========================

// Get all tables with session info
app.get('/api/tables', authMiddleware, (req, res) => {
  const tables = [];
  for (let i = 1; i <= 20; i++) {
    const session = getActiveSession(i);
    let unpaidOrders = [];
    let runningBill = 0;
    let pendingOrders = 0;
    let allSessionOrders = [];

    if (session) {
      unpaidOrders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
      runningBill = unpaidOrders.reduce((sum, o) => sum + o.total, 0);
      allSessionOrders = db.orders.filter(o => o.session_id === session.id);
      pendingOrders = allSessionOrders.filter(o => o.order_status === 'PENDING').length;
    }

    tables.push({
      number: i,
      has_active_session: !!session,
      session_id: session ? session.id : null,
      running_bill: runningBill,
      unpaid_count: unpaidOrders.length,
      pending_count: pendingOrders,
      total_orders: allSessionOrders.length,
      status: session ? (runningBill > 0 ? 'OPEN BILL' : 'NO ORDERS') : 'AVAILABLE'
    });
  }
  res.json(tables);
});

// Get table bill detail
app.get('/api/tables/:number/bill', authMiddleware, (req, res) => {
  const tableNum = Number(req.params.number);
  const session = getActiveSession(tableNum);
  if (!session) return res.json({ session: null, orders: [], total: 0 });

  const orders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const total = orders.reduce((sum, o) => sum + o.total, 0);

  res.json({ session, orders, total });
});

// Settle table bill (payment)
app.post('/api/tables/:number/pay', authMiddleware, (req, res) => {
  const tableNum = Number(req.params.number);
  const { payment_method } = req.body;

  if (!payment_method || !['CASH', 'ONLINE'].includes(payment_method)) {
    return res.status(400).json({ error: 'Payment method must be CASH or ONLINE' });
  }

  const session = getActiveSession(tableNum);
  if (!session) return res.status(404).json({ error: 'No active session for this table' });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  // Get all unpaid completed orders
  const unpaidOrders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const totalAmount = unpaidOrders.reduce((sum, o) => sum + o.total, 0);

  if (totalAmount === 0) return res.status(400).json({ error: 'No unpaid amount for this table' });

  // Create payment record
  const payment = {
    id: 'PAY-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    session_id: session.id,
    table: tableNum,
    amount: totalAmount,
    payment_method: payment_method,
    payment_status: 'PAID',
    paid_at: now.toISOString(),
    created_at: now.toISOString()
  };
  db.payments.push(payment);

  // Mark all unpaid completed orders as paid
  unpaidOrders.forEach(o => {
    o.payment_status = 'PAID';
    o.payment_method = payment_method;
    o.paidAt = timeStr + ' · ' + o.date;
  });

  // Close the session
  session.status = 'SETTLED';
  session.settled_at = now.toISOString();
  session.total_amount = totalAmount;
  session.payment_method = payment_method;

  console.log(`[TABLE PAID] Table ${tableNum} - ₹${totalAmount} - ${payment_method} - Session ${session.id}`);
  broadcastSSE('table_paid', { table: tableNum, session_id: session.id, amount: totalAmount, payment_method });

  res.json({ success: true, payment, session });
});

// ===========================
// PAYMENTS / EARNINGS
// ===========================
app.get('/api/earnings', authMiddleware, (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  // Earnings = only PAID orders
  const paidOrders = db.orders.filter(o => o.payment_status === 'PAID' && o.date === targetDate);
  const cashOrders = paidOrders.filter(o => o.payment_method === 'CASH');
  const onlineOrders = paidOrders.filter(o => o.payment_method === 'ONLINE');

  const totalEarnings = paidOrders.reduce((s, o) => s + o.total, 0);
  const cashTotal = cashOrders.reduce((s, o) => s + o.total, 0);
  const onlineTotal = onlineOrders.reduce((s, o) => s + o.total, 0);

  const todayExpenses = db.expenses.filter(e => e.date === targetDate).reduce((s, e) => s + e.amount, 0);
  const netProfit = totalEarnings - todayExpenses;

  res.json({
    date: targetDate,
    totalEarnings,
    cashTotal,
    onlineTotal,
    totalExpenses: todayExpenses,
    netProfit,
    paidOrderCount: paidOrders.length,
    cashCount: cashOrders.length,
    onlineCount: onlineOrders.length
  });
});

// ===========================
// EXPENSE ROUTES
// ===========================
app.get('/api/expenses', authMiddleware, (req, res) => {
  let expenses = [...db.expenses];
  const { date } = req.query;
  if (date) expenses = expenses.filter(e => e.date === date);
  expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(expenses);
});

app.post('/api/expenses', authMiddleware, (req, res) => {
  const { name, amount, note, date } = req.body;
  if (!name || !amount || !date) return res.status(400).json({ error: 'Name, amount, and date are required' });

  const expense = {
    id: 'exp-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    name,
    amount: Number(amount),
    note: note || '',
    date,
    timestamp: new Date().toISOString()
  };
  db.expenses.push(expense);
  console.log(`[EXPENSE] ${name} - ₹${amount} on ${date}`);
  res.json({ success: true, expense });
});

app.put('/api/expenses/:id', authMiddleware, (req, res) => {
  const expense = db.expenses.find(e => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  const { name, amount, note, date } = req.body;
  if (name) expense.name = name;
  if (amount) expense.amount = Number(amount);
  if (note !== undefined) expense.note = note;
  if (date) expense.date = date;
  res.json({ success: true, expense });
});

app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  const idx = db.expenses.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
  db.expenses.splice(idx, 1);
  res.json({ success: true });
});

// ===========================
// FINANCIAL REPORTS
// ===========================
app.get('/api/reports', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'From and to dates required' });

  const orders = db.orders.filter(o => o.date >= from && o.date <= to);
  const expenses = db.expenses.filter(e => e.date >= from && e.date <= to);

  const totalOrders = orders.length;
  const completedOrders = orders.filter(o => o.order_status === 'COMPLETED');
  const cancelledOrders = orders.filter(o => o.order_status === 'CANCELLED');
  const pendingOrders = orders.filter(o => o.order_status === 'PENDING');

  // Earnings = only PAID orders
  const paidOrders = orders.filter(o => o.payment_status === 'PAID');
  const totalEarnings = paidOrders.reduce((sum, o) => sum + o.total, 0);
  const cashTotal = paidOrders.filter(o => o.payment_method === 'CASH').reduce((sum, o) => sum + o.total, 0);
  const onlineTotal = paidOrders.filter(o => o.payment_method === 'ONLINE').reduce((sum, o) => sum + o.total, 0);

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const profit = totalEarnings - totalExpenses;

  const expBreakdown = {};
  expenses.forEach(e => { expBreakdown[e.name] = (expBreakdown[e.name] || 0) + e.amount; });

  res.json({
    from, to,
    totalOrders,
    completedOrders: completedOrders.length,
    cancelledOrders: cancelledOrders.length,
    pendingOrders: pendingOrders.length,
    totalEarnings,
    cashTotal,
    onlineTotal,
    totalExpenses,
    netProfit: profit,
    expenseBreakdown: expBreakdown,
    orders: orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    expenses: expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  });
});

// ===========================
// DASHBOARD STATS
// ===========================
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const allOrders = db.orders;

  const todayOrders = allOrders.filter(o => o.date === today);
  const pending = allOrders.filter(o => o.order_status === 'PENDING');
  const completedToday = todayOrders.filter(o => o.order_status === 'COMPLETED');
  const cancelledToday = todayOrders.filter(o => o.order_status === 'CANCELLED');

  // Earnings only from PAID orders
  const paidToday = todayOrders.filter(o => o.payment_status === 'PAID');
  const earnings = paidToday.reduce((s, o) => s + o.total, 0);
  const cashTotal = paidToday.filter(o => o.payment_method === 'CASH').reduce((s, o) => s + o.total, 0);
  const onlineTotal = paidToday.filter(o => o.payment_method === 'ONLINE').reduce((s, o) => s + o.total, 0);

  const todayExpenses = db.expenses.filter(e => e.date === today).reduce((s, e) => s + e.amount, 0);
  const profit = earnings - todayExpenses;

  // Active tables with open bills
  const activeTables = db.table_sessions.filter(s => s.status === 'ACTIVE').map(s => s.table);

  res.json({
    todayOrdersCount: todayOrders.length,
    pendingCount: pending.length,
    completedTodayCount: completedToday.length,
    cancelledTodayCount: cancelledToday.length,
    earnings,
    cashTotal,
    onlineTotal,
    expenses: todayExpenses,
    profit,
    activeTables,
    recentPending: pending.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10)
  });
});

// ===========================
// HEALTH CHECK
// ===========================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    orders: db.orders.length,
    expenses: db.expenses.length,
    sessions: db.table_sessions.length,
    payments: db.payments.length
  });
});

// ===========================
// CATCH-ALL ROUTE
// ===========================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Export for Vercel serverless
module.exports = app;

// Start server (only when running locally, not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🍕 THE OREGANO CAFE — Server running on http://localhost:${PORT}`);
    console.log(`📋 Customer: http://localhost:${PORT}`);
    console.log(`🔒 Admin: http://localhost:${PORT}#admin`);
    console.log(`📊 API Health: http://localhost:${PORT}/api/health\n`);
  });
}
