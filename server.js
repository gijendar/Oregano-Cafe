const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ===========================
// SUPABASE DATABASE
// ===========================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const USE_DB = !!(supabaseUrl && supabaseKey);
const supabase = USE_DB ? createClient(supabaseUrl, supabaseKey) : null;

// SSE clients (in-memory — works on both local and Vercel)
const sseClients = [];

function broadcastSSE(event, data) {
  sseClients.forEach(res => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { /* client disconnected */ }
  });
}

// ===========================
// IN-MEMORY FALLBACK (local dev without Supabase)
// ===========================
const db = {
  admins: [{ id: 1, username: 'admin', password: 'admin123', name: 'Admin' }],
  orders: [],
  expenses: [],
  table_sessions: [],
  payments: []
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname))); // fallback for root files during local dev

// Async error wrapper — Express 4 does NOT catch async route handler errors
function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Global error handler — safety net for any uncaught error
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  if (token !== 'admin-session-token') return res.status(401).json({ error: 'Invalid token' });
  next();
}

// ===========================
// SSE ENDPOINT
// On Vercel serverless: SSE connections hang and cause 504s.
// Admin frontend uses SSE only (no polling fallback).
// ===========================
app.get('/api/events', (req, res) => {
  // EventSource cannot send custom headers, so the token arrives as a query param.
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== 'admin-session-token') return res.status(401).json({ error: 'Invalid token' });

  if (process.env.VERCEL) {
    // Vercel serverless: SSE not supported, client falls back to manual refresh
    return res.json({ mode: 'poll', message: 'SSE not available on Vercel' });
  }
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
// DB STATUS CHECK
// ===========================
app.get('/api/db-status', (req, res) => {
  res.json({ use_db: USE_DB, supabase_configured: !!(supabaseUrl && supabaseKey) });
});

// ===========================
// AUTH ROUTES
// ===========================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (USE_DB) {
      const { data: admin, error } = await supabase
        .from('admins')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .single();

      if (error) {
        console.error('Login Supabase error:', error.message);
        return res.status(500).json({ error: 'Database error. Please try again.' });
      }
      if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ success: true, token: 'admin-session-token', name: admin.name });
    } else {
      const admin = db.admins.find(a => a.username === username && a.password === password);
      if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ success: true, token: 'admin-session-token', name: admin.name });
    }
  } catch (e) {
    console.error('Login route error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error. Please try again.' });
    }
  }
});

// ===========================
// TABLE SESSION HELPERS
// ===========================
async function getActiveSession(tableNum) {
  if (USE_DB) {
    const { data } = await supabase
      .from('table_sessions')
      .select('*')
      .eq('"table"', tableNum)
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data;
  }
  return db.table_sessions.find(s => s.table === tableNum && s.status === 'ACTIVE');
}

async function createSession(tableNum) {
  if (USE_DB) {
    // Count existing sessions to generate ID
    const { count } = await supabase
      .from('table_sessions')
      .select('*', { count: 'exact', head: true });
    const sessionNum = (count || 0) + 1;
    const session = {
      id: 'SES-' + String(sessionNum).padStart(6, '0'),
      table: tableNum,
      status: 'ACTIVE',
      total_amount: 0,
      payment_method: null,
      created_at: new Date().toISOString(),
      settled_at: null
    };
    await supabase.from('table_sessions').insert(session);
    return session;
  } else {
    const sessionNum = db.table_sessions.length + 1;
    const session = {
      id: 'SES-' + String(sessionNum).padStart(6, '0'),
      table: tableNum,
      status: 'ACTIVE',
      total_amount: 0,
      payment_method: null,
      created_at: new Date().toISOString(),
      settled_at: null
    };
    db.table_sessions.push(session);
    return session;
  }
}

