require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

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
// DATABASE STARTUP MIGRATIONS
// ===========================
async function runStartupMigrations() {
  if (!USE_DB) return;
  try {
    // Ensure the admins table holds ONLY the new credentials.
    // (UPSERT new admin, then delete the legacy admin/admin123 record.)
    const adminResult = await supabase.rpc('exec_sql', { sql: `
      INSERT INTO admins (username, password, name) VALUES ('${ADMIN_USERNAME}', '${ADMIN_PASSWORD}', 'Admin')
      ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password;
      DELETE FROM admins WHERE username = 'admin';
    ` });
    if (adminResult && adminResult.error) {
      console.log('[MIGRATION] exec_sql unavailable — trying direct admin-table upsert:', adminResult.error.message || 'ok');
      // Fallback without exec_sql: upsert new record via the REST API, then try to
      // remove the legacy 'admin' record (guarded — username column is unique).
      const up = await supabase.from('admins')
        .upsert({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, name: 'Admin' }, { onConflict: 'username' });
      if (up.error) console.warn('[MIGRATION] Admin upsert failed:', up.error.message);
      else console.log('[MIGRATION] Admin record ensured: ' + ADMIN_USERNAME);
      const del = await supabase.from('admins').delete().eq('username', 'admin');
      if (del.error) console.warn('[MIGRATION] Legacy admin removal failed (may not exist):', del.error.message);
      else console.log('[MIGRATION] Legacy admin/admin123 record removed');
    } else {
      console.log('[MIGRATION] Admin credentials ensured (legacy admin record removed)');
    }

    // Attempt to fix bills table CHECK constraint to support SPLIT payments
    // This is safe to run multiple times
    const result = await supabase.rpc('exec_sql', { sql: `
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name LIKE 'bills_payment_method_check%'
          AND table_name = 'bills'
        ) THEN
          ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payment_method_check;
          ALTER TABLE bills ADD CONSTRAINT bills_payment_method_check
            CHECK (payment_method IN ('CASH', 'ONLINE', 'SPLIT'));
        END IF;
      END $$
    ` });
    if (result && result.error) {
      console.log('[MIGRATION] rpc not available (expected):', result.error.message || 'ok');
    } else {
      console.log('[MIGRATION] Bills CHECK constraint updated successfully');
    }
    // Add cash_amount/online_amount columns to bills table if missing
    try {
      const colResult = await supabase.rpc('exec_sql', { sql: `
        ALTER TABLE IF EXISTS bills ADD COLUMN IF NOT EXISTS cash_amount NUMERIC DEFAULT 0;
        ALTER TABLE IF EXISTS bills ADD COLUMN IF NOT EXISTS online_amount NUMERIC DEFAULT 0;
      ` });
      if (colResult && colResult.error) {
        console.log('[MIGRATION] Column addition skipped (exec_sql unavailable):', colResult.error.message || 'ok');
      } else {
        console.log('[MIGRATION] Bills cash_amount/online_amount columns ensured');
      }
    } catch (colErr) {
      console.log('[MIGRATION] Column addition skipped (exec_sql unavailable):', colErr.message || 'ok');
    }
    // Read-only probe: hosted Supabase usually has no exec_sql RPC, so this is how we
    // detect whether the split-payment columns actually exist.
    try {
      const { error: billProbe } = await supabase.from('bills').select('cash_amount, online_amount').limit(1);
      const { error: payProbe } = await supabase.from('payments').select('cash_amount, online_amount').limit(1);
      const missingBills = billProbe && billProbe.message && billProbe.message.includes('column');
      const missingPays = payProbe && payProbe.message && payProbe.message.includes('column');
      if (missingBills || missingPays) {
        console.warn('=================================================================');
        if (missingBills) console.warn('[MIGRATION REQUIRED] bills table is missing cash_amount/online_amount.');
        if (missingPays) console.warn('[MIGRATION REQUIRED] payments table is missing cash_amount/online_amount.');
        console.warn('[MIGRATION REQUIRED] SPLIT payment breakdowns will NOT persist to Supabase.');
        console.warn('[MIGRATION REQUIRED] Run supabase/migrations/20260914_001_fix_payment_schema.sql');
        console.warn('[MIGRATION REQUIRED] in the Supabase SQL Editor to fix this permanently.');
        console.warn('=================================================================');
      } else {
        console.log('[MIGRATION] Split payment columns verified on bills + payments');
      }
    } catch (probeErr) { /* non-fatal */ }

    // Probe for bill-before-payment columns (payment_status, items, etc.)
    // Without these, bills can only be created AFTER payment (old workflow).
    try {
      const { error: bpProbe } = await supabase.from('bills').select('payment_status').limit(1);
      const { error: bpItemsProbe } = await supabase.from('bills').select('items').limit(1);
      const missingPaymentStatus = bpProbe && bpProbe.message && bpProbe.message.includes('column');
      const missingItems = bpItemsProbe && bpItemsProbe.message && bpItemsProbe.message.includes('column');
      if (missingPaymentStatus || missingItems) {
        console.warn('=================================================================');
        if (missingPaymentStatus) console.warn('[MIGRATION REQUIRED] bills table is missing payment_status column.');
        if (missingItems) console.warn('[MIGRATION REQUIRED] bills table is missing items column.');
        console.warn('[MIGRATION REQUIRED] Bill-before-payment workflow will NOT work on Supabase.');
        console.warn('[MIGRATION REQUIRED] Bills will be stored in memory only (lost on restart).');
        console.warn('[MIGRATION REQUIRED] Run supabase/migrations/20260918_001_bill_before_payment.sql');
        console.warn('[MIGRATION REQUIRED] in the Supabase SQL Editor to fix this permanently.');
        console.warn('=================================================================');
      } else {
        console.log('[MIGRATION] Bill-before-payment columns verified (payment_status, items)');
      }
    } catch (bpProbeErr) { /* non-fatal */ }

    console.log('[MIGRATION] Startup migrations completed');
  } catch (e) {
    // rpc function may not exist — this is expected
    console.log('[MIGRATION] rpc not available (expected):', e.message);
  }
}

// ===========================
// SUPABASE DATABASE
// ===========================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const USE_DB = !!(supabaseUrl && supabaseKey);

// Declare supabase at module scope so all routes can access it
let supabase = null;

// ===========================
// ADMIN AUTH — server-side credentials (never shipped to the customer client)
// ===========================
// Must be declared before runStartupMigrations() which references them.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'oreganocafe';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2019';
const ADMIN_SESSION_TOKEN = 'toc-' + crypto.createHash('sha256').update(ADMIN_USERNAME + ':' + ADMIN_PASSWORD).digest('hex').substring(0, 32);

if (USE_DB) {
  // Log only the project hostname (not the full URL with sensitive path)
  try {
    const urlObj = new URL(supabaseUrl);
    const projectHost = urlObj.hostname;
    console.log(`[SUPABASE] Connected to project: ${projectHost}`);
  } catch (e) {
    console.log('[SUPABASE] Connected (URL format could not be parsed)');
  }
  supabase = createClient(supabaseUrl, supabaseKey);
  // Run startup migrations (safe to run multiple times)
  runStartupMigrations();
} else {
  console.log('[SUPABASE] Not configured - using in-memory fallback');
}

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
  admins: [{ id: 1, username: ADMIN_USERNAME, password: ADMIN_PASSWORD, name: 'Admin' }],
  orders: [],
  expenses: [],
  table_sessions: [],
  payments: [],
  bills: []
};

// Extra order metadata (order_type, delivery) stored separately
// so it survives even when Supabase columns are not yet added.
const orderMeta = new Map();

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

// Auth middleware — token derives from the current admin credentials, so changing
// credentials (or the admins table) immediately invalidates every old session.
function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  if (token !== ADMIN_SESSION_TOKEN) return res.status(401).json({ error: 'Invalid token' });
  next();
}

// ===========================
// SSE ENDPOINT (Server-Sent Events for realtime updates)
// ===========================
app.get('/api/events', (req, res) => {
  // EventSource cannot send custom headers, so the token arrives as a query param.
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_SESSION_TOKEN) return res.status(401).json({ error: 'Invalid token' });


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
      // First, count matching records to diagnose .single() issues
      const { count: matchCount, error: countError } = await supabase
        .from('admins')
        .select('*', { count: 'exact', head: true })
        .eq('username', username)
        .eq('password', password);

      if (countError) {
        console.error('Login count error:', countError.message, 'code:', countError.code);
        return res.status(500).json({ error: 'Database error. Please try again.' });
      }

      console.log(`[LOGIN ATTEMPT] username lookup: ${username}, matching rows: ${matchCount || 0}`);

      if (matchCount > 1) {
        console.error('[LOGIN ERROR] Multiple admin records match credentials. Expected 0 or 1, got:', matchCount);
        return res.status(500).json({ error: 'Database inconsistency detected. Please contact admin.' });
      }

      const { data: admin, error } = await supabase
        .from('admins')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .maybeSingle();

      if (error) {
        console.error('Login Supabase error:', error.message, 'code:', error.code);
        return res.status(500).json({ error: 'Database error. Please try again.' });
      }
      if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ success: true, token: ADMIN_SESSION_TOKEN, name: admin.name });
    } else {
      const admin = db.admins.find(a => a.username === username && a.password === password);
      if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ success: true, token: ADMIN_SESSION_TOKEN, name: admin.name });
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
    // Use maybeSingle() to avoid PGRST116 errors on 0 rows — returns null cleanly
    const { data, error } = await supabase
      .from('table_sessions')
      .select('*')
      .eq('"table"', tableNum)
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[SESSION] getActiveSession primary query error:', error.message, 'table:', tableNum);
      // Fallback: try unquoted column name
      const { data: fb, error: fbErr } = await supabase
        .from('table_sessions')
        .select('*')
        .eq('table', tableNum)
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!fbErr) {
        console.log('[SESSION] getActiveSession fallback succeeded for table', tableNum, '→', fb ? fb.id : 'null');
        return fb;
      }
      console.error('[SESSION] getActiveSession fallback also failed:', fbErr.message, 'table:', tableNum);
      return null;
    }

    console.log('[SESSION] getActiveSession table', tableNum, '→', data ? data.id : 'null (no active session)');
    return data;
  }
  return db.table_sessions.find(s => s.table === tableNum && s.status === 'ACTIVE');
}

