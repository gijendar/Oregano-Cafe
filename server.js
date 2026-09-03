const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// In-memory database (production would use a real DB)
const db = {
  admins: [{ id: 1, username: 'admin', password: 'admin123', name: 'Admin' }],
  orders: [],
  expenses: [],
  tables: []
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  // Simple token validation (in production, use JWT)
  if (token !== 'admin-session-token') return res.status(401).json({ error: 'Invalid token' });
  next();
}

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
// ORDER ROUTES
// ===========================

// Get all orders
app.get('/api/orders', authMiddleware, (req, res) => {
  let orders = [...db.orders];
  const { status, table, date, search } = req.query;

  if (status && status !== 'ALL') {
    orders = orders.filter(o => o.status === status);
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

  // Sort by timestamp descending
  orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(orders);
});

// Get single order
app.get('/api/orders/:id', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Create order (customer-facing, no auth needed for placing orders)
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

  const order = {
    id: orderId,
    table: Number(table),
    items: items.map(item => ({
      name: item.name,
      price: item.price,
      qty: item.qty,
      options: item.options || []
    })),
    total: items.reduce((sum, item) => sum + (item.price * item.qty), 0),
    status: 'PENDING',
    date: ds.substring(0, 4) + '-' + ds.substring(4, 6) + '-' + ds.substring(6, 8),
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
    timestamp: now.toISOString(),
    completedAt: null,
    cancelledAt: null
  };

  db.orders.push(order);
  console.log(`[NEW ORDER] ${orderId} - Table ${table} - ₹${order.total}`);
  res.json({ success: true, order });
});

// Update order status
app.patch('/api/orders/:id', authMiddleware, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { status } = req.body;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  if (status === 'COMPLETED') {
    order.status = 'COMPLETED';
    order.completedAt = timeStr + ' · ' + order.date;
  } else if (status === 'CANCELLED') {
    order.status = 'CANCELLED';
    order.cancelledAt = timeStr + ' · ' + order.date;
  }

  console.log(`[ORDER ${status}] ${order.id}`);
  res.json({ success: true, order });
});

// Delete order
app.delete('/api/orders/:id', authMiddleware, (req, res) => {
  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  db.orders.splice(idx, 1);
  res.json({ success: true });
});

// ===========================
// EXPENSE ROUTES
// ===========================

// Get all expenses
app.get('/api/expenses', authMiddleware, (req, res) => {
  let expenses = [...db.expenses];
  const { date } = req.query;
  if (date) {
    expenses = expenses.filter(e => e.date === date);
  }
  expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(expenses);
});

// Create expense
app.post('/api/expenses', authMiddleware, (req, res) => {
  const { name, amount, note, date } = req.body;
  if (!name || !amount || !date) {
    return res.status(400).json({ error: 'Name, amount, and date are required' });
  }

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

// Update expense
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

// Delete expense
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
  const completed = orders.filter(o => o.status === 'COMPLETED');
  const cancelled = orders.filter(o => o.status === 'CANCELLED');
  const earnings = completed.reduce((sum, o) => sum + o.total, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const profit = earnings - totalExpenses;

  // Expense breakdown
  const expBreakdown = {};
  expenses.forEach(e => {
    expBreakdown[e.name] = (expBreakdown[e.name] || 0) + e.amount;
  });

  res.json({
    from,
    to,
    totalOrders,
    completedOrders: completed.length,
    cancelledOrders: cancelled.length,
    totalEarnings: earnings,
    totalExpenses,
    netProfit: profit,
    expenseBreakdown: expBreakdown,
    orders: orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    expenses: expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  });
});

// ===========================
// TABLES
// ===========================
app.get('/api/tables', authMiddleware, (req, res) => {
  const tables = [];
  for (let i = 1; i <= 20; i++) {
    const activeOrders = db.orders.filter(o => o.table === i && o.status === 'PENDING');
    tables.push({
      number: i,
      activeOrders: activeOrders.length,
      totalAmount: activeOrders.reduce((sum, o) => sum + o.total, 0),
      orders: activeOrders
    });
  }
  res.json(tables);
});

// ===========================
// HEALTH CHECK
// ===========================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', orders: db.orders.length, expenses: db.expenses.length });
});

// ===========================
// CATCH-ALL ROUTE
// ===========================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🍕 THE OREGANO CAFE — Server running on http://localhost:${PORT}`);
  console.log(`📋 Customer: http://localhost:${PORT}`);
  console.log(`🔒 Admin: http://localhost:${PORT}#admin`);
  console.log(`📊 API Health: http://localhost:${PORT}/api/health\n`);
});