async function recalcSessionTotal(sessionId) {
  if (USE_DB) {
    const { data: orders } = await supabase
      .from('orders')
      .select('total')
      .eq('session_id', sessionId)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID');

    const total = (orders || []).reduce((sum, o) => sum + Number(o.total), 0);
    await supabase
      .from('table_sessions')
      .update({ total_amount: total })
      .eq('id', sessionId);
    return total;
  } else {
    const session = db.table_sessions.find(s => s.id === sessionId);
    if (!session) return 0;
    const orders = db.orders.filter(o => o.session_id === sessionId && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
    const total = orders.reduce((sum, o) => sum + o.total, 0);
    session.total_amount = total;
    return total;
  }
}

async function generateOrderId() {
  const now = new Date();
  const ds = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const prefix = 'ORD-' + ds + '-';

  if (USE_DB) {
    const { data: todayOrders } = await supabase
      .from('orders')
      .select('id')
      .like('id', prefix + '%');
    const num = ((todayOrders || []).length + 1).toString().padStart(4, '0');
    return prefix + num;
  } else {
    const todayOrders = db.orders.filter(o => o.id.startsWith(prefix));
    const num = (todayOrders.length + 1).toString().padStart(4, '0');
    return prefix + num;
  }
}

// ===========================
// ORDER ROUTES
// ===========================

// Get all orders (admin)
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { status, table, date, search, payment_status } = req.query;

    if (USE_DB) {
      let query = supabase.from('orders').select('*');

      if (status && status !== 'ALL') {
        query = query.eq('order_status', status);
      }
      if (payment_status) {
        query = query.eq('payment_status', payment_status);
      }
      if (table) {
        query = query.eq('"table"', Number(table));
      }
      if (date) {
        query = query.eq('date', date);
      }
      if (search) {
        const q = search.toLowerCase();
        query = query.or(`id.ilike.%${q}%,table.eq.${Number(table) || -1}`);
      }

      const { data: orders, error } = await query.order('timestamp', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.json(orders || []);
    }

    // Fallback: in-memory
    let orders = [...db.orders];
    if (status && status !== 'ALL') orders = orders.filter(o => o.order_status === status);
    if (payment_status) orders = orders.filter(o => o.payment_status === payment_status);
    if (table) orders = orders.filter(o => o.table === Number(table));
    if (date) orders = orders.filter(o => o.date === date);
    if (search) {
      const q = search.toLowerCase();
      orders = orders.filter(o => o.id.toLowerCase().includes(q) || ('' + o.table).includes(q));
    }
    orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(orders);
  } catch (e) {
    console.error('GET /api/orders error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load orders.' });
  }
});

// Get single order
app.get('/api/orders/:id', authMiddleware, asyncWrap(async (req, res) => {
  if (USE_DB) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json(order);
  }
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
}));

// Create order (customer-facing)
app.post('/api/orders', asyncWrap(async (req, res) => {
  const { table, items } = req.body;
  if (!table || !items || items.length === 0) {
    return res.status(400).json({ error: 'Table and items are required' });
  }

  const now = new Date();
  const ds = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  const orderId = await generateOrderId();
  let session = await getActiveSession(Number(table));
  if (!session) {
    session = await createSession(Number(table));
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
    completed_at: null,
    cancelled_at: null,
    paid_at: null
  };

  if (USE_DB) {
    const { error } = await supabase.from('orders').insert(order);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    db.orders.push(order);
  }

  console.log(`[NEW ORDER] ${orderId} - Table ${table} - ₹${order.total} - Session ${session.id}`);
  broadcastSSE('new_order', order);
  res.json({ success: true, order });
}));

// Update order status (complete / cancel)
app.patch('/api/orders/:id', authMiddleware, asyncWrap(async (req, res) => {
  const { action } = req.body;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  if (USE_DB) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (action === 'complete') {
      await supabase.from('orders').update({
        order_status: 'COMPLETED',
        completed_at: now.toISOString()
      }).eq('id', order.id);
      order.order_status = 'COMPLETED';
      order.completed_at = now.toISOString();
      await recalcSessionTotal(order.session_id);
      const { data: session } = await supabase.from('table_sessions').select('total_amount').eq('id', order.session_id).single();
      broadcastSSE('order_completed', { order, session_total: session?.total_amount || 0 });
    } else if (action === 'cancel') {
      await supabase.from('orders').update({
        order_status: 'CANCELLED',
        payment_status: 'NOT_APPLICABLE',
        cancelled_at: now.toISOString()
      }).eq('id', order.id);
      order.order_status = 'CANCELLED';
      order.payment_status = 'NOT_APPLICABLE';
      order.cancelled_at = now.toISOString();
      await recalcSessionTotal(order.session_id);
      broadcastSSE('order_cancelled', order);
    }

    console.log(`[ORDER ${action.toUpperCase()}] ${order.id} - Table ${order.table}`);
    return res.json({ success: true, order });
  }

  // Fallback: in-memory
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (action === 'complete') {
    order.order_status = 'COMPLETED';
    order.completed_at = now.toISOString();
    await recalcSessionTotal(order.session_id);
    broadcastSSE('order_completed', { order, session_total: db.table_sessions.find(s => s.id === order.session_id)?.total_amount || 0 });
  } else if (action === 'cancel') {
    order.order_status = 'CANCELLED';
    order.payment_status = 'NOT_APPLICABLE';
    order.cancelled_at = now.toISOString();
    await recalcSessionTotal(order.session_id);
    broadcastSSE('order_cancelled', order);
  }

  console.log(`[ORDER ${action.toUpperCase()}] ${order.id} - Table ${order.table}`);
  res.json({ success: true, order });
}));

