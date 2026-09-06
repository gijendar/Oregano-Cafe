-- ============================================
-- THE OREGANO CAFE — Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- ADMINS table
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default admin
INSERT INTO admins (username, password, name)
VALUES ('admin', 'admin123', 'Admin')
ON CONFLICT (username) DO NOTHING;

-- TABLE SESSIONS table
CREATE TABLE IF NOT EXISTS table_sessions (
  id TEXT PRIMARY KEY,
  "table" INTEGER NOT NULL,
  status TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SETTLED')),
  total_amount NUMERIC DEFAULT 0,
  payment_method TEXT CHECK (payment_method IN ('CASH', 'ONLINE') OR payment_method IS NULL),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_table_status ON table_sessions("table", status);

-- ORDERS table
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  "table" INTEGER NOT NULL,
  session_id TEXT REFERENCES table_sessions(id),
  items JSONB NOT NULL DEFAULT '[]',
  total NUMERIC NOT NULL DEFAULT 0,
  order_status TEXT DEFAULT 'PENDING' CHECK (order_status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  payment_status TEXT DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PAID', 'NOT_APPLICABLE')),
  payment_method TEXT CHECK (payment_method IN ('CASH', 'ONLINE') OR payment_method IS NULL),
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE INDEX idx_orders_session ON orders(session_id);
CREATE INDEX idx_orders_status ON orders(order_status);
CREATE INDEX idx_orders_date ON orders(date);
CREATE INDEX idx_orders_table ON orders("table");
CREATE INDEX idx_orders_payment ON orders(payment_status, payment_method);

-- EXPENSES table
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  note TEXT DEFAULT '',
  date TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_expenses_date ON expenses(date);

-- PAYMENTS table
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES table_sessions(id),
  "table" INTEGER NOT NULL,
  amount NUMERIC NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'ONLINE')),
  payment_status TEXT DEFAULT 'PAID',
  paid_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_session ON payments(session_id);

-- ORDER TYPE and DELIVERY columns (for Dine In / Takeaway / Delivery + region)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'dine-in' CHECK (order_type IN ('dine-in', 'takeaway', 'delivery'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery JSONB DEFAULT NULL;