async function createSession(tableNum) {
  if (USE_DB) {
    // Get the highest existing session number to avoid ID collisions
    const { data: lastSession } = await supabase
      .from('table_sessions')
      .select('id')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let sessionNum = 1;
    if (lastSession && lastSession.id) {
      const match = lastSession.id.match(/SES-(\d+)/);
      if (match) sessionNum = parseInt(match[1], 10) + 1;
    }

    const sessionId = 'SES-' + String(sessionNum).padStart(6, '0');
    console.log('[SESSION] createSession generating ID:', sessionId, 'for table', tableNum);

    const session = {
      id: sessionId,
      table: tableNum,
      status: 'ACTIVE',
      total_amount: 0,
      payment_method: null,
      created_at: new Date().toISOString(),
      settled_at: null
    };
    const { error: insertErr } = await supabase.from('table_sessions').insert(session);
    if (insertErr) {
      console.error('[SESSION] createSession insert error:', insertErr.message, 'code:', insertErr.code, 'table:', tableNum);
      // If duplicate key, try next number
      if (insertErr.code === '23505') {
        session.id = 'SES-' + String(sessionNum + 1).padStart(6, '0');
        const { error: retryErr } = await supabase.from('table_sessions').insert(session);
        if (retryErr) {
          console.error('[SESSION] createSession retry also failed:', retryErr.message);
        } else {
          console.log('[SESSION] Created session (retry)', session.id, 'for table', tableNum);
        }
      }
    } else {
      console.log('[SESSION] Created session', session.id, 'for table', tableNum);
    }
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
  const ist = getISTNow();
  const ds = ist.getFullYear().toString() +
    String(ist.getMonth() + 1).padStart(2, '0') +
    String(ist.getDate()).padStart(2, '0');
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

async function generateBillNumber() {
  const ist = getISTNow();
  const ds = ist.getFullYear().toString() +
    String(ist.getMonth() + 1).padStart(2, '0') +
    String(ist.getDate()).padStart(2, '0');
  const prefix = 'TOC-' + ds + '-';

  // Combine Supabase bills + in-memory bills for numbering
  let count = 0;
  if (USE_DB) {
    try {
      const { data: todayBills, error: billCountErr } = await supabase
        .from('bills')
        .select('bill_number')
        .like('bill_number', prefix + '%');
      if (!billCountErr && todayBills) {
        count = todayBills.length;
      } else {
        // Table may not exist yet, fall through to in-memory count
      }
    } catch(e) { /* fall through to in-memory count */ }
  }
  // Also count in-memory bills for today
  count += db.bills.filter(b => b.bill_number.startsWith(prefix)).length;
  const num = (count + 1).toString().padStart(3, '0');
  return prefix + num;
}

// ===========================
// UNPAID BILL HELPERS — bill-before-payment workflow
// A bill is generated when the customer asks for it, BEFORE any payment method
// is chosen. payment_method stays null and payment_status stays 'UNPAID' until
// the admin records CASH / ONLINE / SPLIT against the generated bill.
// ===========================

// Aggregate all UNPAID COMPLETED orders of a session into one items list.
// CANCELLED and PENDING orders are never payable — they are excluded.
function aggregatePayableItems(orders) {
  const items = [];
  for (const o of orders) {
    for (const it of (o.items || [])) {
      items.push({
        name: it.name,
        qty: Number(it.qty) || 0,
        price: Number(it.price) || 0,
        total: (Number(it.price) || 0) * (Number(it.qty) || 0),
        options: it.options || [],
        order_id: o.id,
        order_time: o.time || null
      });
    }
  }
  return items;
}

// Build the unpaid-bill record for a session (or null when there is nothing
// payable yet). One session always has AT MOST ONE unpaid bill.
async function getUnpaidBillForSession(session) {
  if (!session) return null;
  if (USE_DB) {
    const { data: existing, error: billErr } = await supabase
      .from('bills')
      .select('*')
      .eq('session_id', session.id)
      .eq('payment_status', 'UNPAID')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
    if (billErr) console.warn('[BILLS] getUnpaidBillForSession Supabase query error:', billErr.message);
    // Fallback: bill may exist only in memory (Supabase insert failed for schema reasons)
    const memBill = db.bills.find(b => b.session_id === session.id && b.payment_status === 'UNPAID');
    if (memBill) return memBill;
  } else {
    const existing = db.bills.find(b => b.session_id === session.id && b.payment_status === 'UNPAID');
    if (existing) return existing;
  }
  return null;
}

// Create (or refresh) the single UNPAID bill for a session from its unpaid
// COMPLETED orders. PENDING orders are not on the bill yet — the customer may
// still order more; generate again before payment to pick them up.
async function createUnpaidBillForSession(session, tableNum) {
  let unpaidOrders;
  if (USE_DB) {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID')
      .order('timestamp', { ascending: true });
    unpaidOrders = data || [];
  } else {
    unpaidOrders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  }

  if (!unpaidOrders.length) return { error: 'No completed unpaid orders for this session yet.' };

  const totalAmount = unpaidOrders.reduce((sum, o) => sum + Number(o.total), 0);
  if (totalAmount <= 0) return { error: 'No payable amount for this session.' };

  const now = new Date();
  const istNow = getISTNow();
  const issuedIST = formatISTDateTime(istNow);
  const billNumber = await generateBillNumber();

  const bill = {
    id: 'BILL-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    bill_number: billNumber,
    session_id: session.id,
    table: tableNum,
    orders: unpaidOrders.map(o => ({ id: o.id, items: o.items, total: o.total, time: o.time, order_status: o.order_status })),
    items: aggregatePayableItems(unpaidOrders),
    subtotal: totalAmount,
    total: totalAmount,
    payment_status: 'UNPAID',
    payment_method: null,
    cash_amount: 0,
    online_amount: 0,
    bill_date: issuedIST.date,
    bill_time: issuedIST.time12h + ' IST',
    payment_date: null,
    payment_time: null,
    paid_at: null,
    created_at: now.toISOString()
  };

  if (USE_DB) {
    let insertErr;
    try {
      const r = await supabase.from('bills').insert(bill);
      insertErr = r.error;
    } catch (e) { insertErr = e; }
    if (insertErr) {
      const isColumnErr = insertErr.message && insertErr.message.includes('column');
      const isConstraintErr = insertErr.code === '23514' || (insertErr.message && insertErr.message.includes('check constraint'));
      if (isColumnErr || isConstraintErr) {
        // Supabase schema not migrated yet — insert a compatible subset and keep
        // the complete record in memory so the API/UI always has the full data.
        console.warn('[BILLS] Supabase insert failed (' + insertErr.message + ') — inserting minimal unpaid bill, full record kept in memory.');
        const minimal = { ...bill };
        delete minimal.items; delete minimal.subtotal; delete minimal.bill_date; delete minimal.bill_time; delete minimal.paid_at;
        try {
          const r2 = await supabase.from('bills').insert(minimal);
          if (r2.error) console.warn('[BILLS] Minimal insert also failed:', r2.error.message, '— unpaid bill kept in memory only.');
        } catch (e2) { console.warn('[BILLS] Minimal insert exception:', e2.message); }
        db.bills.push(bill);
      } else {
        console.warn('[BILLS] Unhandled unpaid-bill insert error — keeping in memory:', insertErr.message);
        db.bills.push(bill);
      }
    }
  } else {
    db.bills.push(bill);
  }

  console.log(`[BILL GENERATED] ${bill.bill_number} — Table ${tableNum} — ₹${totalAmount} — UNPAID (session ${session.id}, ${unpaidOrders.length} order(s))`);
  return { bill };
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
      // Merge extra metadata (order_type, delivery) from in-memory cache
      const enriched = (orders || []).map(o => {
        const meta = orderMeta.get(o.id);
        if (meta) return { ...o, ...meta };
        return o;
      });
      return res.json(enriched);
    }

    // Fallback: in-memory
    let orders = [...db.orders].map(o => {
      const meta = orderMeta.get(o.id);
      if (meta) return { ...o, ...meta };
      return o;
    });
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
    const meta = orderMeta.get(order.id);
    return res.json(meta ? { ...order, ...meta } : order);
  }
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const meta = orderMeta.get(order.id);
  res.json(meta ? { ...order, ...meta } : order);
}));

// Create order (customer-facing)
const TOTAL_TABLES = 20;