// Permanently delete order
app.delete('/api/orders/:id', authMiddleware, asyncWrap(async (req, res) => {
  if (USE_DB) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.session_id && order.order_status === 'COMPLETED' && order.payment_status === 'UNPAID') {
      await recalcSessionTotal(order.session_id);
    }

    await supabase.from('orders').delete().eq('id', req.params.id);
    console.log(`[ORDER DELETED] ${order.id} - Table ${order.table}`);
    broadcastSSE('order_deleted', { orderId: order.id, table: order.table });
    return res.json({ success: true });
  }

  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = db.orders[idx];
  if (order.session_id && order.order_status === 'COMPLETED' && order.payment_status === 'UNPAID') {
    await recalcSessionTotal(order.session_id);
  }
  db.orders.splice(idx, 1);
  console.log(`[ORDER DELETED] ${order.id} - Table ${order.table}`);
  broadcastSSE('order_deleted', { orderId: order.id, table: order.table });
  res.json({ success: true });
}));

// ===========================
// TABLE SESSION ROUTES
// ===========================

// Get all tables with session info
app.get('/api/tables', authMiddleware, asyncWrap(async (req, res) => {
  const tables = [];

  if (USE_DB) {
    for (let i = 1; i <= 20; i++) {
      const session = await getActiveSession(i);
      let unpaidOrders = [];
      let runningBill = 0;
      let pendingOrders = 0;
      let allSessionOrders = [];

      if (session) {
        const { data: uo } = await supabase
          .from('orders')
          .select('total')
          .eq('session_id', session.id)
          .eq('order_status', 'COMPLETED')
          .eq('payment_status', 'UNPAID');
        unpaidOrders = uo || [];
        runningBill = unpaidOrders.reduce((sum, o) => sum + Number(o.total), 0);

        const { data: ao } = await supabase
          .from('orders')
          .select('order_status')
          .eq('session_id', session.id);
        allSessionOrders = ao || [];
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
    return res.json(tables);
  }

  // Fallback: in-memory
  for (let i = 1; i <= 20; i++) {
    const session = db.table_sessions.find(s => s.table === i && s.status === 'ACTIVE');
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
}));

// Get table bill detail
app.get('/api/tables/:number/bill', authMiddleware, asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  const session = await getActiveSession(tableNum);
  if (!session) return res.json({ session: null, orders: [], total: 0 });

  if (USE_DB) {
    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID')
      .order('timestamp', { ascending: true });
    const total = (orders || []).reduce((sum, o) => sum + Number(o.total), 0);
    return res.json({ session, orders: orders || [], total });
  }

  const orders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const total = orders.reduce((sum, o) => sum + o.total, 0);
  res.json({ session, orders, total });
}));

// Settle table bill (payment)
app.post('/api/tables/:number/pay', authMiddleware, asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  const { payment_method } = req.body;

  if (!payment_method || !['CASH', 'ONLINE'].includes(payment_method)) {
    return res.status(400).json({ error: 'Payment method must be CASH or ONLINE' });
  }

  const session = await getActiveSession(tableNum);
  if (!session) return res.status(404).json({ error: 'No active session for this table' });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  if (USE_DB) {
    const { data: unpaidOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID');

    const totalAmount = (unpaidOrders || []).reduce((sum, o) => sum + Number(o.total), 0);
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
    await supabase.from('payments').insert(payment);

    // Mark all unpaid completed orders as paid
    for (const o of (unpaidOrders || [])) {
      await supabase.from('orders').update({
        payment_status: 'PAID',
        payment_method: payment_method,
        paid_at: now.toISOString()
      }).eq('id', o.id);
    }

    // Close the session
    await supabase.from('table_sessions').update({
      status: 'SETTLED',
      settled_at: now.toISOString(),
      total_amount: totalAmount,
      payment_method: payment_method
    }).eq('id', session.id);

    session.status = 'SETTLED';
    session.settled_at = now.toISOString();
    session.total_amount = totalAmount;
    session.payment_method = payment_method;

    console.log(`[TABLE PAID] Table ${tableNum} - ₹${totalAmount} - ${payment_method} - Session ${session.id}`);
    broadcastSSE('table_paid', { table: tableNum, session_id: session.id, amount: totalAmount, payment_method });
    return res.json({ success: true, payment, session });
  }

  // Fallback: in-memory
  const unpaidOrders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  const totalAmount = unpaidOrders.reduce((sum, o) => sum + o.total, 0);
  if (totalAmount === 0) return res.status(400).json({ error: 'No unpaid amount for this table' });

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

  unpaidOrders.forEach(o => {
    o.payment_status = 'PAID';
    o.payment_method = payment_method;
    o.paid_at = now.toISOString();
  });

  session.status = 'SETTLED';
  session.settled_at = now.toISOString();
  session.total_amount = totalAmount;
  session.payment_method = payment_method;

  console.log(`[TABLE PAID] Table ${tableNum} - ₹${totalAmount} - ${payment_method} - Session ${session.id}`);
  broadcastSSE('table_paid', { table: tableNum, session_id: session.id, amount: totalAmount, payment_method });
  res.json({ success: true, payment, session });
}));

