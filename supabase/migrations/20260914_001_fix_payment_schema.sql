-- ============================================
-- THE OREGANO CAFE — Payment Schema Fixes
-- Run this in Supabase SQL Editor
-- ============================================
-- Fixes applied after upgrading @supabase/supabase-js to v2 (postgrest-js v2),
-- where the server can no longer self-migrate via an exec_sql RPC.
--
-- 1. bills.cash_amount / bills.online_amount  (split payment amounts)
-- 2. Allow 'SPLIT' in bills.payment_method CHECK constraint
-- 3. Allow 'SPLIT' in table_sessions.payment_method CHECK constraint
-- 4. payments.cash_amount / payments.online_amount
-- 5. orders.order_type / orders.delivery / orders.cash_amount / orders.online_amount
--
-- All statements are idempotent — safe to run multiple times.
-- ============================================

-- 1. Split payment amount columns on bills
ALTER TABLE IF EXISTS bills ADD COLUMN IF NOT EXISTS cash_amount NUMERIC DEFAULT 0;
ALTER TABLE IF EXISTS bills ADD COLUMN IF NOT EXISTS online_amount NUMERIC DEFAULT 0;

-- 2. Rebuild bills payment_method CHECK to include SPLIT
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
END $$;

-- 3. Rebuild table_sessions payment_method CHECK to include SPLIT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name LIKE 'table_sessions_payment_method_check%'
    AND table_name = 'table_sessions'
  ) THEN
    ALTER TABLE table_sessions DROP CONSTRAINT IF EXISTS table_sessions_payment_method_check;
    ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_payment_method_check
      CHECK (payment_method IN ('CASH', 'ONLINE', 'SPLIT') OR payment_method IS NULL);
  END IF;
END $$;

-- 4. Split payment amount columns on payments
ALTER TABLE IF EXISTS payments ADD COLUMN IF NOT EXISTS cash_amount NUMERIC DEFAULT 0;
ALTER TABLE IF EXISTS payments ADD COLUMN IF NOT EXISTS online_amount NUMERIC DEFAULT 0;

-- 4b. Rebuild payments payment_method CHECK to include SPLIT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name LIKE 'payments_payment_method_check%'
    AND table_name = 'payments'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
    ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
      CHECK (payment_method IN ('CASH', 'ONLINE', 'SPLIT'));
  END IF;
END $$;

-- 5. Order type / delivery / split accounting columns on orders
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'dine-in'
  CHECK (order_type IN ('dine-in', 'takeaway', 'delivery'));
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS delivery JSONB DEFAULT NULL;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS cash_amount NUMERIC DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS online_amount NUMERIC DEFAULT 0;
