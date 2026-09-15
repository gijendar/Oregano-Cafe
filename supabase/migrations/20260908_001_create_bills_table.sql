-- ============================================
-- THE OREGANO CAFE — Bills Table Migration
-- Run this in Supabase SQL Editor
-- ============================================
-- This migration creates the bills table that stores
-- historical bill/invoice data generated automatically
-- after a successful final table payment.
--
-- Each bill represents the complete paid session for a table,
-- containing all orders, items, totals, and payment details.
-- Bills are immutable once created — they preserve the exact
-- historical record regardless of future table sessions.
-- ============================================

-- BILLS table
-- Stores final paid bills generated after successful table payment.
-- Each bill is a snapshot of the complete table session at payment time.
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  bill_number TEXT UNIQUE NOT NULL,
  session_id TEXT REFERENCES table_sessions(id),
  "table" INTEGER NOT NULL,
  orders JSONB NOT NULL DEFAULT '[]',
  total NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'ONLINE', 'SPLIT')),
  payment_date TEXT NOT NULL,
  payment_time TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_bills_number ON bills(bill_number);
CREATE INDEX IF NOT EXISTS idx_bills_session ON bills(session_id);
CREATE INDEX IF NOT EXISTS idx_bills_table ON bills("table");
CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at DESC);