app.post('/api/orders', asyncWrap(async (req, res) => {
  const { table, items, order_type, delivery } = req.body;
  if (table === undefined || table === null || table === '' || !items || items.length === 0) {
    return res.status(400).json({ error: 'Table and items are required' });
  }
  // Validate table number (1-20)
  const tableNum = Number(table);
  if (!Number.isInteger(tableNum) || tableNum < 1 || tableNum > TOTAL_TABLES) {
    return res.status(400).json({ error: 'Please enter a table number between 1-' + TOTAL_TABLES + '.' });
  }

  const now = new Date();
  const istNow = getISTNow();
  const ds = istNow.getFullYear().toString() +
    String(istNow.getMonth() + 1).padStart(2, '0') +
    String(istNow.getDate()).padStart(2, '0');

  const orderId = await generateOrderId();
  let session = await getActiveSession(Number(table));
  console.log(`[NEW ORDER] ${orderId} - Table ${table} - getActiveSession → ${session ? session.id : 'null'}`);
  if (!session) {
    session = await createSession(Number(table));
    console.log(`[NEW ORDER] ${orderId} - Table ${table} - createSession → ${session.id}`);
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
    order_type: order_type || 'dine-in',
    delivery: delivery || null,
    date: ds.substring(0, 4) + '-' + ds.substring(4, 6) + '-' + ds.substring(6, 8),
    time: formatISTDateTime(istNow).time12h + ' IST',
    timestamp: now.toISOString(),
    completed_at: null,
    cancelled_at: null,
    paid_at: null
  };

  // Store metadata separately for retrieval even if Supabase columns missing
  orderMeta.set(orderId, { order_type: order.order_type, delivery: order.delivery });

  if (USE_DB) {
    const { error } = await supabase.from('orders').insert(order);
    if (error) {
      console.error('[NEW ORDER] Insert error:', error.message, 'code:', error.code, 'orderId:', orderId, 'session_id:', order.session_id);
      // If columns are missing, insert without order_type/delivery
      const fallbackOrder = { ...order, order_type: undefined, delivery: undefined };
      const { error: retryError } = await supabase.from('orders').insert(fallbackOrder);
      if (retryError) {
        console.error('[NEW ORDER] Retry insert also failed:', retryError.message, 'code:', retryError.code);
        return res.status(500).json({ error: retryError.message });
      }
    } else {
      console.log(`[NEW ORDER] Insert OK: ${orderId} session_id=${order.session_id} table=${table}`);
    }
  } else {
    db.orders.push(order);
  }

  console.log(`[NEW ORDER] ${orderId} - Table ${table} - ₹${order.total} - Session ${session.id}${order_type ? ' ['+order_type+']' : ''}`);
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

    const meta = orderMeta.get(order.id);
    console.log(`[ORDER ${action.toUpperCase()}] ${order.id} - Table ${order.table}`);
    return res.json({ success: true, order: meta ? { ...order, ...meta } : order });
  }

  // Fallback: in-memory
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (action === 'complete') {
    order.order_status = 'COMPLETED';
    order.completed_at = now.toISOString();
    await recalcSessionTotal(order.session_id);
    broadcastSSE('order_completed', { order: { ...order, ...(orderMeta.get(order.id) || {}) }, session_total: db.table_sessions.find(s => s.id === order.session_id)?.total_amount || 0 });
  } else if (action === 'cancel') {
    order.order_status = 'CANCELLED';
    order.payment_status = 'NOT_APPLICABLE';
    order.cancelled_at = now.toISOString();
    await recalcSessionTotal(order.session_id);
    broadcastSSE('order_cancelled', { ...order, ...(orderMeta.get(order.id) || {}) });
  }

  console.log(`[ORDER ${action.toUpperCase()}] ${order.id} - Table ${order.table}`);
  res.json({ success: true, order });
}));

// Permanently delete order
app.delete('/api/orders/:id', authMiddleware, asyncWrap(async (req, res) => {
  if (USE_DB) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Recalculate session total for COMPLETED/UNPAID or CANCELLED orders
    if (order.session_id && (order.order_status === 'COMPLETED' && order.payment_status === 'UNPAID' || order.order_status === 'CANCELLED')) {
      await recalcSessionTotal(order.session_id);
    }

    await supabase.from('orders').delete().eq('id', req.params.id);
    console.log(`[ORDER DELETED] ${order.id} - Table ${order.table}`);

    // After deletion, check if session should be closed (no orders remaining)
    let sessionClosed = false;
    if (order.session_id) {
      const { data: remainingOrders } = await supabase
        .from('orders')
        .select('id')
        .eq('session_id', order.session_id);

      if (!remainingOrders || remainingOrders.length === 0) {
        // No orders remain — close the session so table becomes AVAILABLE
        await supabase.from('table_sessions').update({
          status: 'SETTLED',
          settled_at: new Date().toISOString(),
          total_amount: 0
        }).eq('id', order.session_id);
        console.log(`[SESSION CLOSED] ${order.session_id} — no orders remaining after deletion`);
        sessionClosed = true;
      } else {
        await recalcSessionTotal(order.session_id);
      }
    }

    broadcastSSE('order_deleted', { orderId: order.id, table: order.table, session_id: order.session_id, session_closed: sessionClosed });
    return res.json({ success: true, session_closed: sessionClosed });
  }

  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  const order = db.orders[idx];
  if (order.session_id && (order.order_status === 'COMPLETED' && order.payment_status === 'UNPAID' || order.order_status === 'CANCELLED')) {
    await recalcSessionTotal(order.session_id);
  }
  db.orders.splice(idx, 1);
  console.log(`[ORDER DELETED] ${order.id} - Table ${order.table}`);

  // After deletion, check if session should be closed (in-memory)
  let sessionClosed = false;
  if (order.session_id) {
    const remaining = db.orders.filter(o => o.session_id === order.session_id);
    if (remaining.length === 0) {
      const sess = db.table_sessions.find(s => s.id === order.session_id);
      if (sess && sess.status === 'ACTIVE') {
        sess.status = 'SETTLED';
        sess.settled_at = new Date().toISOString();
        sess.total_amount = 0;
        console.log(`[SESSION CLOSED] ${order.session_id} — no orders remaining after deletion`);
        sessionClosed = true;
      }
    } else {
      await recalcSessionTotal(order.session_id);
    }
  }

  broadcastSSE('order_deleted', { orderId: order.id, table: order.table, session_id: order.session_id, session_closed: sessionClosed });
  res.json({ success: true, session_closed: sessionClosed });
}));

// ===========================
// TABLE SESSION ROUTES
// ===========================

