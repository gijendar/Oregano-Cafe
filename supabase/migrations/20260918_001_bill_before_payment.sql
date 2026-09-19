-- ============================================================
-- THE OREGANO CAFE — BILL-BEFORE-PAYMENT WORKFLOW MIGRATION
-- Run this in the Supabase SQL Editor (safe to run multiple times).
--
-- New workflow: bill is generated UNPAID (no payment method) when the
-- customer asks for it; admin records CASH / ONLINE / SPLIT afterwards.
-- ============================================================

-- 1. Admin credential change: ONLY oreganocafe / 2019 (legacy removed)
INSERT INTO admins (username, password, name)
VALUES ('oreganocafe', '2019', 'Admin')
ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password;
DELETE FROM admins WHERE username = 'admin';

-- 2. New bill columns for the unpaid-first workflow
ALTER TABLE bills ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'UNPAID';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS subtotal NUMERIC DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_date TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_time TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- 3. Payment method must NOT be required to create a bill (UNPAID state)
DO $$ BEGIN
  ALTER TABLE bills ALTER COLUMN payment_method DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- 4. Recreate the payment_method CHECK to also allow NULL (UNPAID bills)
DO $$ BEGIN
  ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payment_method_check;
END $$;
DO $$ BEGIN
  ALTER TABLE bills ADD CONSTRAINT bills_payment_method_check
    CHECK (payment_method IN ('CASH', 'ONLINE', 'SPLIT') OR payment_method IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. payment_date / payment_time become nullable (null until payment recorded)
DO $$ BEGIN
  ALTER TABLE bills ALTER COLUMN payment_date DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bills ALTER COLUMN payment_time DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- 6. Enforce payment_status values
DO $$ BEGIN
  ALTER TABLE bills ADD CONSTRAINT bills_payment_status_check
    CHECK (payment_status IN ('UNPAID', 'PAID'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7. Split amounts on orders (breakdown per paid order)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_amount NUMERIC DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS online_amount NUMERIC DEFAULT 0;

-- 8. Backfill: bills that already carry a payment method are historical PAID bills
UPDATE bills SET payment_status = 'PAID' WHERE payment_status IS NULL AND payment_method IS NOT NULL;
UPDATE bills SET payment_status = 'UNPAID' WHERE payment_status IS NULL;
UPDATE bills SET bill_date = payment_date, bill_time = payment_time WHERE bill_date IS NULL AND payment_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bills_payment_status ON bills(payment_status);