// ===========================
// PAYMENTS / EARNINGS
// ===========================
app.get('/api/earnings', authMiddleware, asyncWrap(async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  if (USE_DB) {
    const { data: paidOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_status', 'PAID')
      .eq('date', targetDate);

    const orders = paidOrders || [];
    const cashOrders = orders.filter(o => o.payment_method === 'CASH');
    const onlineOrders = orders.filter(o => o.payment_method === 'ONLINE');

    const totalEarnings = orders.reduce((s, o) => s + Number(o.total), 0);
    const cashTotal = cashOrders.reduce((s, o) => s + Number(o.total), 0);
    const onlineTotal = onlineOrders.reduce((s, o) => s + Number(o.total), 0);

    const { data: expenses } = await supabase.from('expenses').select('amount').eq('date', targetDate);
    const todayExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount), 0);

    return res.json({
      date: targetDate,
      totalEarnings,
      cashTotal,
      onlineTotal,
      totalExpenses: todayExpenses,
      netProfit: totalEarnings - todayExpenses,
      paidOrderCount: orders.length,
      cashCount: cashOrders.length,
      onlineCount: onlineOrders.length
    });
  }

  // Fallback
  const paidOrders = db.orders.filter(o => o.payment_status === 'PAID' && o.date === targetDate);
  const cashOrders = paidOrders.filter(o => o.payment_method === 'CASH');
  const onlineOrders = paidOrders.filter(o => o.payment_method === 'ONLINE');
  const totalEarnings = paidOrders.reduce((s, o) => s + o.total, 0);
  const cashTotal = cashOrders.reduce((s, o) => s + o.total, 0);
  const onlineTotal = onlineOrders.reduce((s, o) => s + o.total, 0);
  const todayExpenses = db.expenses.filter(e => e.date === targetDate).reduce((s, e) => s + e.amount, 0);

  res.json({
    date: targetDate,
    totalEarnings,
    cashTotal,
    onlineTotal,
    totalExpenses: todayExpenses,
    netProfit: totalEarnings - todayExpenses,
    paidOrderCount: paidOrders.length,
    cashCount: cashOrders.length,
    onlineCount: onlineOrders.length
  });
}));

// ===========================
// EXPENSE ROUTES
// ===========================
app.get('/api/expenses', authMiddleware, asyncWrap(async (req, res) => {
  const { date } = req.query;

  if (USE_DB) {
    let query = supabase.from('expenses').select('*');
    if (date) query = query.eq('date', date);
    const { data: expenses } = await query.order('timestamp', { ascending: false });
    return res.json(expenses || []);
  }

  let expenses = [...db.expenses];
  if (date) expenses = expenses.filter(e => e.date === date);
  expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(expenses);
}));

app.post('/api/expenses', authMiddleware, asyncWrap(async (req, res) => {
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

  if (USE_DB) {
    const { error } = await supabase.from('expenses').insert(expense);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    db.expenses.push(expense);
  }

  console.log(`[EXPENSE] ${name} - ₹${amount} on ${date}`);
  res.json({ success: true, expense });
}));