// Get all tables with session info
app.get('/api/tables', authMiddleware, asyncWrap(async (req, res) => {
  const tables = [];

  if (USE_DB) {
    // Fetch all active sessions in ONE query
    const { data: activeSessions } = await supabase
      .from('table_sessions')
      .select('id, "table"')
      .eq('status', 'ACTIVE');

    // Get all session IDs that have active sessions
    const activeSessionIds = new Set((activeSessions || []).map(s => s.id));

    // Fetch all orders for these sessions in ONE query
    let allSessionOrders = [];
    if (activeSessionIds.size > 0) {
      const { data: orders } = await supabase
        .from('orders')
        .select('session_id, order_status, payment_status, total')
        .in('session_id', Array.from(activeSessionIds));
      allSessionOrders = orders || [];
    }

    // Build a map of session data for quick lookup by table number
    const sessionMap = new Map();
    for (const s of (activeSessions || [])) {
      sessionMap.set(s.table, { session: s });
    }

    // Build a map of order data per session
    const sessionOrderMap = new Map();
    for (const order of allSessionOrders) {
      if (!sessionOrderMap.has(order.session_id)) {
        sessionOrderMap.set(order.session_id, []);
      }
      sessionOrderMap.get(order.session_id).push(order);
    }

    // Build tables array
    for (let i = 1; i <= 20; i++) {
      const sessionData = sessionMap.get(i);
      const session = sessionData ? sessionData.session : null;
      const sessionId = session ? session.id : null;

      let allOrders = [];
      if (sessionId && sessionOrderMap.has(sessionId)) {
        allOrders = sessionOrderMap.get(sessionId);
      }

      // Only count NON-CANCELLED orders as current/active for occupancy
      const currentOrders = allOrders.filter(o => o.order_status !== 'CANCELLED');
      const unpaidOrders = currentOrders.filter(o => o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
      const pendingOrders = currentOrders.filter(o => o.order_status === 'PENDING');
      const runningBill = unpaidOrders.reduce((sum, o) => sum + Number(o.total), 0);

      // OCCUPIED = has active session AND at least one current (non-cancelled) order
      let isOccupied = !!session && currentOrders.length > 0;

      // Auto-close session if all orders are cancelled (no active orders remain)
      if (session && currentOrders.length === 0) {
        await supabase.from('table_sessions').update({
          status: 'SETTLED',
          settled_at: new Date().toISOString(),
          total_amount: 0
        }).eq('id', session.id);
        isOccupied = false;
      }

      tables.push({
        number: i,
        has_active_session: !!session && isOccupied,
        session_id: isOccupied ? sessionId : null,
        running_bill: runningBill,
        unpaid_count: unpaidOrders.length,
        pending_count: pendingOrders.length,
        total_orders: allOrders.length,
        status: isOccupied ? 'OCCUPIED' : 'AVAILABLE'
      });
      if (isOccupied) {
        console.log(`[TABLE STATE] Table ${i} = OCCUPIED (${currentOrders.length} current orders, ${pendingOrders.length} pending)`);
      }
    }
    const occupiedTables = tables.filter(t => t.status === 'OCCUPIED');
    console.log(`[TABLE STATE] Occupied: ${occupiedTables.length}/20 — tables: ${occupiedTables.map(t => t.number).join(', ')}`);
    return res.json(tables);
  }

  // Fallback: in-memory
  for (let i = 1; i <= 20; i++) {
    const session = db.table_sessions.find(s => s.table === i && s.status === 'ACTIVE');
    let allOrders = [];

    if (session) {
      allOrders = db.orders.filter(o => o.session_id === session.id);
    }

    // Only count NON-CANCELLED orders as current/active for occupancy
    const currentOrders = allOrders.filter(o => o.order_status !== 'CANCELLED');
    const unpaidOrders = currentOrders.filter(o => o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
    const pendingOrders = currentOrders.filter(o => o.order_status === 'PENDING');
    const runningBill = unpaidOrders.reduce((sum, o) => sum + o.total, 0);

    // OCCUPIED = has active session AND at least one current (non-cancelled) order
    let isOccupied = !!session && currentOrders.length > 0;

    // Auto-close session if all orders are cancelled
    if (session && currentOrders.length === 0) {
      session.status = 'SETTLED';
      session.settled_at = new Date().toISOString();
      session.total_amount = 0;
      isOccupied = false;
    }

    tables.push({
      number: i,
      has_active_session: !!session && isOccupied,
      session_id: isOccupied ? session.id : null,
      running_bill: runningBill,
      unpaid_count: unpaidOrders.length,
      pending_count: pendingOrders.length,
      total_orders: allOrders.length,
      status: isOccupied ? 'OCCUPIED' : 'AVAILABLE'
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

// Generate the bill for a table session — BEFORE any payment method is chosen.
// Body is ignored: payment method is NOT part of bill generation.
app.post('/api/tables/:number/generate-bill', authMiddleware, asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  console.log(`[GENERATE-BILL] Request - Table ${tableNum}`);
  const session = await getActiveSession(tableNum);
  if (!session) {
    console.warn(`[GENERATE-BILL] No active session for table ${tableNum}`);
    return res.status(404).json({ error: 'No active session for this table' });
  }

  // One session = one unpaid bill. Re-generating refreshes it (idempotent).
  const existing = await getUnpaidBillForSession(session);
  if (existing) {
    console.log(`[GENERATE-BILL] Existing unpaid bill found: ${existing.bill_number} — returning as-is`);
    return res.json({ success: true, bill: existing, regenerated: false });
  }
  const result = await createUnpaidBillForSession(session, tableNum);
  if (result.error) {
    console.warn(`[GENERATE-BILL] Failed for table ${tableNum}: ${result.error}`);
    return res.status(400).json({ error: result.error });
  }
  console.log(`[GENERATE-BILL] Created bill ${result.bill.bill_number} for table ${tableNum}, session ${session.id}, total ₹${result.bill.total}`);
  broadcastSSE('bill_generated', { bill_number: result.bill.bill_number, table: tableNum, session_id: session.id, total: result.bill.total, payment_status: 'UNPAID' });
  res.json({ success: true, bill: result.bill, regenerated: false });
}));

// CUSTOMER version (no login — matches the no-login ordering flow).
// Returns ONLY the current bill/session info for one table.
app.get('/api/customer/tables/:number/current-bill', asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  if (!Number.isInteger(tableNum) || tableNum < 1 || tableNum > 20) {
    return res.status(400).json({ error: 'Please enter a table number between 1-20.' });
  }
  const session = await getActiveSession(tableNum);
  if (!session) return res.json({ session: null, bill: null, orders: [], total: 0, payment_status: null });
  const bill = await getUnpaidBillForSession(session);
  if (bill) return res.json({ session, bill, payment_status: 'UNPAID' });
  let orders = [];
  if (USE_DB) {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID')
      .order('timestamp', { ascending: true });
    orders = data || [];
  } else {
    orders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  }
  const total = orders.reduce((s, o) => s + Number(o.total), 0);
  res.json({ session, bill: null, orders, total, payment_status: null });
}));

// Get the current bill for a table (unpaid bill if generated, else live order list)
app.get('/api/tables/:number/current-bill', authMiddleware, asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  const session = await getActiveSession(tableNum);
  if (!session) return res.json({ session: null, bill: null, orders: [], total: 0, payment_status: null });

  const bill = await getUnpaidBillForSession(session);
  if (bill) {
    return res.json({ session, bill, payment_status: 'UNPAID' });
  }
  // No bill yet — expose the live completed-unpaid orders so the customer/admin
  // can still inspect what has been consumed so far.
  let orders = [];
  if (USE_DB) {
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID')
      .order('timestamp', { ascending: true });
    orders = data || [];
  } else {
    orders = db.orders.filter(o => o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID');
  }
  const total = orders.reduce((s, o) => s + Number(o.total), 0);
  res.json({ session, bill: null, orders, total, payment_status: null });
}));

// Record payment for a generated UNPAID bill (admin action — happens AFTER the
// bill exists and has been reviewed). Payment method IS required here.
app.post('/api/tables/:number/pay', authMiddleware, asyncWrap(async (req, res) => {
  const tableNum = Number(req.params.number);
  const { payment_method, cash_amount, online_amount } = req.body;

  console.log(`[PAYMENT] Request - Table ${tableNum}, method: ${payment_method}`);
  if (payment_method === 'SPLIT') {
    console.log(`[PAYMENT] Cash: ₹${cash_amount}, Online: ₹${online_amount}`);
  }

  if (!payment_method || !['CASH', 'ONLINE', 'SPLIT'].includes(payment_method)) {
    console.warn(`[PAYMENT] Invalid payment method: ${payment_method}`);
    return res.status(400).json({ error: 'Payment method must be CASH, ONLINE, or SPLIT' });
  }

  const session = await getActiveSession(tableNum);
  if (!session) {
    console.warn(`[PAYMENT] No active session for table ${tableNum}`);
    return res.status(404).json({ error: 'No active session for this table' });
  }

  // Payment applies to the session's generated UNPAID bill (bill BEFORE payment).
  const bill = await getUnpaidBillForSession(session);
  if (!bill) {
    console.warn(`[PAYMENT] No unpaid bill found for session ${session.id} (table ${tableNum}). Bill may not have been generated yet.`);
    return res.status(400).json({ error: 'No unpaid bill generated for this session. Generate the bill first.' });
  }
  console.log(`[PAYMENT] Found unpaid bill ${bill.bill_number} — total ₹${bill.total}, session ${session.id}`);

  const now = new Date();
  const istNow = getISTNow();
  const paymentIST = formatISTDateTime(istNow);

  // Server-side total calculation (authoritative)
  const totalAmount = Number(bill.total);
  if (!totalAmount || totalAmount <= 0) {
    return res.status(400).json({ error: 'Bill has no payable amount.' });
  }

  // Calculate cash/online split
  let cashAmt = 0;
  let onlineAmt = 0;
  if (payment_method === 'CASH') {
    cashAmt = totalAmount;
    onlineAmt = 0;
  } else if (payment_method === 'ONLINE') {
    cashAmt = 0;
    onlineAmt = totalAmount;
  } else {
    // SPLIT: validate cash + online = bill total (authoritative server-side check)
    const clientCash = Number(cash_amount) || 0;
    const clientOnline = Number(online_amount) || 0;
    if (clientCash < 0 || clientOnline < 0) {
      return res.status(400).json({ error: 'Cash and Online amounts cannot be negative.' });
    }
    const clientTotal = Math.round((clientCash + clientOnline) * 100) / 100;
    const serverTotal = Math.round(totalAmount * 100) / 100;
    if (clientTotal !== serverTotal) {
      return res.status(400).json({ error: 'Cash + Online amount must equal the total bill amount.' });
    }
    cashAmt = clientCash;
    onlineAmt = clientOnline;
  }

  // Idempotency: session already settled?
  if (session.status === 'SETTLED') {
    return res.status(400).json({ error: 'This session has already been paid and settled.' });
  }

  // 1. Mark the bill PAID with the real payment breakdown
  const paidBill = {
    ...bill,
    payment_status: 'PAID',
    payment_method: payment_method,
    cash_amount: cashAmt,
    online_amount: onlineAmt,
    total_paid: totalAmount,
    payment_date: paymentIST.date,
    payment_time: paymentIST.time12h + ' IST',
    paid_at: now.toISOString()
  };

  if (USE_DB) {
    // Mark all unpaid completed orders of this session as paid
    const { data: unpaidOrders } = await supabase
      .from('orders')
      .select('id')
      .eq('session_id', session.id)
      .eq('order_status', 'COMPLETED')
      .eq('payment_status', 'UNPAID');
    for (const o of (unpaidOrders || [])) {
      await supabase.from('orders').update({
        payment_status: 'PAID',
        payment_method: payment_method,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
        paid_at: now.toISOString()
      }).eq('id', o.id);
    }

    // Update the bill row (bill was created UNPAID by generate-bill)
    const billUpdate = {
      payment_status: 'PAID',
      payment_method: payment_method,
      cash_amount: cashAmt,
      online_amount: onlineAmt,
      payment_date: paymentIST.date,
      payment_time: paymentIST.time12h + ' IST',
      paid_at: now.toISOString()
    };
    let billUpdateErr;
    try {
      const r = await supabase.from('bills').update(billUpdate).eq('bill_number', bill.bill_number);
      billUpdateErr = r.error;
    } catch (e) { billUpdateErr = e; }
    if (billUpdateErr) {
      console.warn('[PAYMENT] Bill update error:', billUpdateErr.message, '— bill kept in memory with full breakdown.');
    }
    // Always keep the complete paid bill in memory (Supabase may lack columns).
    const memIdx = db.bills.findIndex(b => b.bill_number === bill.bill_number);
    if (memIdx !== -1) db.bills[memIdx] = paidBill; else db.bills.push(paidBill);

    // Create payment record (persisted where possible, always kept in memory)
    const payment = {
      id: 'PAY-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      session_id: session.id,
      bill_id: bill.bill_number,
      table: tableNum,
      amount: totalAmount,
      payment_method: payment_method,
      cash_amount: cashAmt,
      online_amount: onlineAmt,
      payment_status: 'PAID',
      paid_at: now.toISOString(),
      created_at: now.toISOString()
    };
    try {
      const payResult = await supabase.from('payments').insert(payment);
      if (payResult.error) {
        console.warn('[PAYMENT] Supabase payment insert error:', payResult.error.message, 'code:', payResult.error.code);
        const payColumnErr = payResult.error.message && payResult.error.message.includes('column');
        if (payColumnErr) {
          const fallbackPayment = { ...payment };
          delete fallbackPayment.bill_id;
          delete fallbackPayment.cash_amount;
          delete fallbackPayment.online_amount;
          const payRetry = await supabase.from('payments').insert(fallbackPayment);
          if (payRetry.error) console.warn('[PAYMENT] Fallback payment insert failed:', payRetry.error.message);
        }
      }
    } catch (e) {
      console.warn('[PAYMENT] Payment insert exception:', e.message);
    }
    db.payments.push(payment);

    // 2. Close the session → table becomes AVAILABLE for the next customer
    try {
      const closeResult = await supabase.from('table_sessions').update({
        status: 'SETTLED',
        settled_at: now.toISOString(),
        total_amount: totalAmount,
        payment_method: payment_method
      }).eq('id', session.id);
      if (closeResult.error && closeResult.error.message && closeResult.error.message.includes('check')) {
        await supabase.from('table_sessions').update({
          status: 'SETTLED',
          settled_at: now.toISOString(),
          total_amount: totalAmount
        }).eq('id', session.id);
      }
    } catch (e) { /* non-fatal */ }
    session.status = 'SETTLED';
    session.settled_at = now.toISOString();
    session.total_amount = totalAmount;
    session.payment_method = payment_method;
  } else {
    // In-memory fallback
    db.orders.forEach(o => {
      if (o.session_id === session.id && o.order_status === 'COMPLETED' && o.payment_status === 'UNPAID') {
        o.payment_status = 'PAID';
        o.payment_method = payment_method;
        o.cash_amount = cashAmt;
        o.online_amount = onlineAmt;
        o.paid_at = now.toISOString();
      }
    });
    const memIdx = db.bills.findIndex(b => b.bill_number === bill.bill_number);
    if (memIdx !== -1) db.bills[memIdx] = paidBill; else db.bills.push(paidBill);

    const payment = {
      id: 'PAY-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      session_id: session.id,
      bill_id: bill.bill_number,
      table: tableNum,
      amount: totalAmount,
      payment_method: payment_method,
      cash_amount: cashAmt,
      online_amount: onlineAmt,
      payment_status: 'PAID',
      paid_at: now.toISOString(),
      created_at: now.toISOString()
    };
    db.payments.push(payment);

    session.status = 'SETTLED';
    session.settled_at = now.toISOString();
    session.total_amount = totalAmount;
    session.payment_method = payment_method;
  }

  console.log(`[PAYMENT RECORDED] Bill ${bill.bill_number} — Table ${tableNum} — ₹${totalAmount} — ${payment_method}`);
  console.log(`[SESSION CLOSED] ${session.id} — Table ${tableNum} AVAILABLE`);
  broadcastSSE('table_paid', { table: tableNum, session_id: session.id, bill_number: bill.bill_number, amount: totalAmount, payment_method, cash_amount: cashAmt, online_amount: onlineAmt });
  res.json({ success: true, payment: db.payments[db.payments.length - 1], session, bill: paidBill });
}));

// Get all bills (admin)
app.get('/api/bills', authMiddleware, asyncWrap(async (req, res) => {
  if (USE_DB) {
    try {
      const { data: bills, error } = await supabase
        .from('bills')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        console.warn('[BILLS] Supabase query failed:', error.message);
        // Merge Supabase bills with in-memory bills (prefer in-memory on duplicate bill_number)
        const memIds = new Set(db.bills.map(b => b.bill_number));
        const merged = [...db.bills, ...(bills || []).filter(sb => !memIds.has(sb.bill_number))];
        merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return res.json(merged);
      }
      // Also include any in-memory bills not yet in Supabase.
      // If a bill_number exists in BOTH, prefer the in-memory version — it carries the
      // complete cash_amount/online_amount breakdown even when Supabase lacks the columns.
      // Also: a PAID in-memory bill must shadow a stale UNPAID Supabase row
      // (happens when the Supabase update itself failed on missing columns).
      const supaBillIds = new Set((bills || []).map(b => b.bill_number));
      const memOnly = db.bills.filter(b => !supaBillIds.has(b.bill_number));
      const shadowed = db.bills.filter(b => supaBillIds.has(b.bill_number));
      const shadowedNums = new Set(shadowed.map(b => b.bill_number));
      const deduped = [...shadowed, ...(bills || []).filter(sb => !shadowedNums.has(sb.bill_number)), ...memOnly];
      deduped.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return res.json(deduped);
    } catch(e) {
      console.warn('[BILLS] Supabase error:', e.message);
      return res.json(db.bills.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    }
  }
  res.json(db.bills.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
}));

// Get bill by bill number
app.get('/api/bills/:billNumber', authMiddleware, asyncWrap(async (req, res) => {
  const billNumber = req.params.billNumber;

  // In-memory bills are preferred: they are the complete record (including the
  // real cash_amount/online_amount breakdown) even when Supabase is missing the
  // split columns or rejected the insert. They shadow any incomplete Supabase row.
  const memBill = db.bills.find(b => b.bill_number === billNumber);
  if (memBill) return res.json(memBill);

  if (USE_DB) {
    try {
      const { data: bill, error } = await supabase
        .from('bills')
        .select('*')
        .eq('bill_number', billNumber)
        .single();
      if (error || !bill) {
        return res.status(404).json({ error: 'Bill not found' });
      }
      return res.json(bill);
    } catch(e) {
      return res.status(404).json({ error: 'Bill not found' });
    }
  }
  return res.status(404).json({ error: 'Bill not found' });
}));

// Delete bill permanently
app.delete('/api/bills/:billNumber', authMiddleware, asyncWrap(async (req, res) => {
  const billNumber = req.params.billNumber;
  if (USE_DB) {
    // Try to find and delete from Supabase
    try {
      const { data: bill, error: findError } = await supabase
        .from('bills')
        .select('id, bill_number')
        .eq('bill_number', billNumber)
        .maybeSingle();

      if (!findError && bill) {
        const { error: deleteError } = await supabase
          .from('bills')
          .delete()
          .eq('bill_number', billNumber);

        if (deleteError) {
          console.error('[BILLS] Supabase delete error:', deleteError.message);
          return res.status(500).json({ error: 'Failed to delete bill' });
        }
        console.log(`[BILL DELETED] ${billNumber}`);
        return res.json({ success: true });
      }
    } catch(e) {
      // Supabase table may not exist — fall through to in-memory
    }
  }

  // Fallback: in-memory
  const idx = db.bills.findIndex(b => b.bill_number === billNumber);
  if (idx !== -1) {
    db.bills.splice(idx, 1);
    console.log(`[BILL DELETED] ${billNumber}`);
    return res.json({ success: true });
  }

  return res.status(404).json({ error: 'Bill not found' });
}));


// Helper: convert UTC timestamp to IST date string (YYYY-MM-DD)
function utcToISTDateStr(utcTimestamp) {
  if (!utcTimestamp) return null;
  const d = new Date(utcTimestamp);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  const dd = String(ist.getDate()).padStart(2, '0');
  const mm = String(ist.getMonth() + 1).padStart(2, '0');
  const yyyy = ist.getFullYear();
  return yyyy + '-' + mm + '-' + dd;
}

// ===========================
// PAYMENTS / EARNINGS
// Uses bills as the authoritative source for payment-date-based earnings.
// A bill's payment_date is the IST date when payment was completed.
// ===========================
app.get('/api/earnings', authMiddleware, asyncWrap(async (req, res) => {
  const { date } = req.query;
  const targetDate = date || getISTDateStr();

  console.log(`[EARNINGS] Request for date: ${targetDate}`);

  if (USE_DB) {
    // Use bills as the source of truth — bills have payment_date in IST
    // Merge Supabase + in-memory (bills that failed Supabase insert go to memory)
    let supaDayBills = [];
    try {
      const billsResult = await supabase
        .from('bills')
        .select('*')
        .eq('payment_date', targetDate);
      if (billsResult.error) {
        console.warn('[EARNINGS] Bills query error:', billsResult.message || billsResult.error.message);
      } else {
        supaDayBills = billsResult.data || [];
      }
    } catch(e) {
      console.warn('[EARNINGS] Bills query exception:', e.message);
    }
    const memDayBills = db.bills.filter(b => b.payment_date === targetDate);
    const memBillIds = new Set(memDayBills.map(b => b.bill_number));
    // Only PAID bills count as revenue — UNPAID bills are not yet earnings.
    const bills = [...supaDayBills.filter(b => !memBillIds.has(b.bill_number)), ...memDayBills].filter(b => (b.payment_status || 'PAID') === 'PAID');

    if (bills.length === 0 && supaDayBills.length === 0 && memDayBills.length === 0) {
      console.log('[EARNINGS] No bills found (Supabase: 0, In-memory: 0)');
    } else {
      console.log(`[EARNINGS] Bills: Supabase=${supaDayBills.length}, InMemory=${memDayBills.length}, Merged=${bills.length}`);
    }
    console.log(`[EARNINGS] Found ${bills.length} bills for ${targetDate}`);

    const totalEarnings = bills.reduce((s, b) => s + Number(b.total || 0), 0);
    let cashTotal = 0;
    let onlineTotal = 0;
    for (const b of bills) {
      if (b.payment_method === 'CASH') {
        cashTotal += Number(b.total || 0);
      } else if (b.payment_method === 'ONLINE') {
        onlineTotal += Number(b.total || 0);
      } else if (b.payment_method === 'SPLIT') {
        cashTotal += Number(b.cash_amount || 0);
        onlineTotal += Number(b.online_amount || 0);
      }
    }

    const { data: expenses } = await supabase.from('expenses').select('amount').eq('date', targetDate);
    const todayExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount), 0);

    console.log(`[EARNINGS] Total: ₹${totalEarnings}, Cash: ₹${cashTotal}, Online: ₹${onlineTotal}`);

    return res.json({
      date: targetDate,
      totalEarnings,
      cashTotal,
      onlineTotal,
      totalExpenses: todayExpenses,
      netProfit: totalEarnings - todayExpenses,
      paidOrderCount: bills.reduce((sum, b) => sum + (b.orders ? b.orders.length : 0), 0),
      cashCount: bills.filter(b => b.payment_method === 'CASH').length,
      onlineCount: bills.filter(b => b.payment_method === 'ONLINE').length
    });
  }

  // In-memory fallback: use bills (PAID only — unpaid bills are not revenue)
  const dayBills = db.bills.filter(b => b.payment_date === targetDate && (b.payment_status || 'PAID') === 'PAID');
  const totalEarnings = dayBills.reduce((s, b) => s + Number(b.total || 0), 0);
  let cashTotal = 0;
  let onlineTotal = 0;
  for (const b of dayBills) {
    if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
    else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
    else if (b.payment_method === 'SPLIT') {
      cashTotal += Number(b.cash_amount || 0);
      onlineTotal += Number(b.online_amount || 0);
    }
  }
  const todayExpenses = db.expenses.filter(e => e.date === targetDate).reduce((s, e) => s + e.amount, 0);

  console.log(`[EARNINGS] Total: ₹${totalEarnings}, Cash: ₹${cashTotal}, Online: ₹${onlineTotal}`);

  res.json({
    date: targetDate,
    totalEarnings,
    cashTotal,
    onlineTotal,
    totalExpenses: todayExpenses,
    netProfit: totalEarnings - todayExpenses,
    paidOrderCount: dayBills.reduce((sum, b) => sum + (b.orders ? b.orders.length : 0), 0),
    cashCount: dayBills.filter(b => b.payment_method === 'CASH').length,
    onlineCount: dayBills.filter(b => b.payment_method === 'ONLINE').length
  });
}
));

// Fallback: earnings from orders (used when bills query fails)
async function earningsFallbackFromOrders(targetDate, res) {
  console.log('[EARNINGS] Falling back to orders-based calculation');
  if (USE_DB) {
    // Use paid_at timestamp converted to IST date instead of order.date
    const { data: allPaidOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('payment_status', 'PAID');
    const orders = (allPaidOrders || []).filter(o => {
      const istDate = utcToISTDateStr(o.paid_at);
      return istDate === targetDate;
    });
    const totalEarnings = orders.reduce((s, o) => s + Number(o.total), 0);
    let cashTotal = 0;
    let onlineTotal = 0;
    for (const o of orders) {
      if (o.payment_method === 'CASH') cashTotal += Number(o.total);
      else if (o.payment_method === 'ONLINE') onlineTotal += Number(o.total);
      else if (o.payment_method === 'SPLIT') { cashTotal += Number(o.cash_amount || 0); onlineTotal += Number(o.online_amount || 0); }
    }
    const { data: expenses } = await supabase.from('expenses').select('amount').eq('date', targetDate);
    const todayExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount), 0);
    return res.json({
      date: targetDate, totalEarnings, cashTotal, onlineTotal,
      totalExpenses: todayExpenses, netProfit: totalEarnings - todayExpenses,
      paidOrderCount: orders.length, cashCount: orders.filter(o => o.payment_method === 'CASH').length,
      onlineCount: orders.filter(o => o.payment_method === 'ONLINE').length
    });
  }
  res.json({ date: targetDate, totalEarnings: 0, cashTotal: 0, onlineTotal: 0, totalExpenses: 0, netProfit: 0, paidOrderCount: 0, cashCount: 0, onlineCount: 0 });
}

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
// Uses bills as authoritative source for payment-date-based earnings.
// Orders are used for order-count metrics (by order creation date).
// ===========================
app.get('/api/reports', authMiddleware, asyncWrap(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'From and to dates required' });

  console.log(`[REPORTS] Request for range: ${from} to ${to}`);

  if (USE_DB) {
    // Orders for order-count metrics (by order creation date)
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

    // Bills for earnings (by payment_date)
    let supaBills = [];
    try {
      const billsResult = await supabase
        .from('bills')
        .select('*')
        .gte('payment_date', from)
        .lte('payment_date', to);
      if (billsResult.error) {
        console.warn('[REPORTS] Bills query error:', billsResult.error.message);
      } else {
        supaBills = billsResult.data || [];
      }
    } catch(billsErr) {
      console.warn('[REPORTS] Bills query exception:', billsErr.message);
    }

    // Merge with in-memory bills (bills that failed Supabase insert). Only PAID
    // bills count as revenue — UNPAID bills are not yet earnings.
    const memBills = db.bills.filter(b => b.payment_date >= from && b.payment_date <= to && (b.payment_status || 'PAID') === 'PAID');
    const memBillIds = new Set(memBills.map(b => b.bill_number));
    // Add Supabase bills not already in memory, then add all memory bills
    const supaOnlyBills = supaBills.filter(b => !memBillIds.has(b.bill_number));
    const allBills = [...supaOnlyBills, ...memBills];

    const allOrders = orders || [];
    const allExpenses = expenses || [];

    const totalOrders = allOrders.length;
    const completedOrders = allOrders.filter(o => o.order_status === 'COMPLETED').length;
    const cancelledOrders = allOrders.filter(o => o.order_status === 'CANCELLED').length;
    const pendingOrders = allOrders.filter(o => o.order_status === 'PENDING').length;

    // Earnings from bills (authoritative payment-date-based)
    const totalEarnings = allBills.reduce((sum, b) => sum + Number(b.total || 0), 0);
    let cashTotal = 0, onlineTotal = 0;
    for (const b of allBills) {
      if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
      else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
      else if (b.payment_method === 'SPLIT') {
        cashTotal += Number(b.cash_amount || 0);
        onlineTotal += Number(b.online_amount || 0);
      }
    }

    const totalExpenses = allExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const profit = totalEarnings - totalExpenses;

    const expBreakdown = {};
    allExpenses.forEach(e => { expBreakdown[e.name] = (expBreakdown[e.name] || 0) + Number(e.amount); });

    allOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    allExpenses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    console.log(`[REPORTS] Bills: Supabase=${supaBills.length}, InMemory=${memBills.length}, Merged=${allBills.length}, Earnings: ₹${totalEarnings}, Cash: ₹${cashTotal}, Online: ₹${onlineTotal}`);

    return res.json({
      from, to, totalOrders, completedOrders, cancelledOrders, pendingOrders,
      totalEarnings, cashTotal, onlineTotal, totalExpenses, netProfit: profit,
      expenseBreakdown: expBreakdown, orders: allOrders, expenses: allExpenses
    });
  }

  // In-memory fallback: use bills for earnings (PAID only — unpaid ≠ revenue)
  const allBills = db.bills.filter(b => b.payment_date >= from && b.payment_date <= to && (b.payment_status || 'PAID') === 'PAID');
  const totalEarnings = allBills.reduce((sum, b) => sum + Number(b.total || 0), 0);
  let cashTotal = 0, onlineTotal = 0;
  for (const b of allBills) {
    if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
    else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
    else if (b.payment_method === 'SPLIT') {
      cashTotal += Number(b.cash_amount || 0);
      onlineTotal += Number(b.online_amount || 0);
    }
  }

  const orders = db.orders.filter(o => o.date >= from && o.date <= to);
  const expenses = db.expenses.filter(e => e.date >= from && e.date <= to);
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
  const today = getISTDateStr();

  if (USE_DB) {
    const { data: todayOrders } = await supabase.from('orders').select('*').eq('date', today);
    const { data: allPending } = await supabase.from('orders').select('*').eq('order_status', 'PENDING');
    const { data: todayExpenses } = await supabase.from('expenses').select('amount').eq('date', today);
    const { data: activeSessions } = await supabase.from('table_sessions').select('table').eq('status', 'ACTIVE');

    const tOrders = todayOrders || [];
    const tExpenses = todayExpenses || [];

    // Dashboard TODAY'S ORDERS = distinct customer/table sessions started today
    const todaySessionIds = new Set(tOrders.map(o => o.session_id).filter(Boolean));
    const todaySessionsCount = todaySessionIds.size;

    // Earnings from bills (authoritative payment-date-based) — merge Supabase + in-memory
    let dashBills = [];
    try {
      const dashBillsResult = await supabase
        .from('bills')
        .select('*')
        .eq('payment_date', today);
      if (!dashBillsResult.error) dashBills = dashBillsResult.data || [];
    } catch(e) { /* continue */ }
    const dashMemBills = db.bills.filter(b => b.payment_date === today && (b.payment_status || 'PAID') === 'PAID');
    const dashMemIds = new Set(dashMemBills.map(b => b.bill_number));
    // Only PAID bills count as revenue — UNPAID bills are not yet earnings.
    const bills = [...dashBills.filter(b => !dashMemIds.has(b.bill_number)), ...dashMemBills].filter(b => (b.payment_status || 'PAID') === 'PAID');
    const earnings = bills.reduce((s, b) => s + Number(b.total || 0), 0);
    let cashTotal = 0, onlineTotal = 0;
    for (const b of bills) {
      if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
      else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
      else if (b.payment_method === 'SPLIT') {
        cashTotal += Number(b.cash_amount || 0);
        onlineTotal += Number(b.online_amount || 0);
      }
    }    const expenses = tExpenses.reduce((s, e) => s + Number(e.amount), 0);

    console.log(`[DASHBOARD] Bills: Supabase=${dashBills.length}, InMemory=${dashMemBills.length}, Merged=${bills.length}, Earnings: ₹${earnings}`);

    const pending = (allPending || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10);


    return res.json({
      todayOrdersCount: todaySessionsCount,
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

  // Fallback: use bills for earnings (payment-date-based)
  const allOrders = db.orders;
  const todayOrders = allOrders.filter(o => o.date === today);
  const pending = allOrders.filter(o => o.order_status === 'PENDING');
  const todayBills = db.bills.filter(b => b.payment_date === today && (b.payment_status || 'PAID') === 'PAID');
  const earnings = todayBills.reduce((s, b) => s + Number(b.total || 0), 0);
  let cashTotal = 0, onlineTotal = 0;
  for (const b of todayBills) {
    if (b.payment_method === 'CASH') cashTotal += Number(b.total || 0);
    else if (b.payment_method === 'ONLINE') onlineTotal += Number(b.total || 0);
    else if (b.payment_method === 'SPLIT') {
      cashTotal += Number(b.cash_amount || 0);
      onlineTotal += Number(b.online_amount || 0);
    }
  }
  const todayExpenses = db.expenses.filter(e => e.date === today).reduce((s, e) => s + e.amount, 0);

  // Dashboard TODAY'S ORDERS = distinct customer/table sessions started today
  const todaySessionIds = new Set(todayOrders.map(o => o.session_id).filter(Boolean));
  const todaySessionsCount = todaySessionIds.size;

  res.json({
    todayOrdersCount: todaySessionsCount,
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
// HEALTH CHECK (lightweight — no database writes)
// ===========================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// TEMPORARY E2E SINK — receives test results from the #e2e harness (local only).
let __e2eResults = null;
app.post('/__e2e_results', express.json(), (req, res) => {
  __e2eResults = req.body || {};
  console.log('[E2E] results received, failures:', __e2eResults.failures);
  res.json({ ok: true });
});
app.get('/__e2e_results', (req, res) => {
  res.json(__e2eResults || { pending: true });
});

// ===========================
// STATIC JS FILES — served for customer/admin scripts
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
// SESSION HISTORY — group orders by session for Order History UI
// ===========================
app.get('/api/sessions/history', authMiddleware, asyncWrap(async (req, res) => {
  const { date, status } = req.query;

  console.log(`[SESSION HISTORY] Request - date: ${date || 'none'}, status: ${status || 'ALL'}`);

  if (USE_DB) {
    // Get all sessions with high limit to avoid Supabase default 1000 row cap
    let sessionQuery = supabase.from('table_sessions').select('*').limit(5000);
    if (status && status !== 'ALL') {
      sessionQuery = sessionQuery.eq('status', status);
    }
    sessionQuery = sessionQuery.order('created_at', { ascending: false });
    const { data: sessions, error: sErr } = await sessionQuery;
    if (sErr) {
      console.error('[SESSION HISTORY] Supabase sessions query error:', sErr.message, 'code:', sErr.code);
      return res.json([]); // Return empty array, not error
    }

    const allSessions = sessions || [];

    // If date filter is provided, get sessions that have orders on that date
    let filteredSessionIds = null;
    if (date) {
      const { data: dateOrders } = await supabase
        .from('orders')
        .select('session_id')
        .eq('date', date);
      filteredSessionIds = new Set((dateOrders || []).map(o => o.session_id).filter(Boolean));
    }

    // Get orders for all sessions (batch in chunks to avoid Supabase limits)
    const sessionIds = allSessions.map(s => s.id);
    let allOrders = [];
    if (sessionIds.length > 0) {
      // Batch in chunks of 100 to avoid URL length limits
      const chunkSize = 100;
      for (let i = 0; i < sessionIds.length; i += chunkSize) {
        const chunk = sessionIds.slice(i, i + chunkSize);
        const { data: chunkOrders, error: ordersErr } = await supabase
          .from('orders')
          .select('*')
          .in('session_id', chunk)
          .order('timestamp', { ascending: true })
          .limit(5000);
        if (ordersErr) {
          console.error('[SESSION HISTORY] Orders query error for chunk:', ordersErr.message);
          continue; // Skip this chunk, try others
        }
        allOrders = allOrders.concat(chunkOrders || []);
      }
    }
    console.log(`[SESSION HISTORY] Found ${allSessions.length} sessions, ${allOrders.length} orders`);
    // Diagnostic: log session IDs and their order counts
    allSessions.forEach(s => {
      const matchCount = allOrders.filter(o => o.session_id === s.id).length;
      console.log(`[SESSION HISTORY] Session ${s.id} (table ${s.table}, status=${s.status}) → ${matchCount} orders`);
    });
    // Diagnostic: log distinct session_ids found in orders
    const distinctOrderSessionIds = [...new Set(allOrders.map(o => o.session_id).filter(Boolean))];
    console.log(`[SESSION HISTORY] Distinct order session_ids: ${JSON.stringify(distinctOrderSessionIds)}`);

    // Group orders by session
    const sessionOrdersMap = new Map();
    for (const o of allOrders) {
      if (!sessionOrdersMap.has(o.session_id)) sessionOrdersMap.set(o.session_id, []);
      sessionOrdersMap.get(o.session_id).push(o);
    }

    // Merge extra metadata
    for (const [sid, orders] of sessionOrdersMap) {
      sessionOrdersMap.set(sid, orders.map(o => {
        const meta = orderMeta.get(o.id);
        return meta ? { ...o, ...meta } : o;
      }));
    }

    // Fetch bills for settled sessions in bulk
    const settledSessionIds = allSessions.filter(s => s.status === 'SETTLED').map(s => s.id);
    const billMap = new Map();
    // In-memory bills always win — they carry the complete payment breakdown
    // even when Supabase lacks the split columns.
    db.bills.forEach(b => { if (settledSessionIds.includes(b.session_id)) billMap.set(b.session_id, b); });
    if (settledSessionIds.length > 0 && USE_DB) {
      const { data: bills } = await supabase.from('bills').select('*').in('session_id', settledSessionIds);
      (bills || []).forEach(b => { if (!billMap.has(b.session_id)) billMap.set(b.session_id, b); });
    }

    // Fallback: for sessions with 0 orders, try to find orders by table+time window
    // This handles legacy data where orders may have wrong session_ids
    const emptySessions = allSessions.filter(s => !(sessionOrdersMap.get(s.id) && sessionOrdersMap.get(s.id).length > 0));
    if (emptySessions.length > 0 && USE_DB) {
      console.log(`[SESSION HISTORY] ${emptySessions.length} sessions have 0 orders, trying table+time fallback`);
      for (const s of emptySessions) {
        const sessionTime = new Date(s.created_at);
        const windowStart = new Date(sessionTime.getTime() - 2 * 60 * 60 * 1000).toISOString();
        const windowEnd = s.settled_at
          ? new Date(new Date(s.settled_at).getTime() + 2 * 60 * 60 * 1000).toISOString()
          : new Date().toISOString();
        const { data: fallbackOrders } = await supabase
          .from('orders')
          .select('*')
          .eq('"table"', s.table)
          .gte('timestamp', windowStart)
          .lte('timestamp', windowEnd)
          .order('timestamp', { ascending: true })
          .limit(500);
        if (fallbackOrders && fallbackOrders.length > 0) {
          console.log(`[SESSION HISTORY] Fallback found ${fallbackOrders.length} orders for session ${s.id} (table ${s.table})`);
          sessionOrdersMap.set(s.id, fallbackOrders.map(o => {
            const meta = orderMeta.get(o.id);
            return meta ? { ...o, ...meta } : o;
          }));
        }
      }
    }

    // Build response
    let result = allSessions
      .filter(s => !filteredSessionIds || filteredSessionIds.has(s.id))
      .map(s => {
        const orders = sessionOrdersMap.get(s.id) || [];
        const nonCancelled = orders.filter(o => o.order_status !== 'CANCELLED');
        const completed = orders.filter(o => o.order_status === 'COMPLETED');
        const cancelled = orders.filter(o => o.order_status === 'CANCELLED');
        const pending = orders.filter(o => o.order_status === 'PENDING');
        const totalAll = orders.reduce((sum, o) => sum + Number(o.total), 0);
        const totalNonCancelled = nonCancelled.reduce((sum, o) => sum + Number(o.total), 0);

        // Determine session display status
        let displayStatus = s.status;
        if (s.status === 'SETTLED') {
          displayStatus = 'SETTLED';
        } else if (orders.length === 0) {
          displayStatus = 'EMPTY';
        } else if (nonCancelled.length === 0) {
          displayStatus = 'ALL_CANCELLED';
        }

        // Get bill info from pre-fetched map
        const billInfo = billMap.get(s.id) || null;

        return {
          session_id: s.id,
          table: s.table,
          status: displayStatus,
          original_status: s.status,
          created_at: s.created_at,
          settled_at: s.settled_at,
          total_amount: s.total_amount,
          payment_method: s.payment_method,
          order_count: orders.length,
          total: totalNonCancelled,
          total_with_cancelled: totalAll,
          completed_count: completed.length,
          cancelled_count: cancelled.length,
          pending_count: pending.length,
          orders: orders,
          bill: billInfo
        };
      });

    // Sort by created_at descending
    result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    console.log(`[SESSION HISTORY] Returning ${result.length} sessions`);
    return res.json(result);
  }

  // Fallback: in-memory
  let sessions = [...db.table_sessions];
  if (status && status !== 'ALL') {
    sessions = sessions.filter(s => s.status === status);
  }

  let filteredSessionIds = null;
  if (date) {
    const dateOrderSessionIds = new Set(
      db.orders.filter(o => o.date === date).map(o => o.session_id).filter(Boolean)
    );
    filteredSessionIds = dateOrderSessionIds;
  }

  const result = sessions
    .filter(s => !filteredSessionIds || filteredSessionIds.has(s.id))
    .map(s => {
      const orders = db.orders.filter(o => o.session_id === s.id);
      const nonCancelled = orders.filter(o => o.order_status !== 'CANCELLED');
      const completed = orders.filter(o => o.order_status === 'COMPLETED');
      const cancelled = orders.filter(o => o.order_status === 'CANCELLED');
      const pending = orders.filter(o => o.order_status === 'PENDING');
      const totalAll = orders.reduce((sum, o) => sum + o.total, 0);
      const totalNonCancelled = nonCancelled.reduce((sum, o) => sum + o.total, 0);

      let displayStatus = s.status;
      if (s.status === 'SETTLED') displayStatus = 'SETTLED';
      else if (orders.length === 0) displayStatus = 'EMPTY';
      else if (nonCancelled.length === 0) displayStatus = 'ALL_CANCELLED';

      let billInfo = null;
      if (s.status === 'SETTLED') {
        billInfo = db.bills.find(b => b.session_id === s.id) || null;
      }

      return {
        session_id: s.id,
        table: s.table,
        status: displayStatus,
        original_status: s.status,
        created_at: s.created_at,
        settled_at: s.settled_at,
        total_amount: s.total_amount,
        payment_method: s.payment_method,
        order_count: orders.length,
        total: totalNonCancelled,
        total_with_cancelled: totalAll,
        completed_count: completed.length,
        cancelled_count: cancelled.length,
        pending_count: pending.length,
        orders: orders.map(o => {
          const meta = orderMeta.get(o.id);
          return meta ? { ...o, ...meta } : o;
        }),
        bill: billInfo
      };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(result);
}));

// ===========================
// SESSION DETAIL — full timeline for a specific session
// ===========================
app.get('/api/sessions/:sessionId', authMiddleware, asyncWrap(async (req, res) => {
  const sessionId = req.params.sessionId;    console.log(`[SESSION DETAIL] Request for session: ${sessionId}`);

  if (USE_DB) {
    const { data: session, error: sErr } = await supabase.from('table_sessions').select('*').eq('id', sessionId).single();
    console.log(`[SESSION DETAIL] Session query result: ${session ? 'found ' + session.id : 'null'}, error: ${sErr ? sErr.message : 'none'}`);
    if (sErr) {
      console.error('[SESSION DETAIL] Session query error:', sErr.message);
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { data: orders, error: oErr } = await supabase
      .from('orders')
      .select('*')
      .eq('session_id', sessionId)
      .order('timestamp', { ascending: true })
      .limit(500);
    if (oErr) console.error('[SESSION DETAIL] Orders query error:', oErr.message);
    console.log(`[SESSION DETAIL] Orders for session ${sessionId}: ${(orders || []).length} found`);
    (orders || []).forEach(o => console.log(`[SESSION DETAIL]   Order ${o.id} session_id=${o.session_id} status=${o.order_status} \u20B9${o.total}`));

    // Fallback: if 0 orders found by session_id, search by table + time window
    // This handles legacy data where orders may have wrong session_ids
    let finalOrders = orders || [];
    if (finalOrders.length === 0 && session && session.table) {
      console.log(`[SESSION DETAIL] No orders by session_id, trying table+time fallback for table ${session.table}`);
      const sessionTime = new Date(session.created_at);
      const windowStart = new Date(sessionTime.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h before
      const windowEnd = session.settled_at
        ? new Date(new Date(session.settled_at).getTime() + 2 * 60 * 60 * 1000).toISOString() // 2h after settle
        : new Date().toISOString();
      const { data: tableOrders } = await supabase
        .from('orders')
        .select('*')
        .eq('"table"', session.table)
        .gte('timestamp', windowStart)
        .lte('timestamp', windowEnd)
        .order('timestamp', { ascending: true })
        .limit(500);
      if (tableOrders && tableOrders.length > 0) {
        console.log(`[SESSION DETAIL] Fallback found ${tableOrders.length} orders by table+time`);
        finalOrders = tableOrders;
      }
    }

    let billInfo = null;
    if (session.status === 'SETTLED') {
      // Prefer the in-memory bill (complete record) over a possibly-stale Supabase row.
      const memBill = db.bills.find(b => b.session_id === sessionId);
      if (memBill) {
        billInfo = memBill;
      } else {
        const { data: bill } = await supabase.from('bills').select('*').eq('session_id', sessionId).maybeSingle();
        billInfo = bill;
      }
    }

    const enrichedOrders = finalOrders.map(o => {
      const meta = orderMeta.get(o.id);
      return meta ? { ...o, ...meta } : o;
    });
    console.log(`[SESSION DETAIL] Returning ${enrichedOrders.length} orders for session ${sessionId}`);

    return res.json({
      session,
      orders: enrichedOrders,
      bill: billInfo
    });
  }

  // Fallback: in-memory
  const session = db.table_sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const orders = db.orders
    .filter(o => o.session_id === sessionId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map(o => {
      const meta = orderMeta.get(o.id);
      return meta ? { ...o, ...meta } : o;
    });

  let billInfo = null;
  if (session.status === 'SETTLED') {
    billInfo = db.bills.find(b => b.session_id === sessionId) || null;
  }

  res.json({ session, orders, bill: billInfo });
}));

// ===========================
// DELETE SESSION — permanently remove all orders/bills/payments for a session
// ===========================
app.delete('/api/sessions/:sessionId', authMiddleware, asyncWrap(async (req, res) => {
  const sessionId = req.params.sessionId;
  console.log(`[SESSION DELETE] Request to delete session: ${sessionId}`);

  if (USE_DB) {
    // Verify session exists
    const { data: session, error: sErr } = await supabase
      .from('table_sessions').select('*').eq('id', sessionId).single();
    if (sErr || !session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 1. Delete orders for this session
    const { error: delOrdersErr } = await supabase
      .from('orders').delete().eq('session_id', sessionId);
    if (delOrdersErr) {
      console.error('[SESSION DELETE] Failed to delete orders:', delOrdersErr.message);
      return res.status(500).json({ error: 'Failed to delete orders: ' + delOrdersErr.message });
    }
    console.log(`[SESSION DELETE] Deleted orders for session ${sessionId}`);

    // 2. Delete bills for this session
    const { error: delBillsErr } = await supabase
      .from('bills').delete().eq('session_id', sessionId);
    if (delBillsErr) {
      console.error('[SESSION DELETE] Failed to delete bills:', delBillsErr.message);
    } else {
      console.log(`[SESSION DELETE] Deleted bills for session ${sessionId}`);
    }

    // 3. Delete payments for this session
    const { error: delPayErr } = await supabase
      .from('payments').delete().eq('session_id', sessionId);
    if (delPayErr) {
      console.error('[SESSION DELETE] Failed to delete payments:', delPayErr.message);
    } else {
      console.log(`[SESSION DELETE] Deleted payments for session ${sessionId}`);
    }

    // 4. Delete the session itself
    const { error: delSessionErr } = await supabase
      .from('table_sessions').delete().eq('id', sessionId);
    if (delSessionErr) {
      console.error('[SESSION DELETE] Failed to delete session:', delSessionErr.message);
      return res.status(500).json({ error: 'Failed to delete session: ' + delSessionErr.message });
    }
    console.log(`[SESSION DELETE] Deleted session ${sessionId} (table ${session.table})`);

    broadcastSSE('session_deleted', { session_id: sessionId, table: session.table });
    return res.json({ success: true });
  }

  // In-memory fallback
  const idx = db.table_sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return res.status(404).json({ error: 'Session not found' });
  const session = db.table_sessions[idx];

  // Delete orders, bills, payments for this session
  db.orders = db.orders.filter(o => o.session_id !== sessionId);
  db.bills = db.bills.filter(b => b.session_id !== sessionId);
  db.payments = db.payments.filter(p => p.session_id !== sessionId);
  db.table_sessions.splice(idx, 1);

  console.log(`[SESSION DELETE] Deleted session ${sessionId} (table ${session.table})`);
  broadcastSSE('session_deleted', { session_id: sessionId, table: session.table });
  res.json({ success: true });
}));

// ===========================
// CATCH-ALL — serve index.html for SPA routes
// ===========================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Export for potential use as middleware
module.exports = app;

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍕 THE OREGANO CAFE — Server running on http://0.0.0.0:${PORT}`);
  console.log(`📋 Customer: http://0.0.0.0:${PORT}`);
  console.log(`🔒 Admin: http://0.0.0.0:${PORT}#admin`);
  console.log(`📊 API Health: http://0.0.0.0:${PORT}/health`);
  console.log(`💾 Database: ${USE_DB ? 'Supabase (PostgreSQL)' : 'In-Memory (local dev)'}\n`);
});