app.put('/api/expenses/:id', authMiddleware, asyncWrap(async (req, res) => {
  const { name, amount, note, date } = req.body;

  if (USE_DB) {
    const updates = {};
    if (name) updates.name = name;
    if (amount) updates.amount = Number(amount);
    if (note !== undefined) updates.note = note;
    if (date) updates.date = date;
    const { data: expense } = await supabase.from('expenses').update(updates).eq('id', req.params.id).select().single();
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    return res.json({ success: true, expense });
  }

  const expense = db.expenses.find(e => e.id === req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (name) expense.name = name;
  if (amount) expense.amount = Number(amount);
  if (note !== undefined) expense.note = note;
  if (date) expense.date = date;
  res.json({ success: true, expense });
}));

app.delete('/api/expenses/:id', authMiddleware, asyncWrap(async (req, res) => {
  if (USE_DB) {
    const { error } = await supabase.from('expenses').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  }

  const idx = db.expenses.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
  db.expenses.splice(idx, 1);
  res.json({ success: true });
}));

// ===========================
// FINANCIAL REPORTS
// ===========================
app.get('/api/reports', authMiddleware, asyncWrap(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'From and to dates required' });

  if (USE_DB) {
    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .gte('date', from)
      .lte('date', to);
    const { data: expenses } = await supabase
      .from('expenses')
      .select('*')
      .gte('date', from)
      .lte('date', to);

    const allOrders = orders || [];
    const allExpenses = expenses || [];

    const totalOrders = allOrders.length;
    const completedOrders = allOrders.filter(o => o.order_status === 'COMPLETED').length;
    const cancelledOrders = allOrders.filter(o => o.order_status === 'CANCELLED').length;
    const pendingOrders = allOrders.filter(o => o.order_status === 'PENDING').length;

    const paidOrders = allOrders.filter(o => o.payment_status === 'PAID');
    const totalEarnings = paidOrders.reduce((sum, o) => sum + Number(o.total), 0);
    const cashTotal = paidOrders.filter(o => o.payment_method === 'CASH').reduce((sum, o) => sum + Number(o.total), 0);
    const onlineTotal = paidOrders.filter(o => o.payment_method === 'ONLINE').reduce((sum, o) => sum + Number(o.total), 0);
    const totalExpenses = allExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const profit = totalEarnings - totalExpenses;

    const expBreakdown = {};
    allExpenses.forEach(e => { expBreakdown[e.name] = (expBreakdown[e.name] || 0) + Number(e.amount); });

    allOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    allExpenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json({
      from, to, totalOrders, completedOrders, cancelledOrders, pendingOrders,
      totalEarnings, cashTotal, onlineTotal, totalExpenses, netProfit: profit,
      expenseBreakdown: expBreakdown, orders: allOrders, expenses: allExpenses
    });
  }

  // Fallback
  const orders = db.orders.filter(o => o.date >= from && o.date <= to);
  const expenses = db.expenses.filter(e => e.date >= from && e.date <= to);
  const paidOrders = orders.filter(o => o.payment_status === 'PAID');
  const totalEarnings = paidOrders.reduce((sum, o) => sum + o.total, 0);
  const cashTotal = paidOrders.filter(o => o.payment_method === 'CASH').reduce((sum, o) => sum + o.total, 0);
  const onlineTotal = paidOrders.filter(o => o.payment_method === 'ONLINE').reduce((sum, o) => sum + o.total, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const expBreakdown = {};
  expenses.forEach(e => { expBreakdown[e.name] = (expBreakdown[e.name] || 0) + e.amount; });

  res.json({
    from, to,
    totalOrders: orders.length,
    completedOrders: orders.filter(o => o.order_status === 'COMPLETED').length,
    cancelledOrders: orders.filter(o => o.order_status === 'CANCELLED').length,
    pendingOrders: orders.filter(o => o.order_status === 'PENDING').length,
    totalEarnings, cashTotal, onlineTotal, totalExpenses,
    netProfit: totalEarnings - totalExpenses,
    expenseBreakdown: expBreakdown,
    orders: orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    expenses: expenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  });
}));

// ===========================
// DASHBOARD STATS
// ===========================
app.get('/api/dashboard', authMiddleware, asyncWrap(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  if (USE_DB) {
    const { data: todayOrders } = await supabase.from('orders').select('*').eq('date', today);
    const { data: allPending } = await supabase.from('orders').select('*').eq('order_status', 'PENDING');
    const { data: todayExpenses } = await supabase.from('expenses').select('amount').eq('date', today);
    const { data: activeSessions } = await supabase.from('table_sessions').select('table').eq('status', 'ACTIVE');

    const tOrders = todayOrders || [];
    const tExpenses = todayExpenses || [];

    const paidToday = tOrders.filter(o => o.payment_status === 'PAID');
    const earnings = paidToday.reduce((s, o) => s + Number(o.total), 0);
    const cashTotal = paidToday.filter(o => o.payment_method === 'CASH').reduce((s, o) => s + Number(o.total), 0);
    const onlineTotal = paidToday.filter(o => o.payment_method === 'ONLINE').reduce((s, o) => s + Number(o.total), 0);
    const expenses = tExpenses.reduce((s, e) => s + Number(e.amount), 0);

    const pending = (allPending || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10);

    return res.json({
      todayOrdersCount: tOrders.length,
      pendingCount: (allPending || []).length,
      completedTodayCount: tOrders.filter(o => o.order_status === 'COMPLETED').length,
      cancelledTodayCount: tOrders.filter(o => o.order_status === 'CANCELLED').length,
      earnings,
      cashTotal,
      onlineTotal,
      expenses,
      profit: earnings - expenses,
      activeTables: (activeSessions || []).map(s => s.table),
      recentPending: pending
    });
  }

  // Fallback
  const allOrders = db.orders;
  const todayOrders = allOrders.filter(o => o.date === today);
  const pending = allOrders.filter(o => o.order_status === 'PENDING');
  const paidToday = todayOrders.filter(o => o.payment_status === 'PAID');
  const earnings = paidToday.reduce((s, o) => s + o.total, 0);
  const cashTotal = paidToday.filter(o => o.payment_method === 'CASH').reduce((s, o) => s + o.total, 0);
  const onlineTotal = paidToday.filter(o => o.payment_method === 'ONLINE').reduce((s, o) => s + o.total, 0);
  const todayExpenses = db.expenses.filter(e => e.date === today).reduce((s, e) => s + e.amount, 0);

  res.json({
    todayOrdersCount: todayOrders.length,
    pendingCount: pending.length,
    completedTodayCount: todayOrders.filter(o => o.order_status === 'COMPLETED').length,
    cancelledTodayCount: todayOrders.filter(o => o.order_status === 'CANCELLED').length,
    earnings,
    cashTotal,
    onlineTotal,
    expenses: todayExpenses,
    profit: earnings - todayExpenses,
    activeTables: db.table_sessions.filter(s => s.status === 'ACTIVE').map(s => s.table),
    recentPending: pending.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10)
  });
}));

// ===========================
// HEALTH CHECK
// ===========================
app.get('/api/health', asyncWrap(async (req, res) => {
  if (USE_DB) {
    const { count: orders } = await supabase.from('orders').select('*', { count: 'exact', head: true });
    const { count: expenses } = await supabase.from('expenses').select('*', { count: 'exact', head: true });
    const { count: sessions } = await supabase.from('table_sessions').select('*', { count: 'exact', head: true });
    const { count: payments } = await supabase.from('payments').select('*', { count: 'exact', head: true });
    return res.json({ status: 'ok', database: 'supabase', orders: orders || 0, expenses: expenses || 0, sessions: sessions || 0, payments: payments || 0 });
  }
  res.json({ status: 'ok', database: 'in-memory', orders: db.orders.length, expenses: db.expenses.length, sessions: db.table_sessions.length, payments: db.payments.length });
}));

// ===========================
// STATIC JS FILES — served explicitly for Vercel compatibility
// ===========================
app.get('/customer.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'customer.js'));
});
app.get('/admin.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'admin.js'));
});

// ===========================
// CATCH-ALL (only for local dev, not Vercel)
// ===========================
if (!process.env.VERCEL) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });
}

// Export for Vercel serverless
module.exports = app;

// Start server (only when running locally, not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🍕 THE OREGANO CAFE — Server running on http://localhost:${PORT}`);
    console.log(`📋 Customer: http://localhost:${PORT}`);
    console.log(`🔒 Admin: http://localhost:${PORT}#admin`);
    console.log(`📊 API Health: http://localhost:${PORT}/api/health`);
    console.log(`💾 Database: ${USE_DB ? 'Supabase (PostgreSQL)' : 'In-Memory (local dev)'}\n`);
  });
}
