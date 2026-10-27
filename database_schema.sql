CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'COLLECTOR', 'BORROWER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  borrower_id UUID,
  privacy_consent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name='users' AND column_name='id' AND table_schema=current_schema()) <> 'uuid' THEN
    ALTER TABLE users ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE users ALTER COLUMN id TYPE UUID USING gen_random_uuid();
    ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'ADMIN';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS borrower_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE users SET name='ALIVIO User' WHERE name IS NULL OR BTRIM(name)='';
UPDATE users SET email='legacy-' || id::text || '@invalid.local' WHERE email IS NULL OR BTRIM(email)='';
UPDATE users SET password_hash='DISABLED_LEGACY_ACCOUNT', active=FALSE WHERE password_hash IS NULL;
ALTER TABLE users ALTER COLUMN name SET NOT NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'COLLECTOR', 'BORROWER'));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS borrowers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  id_document_path TEXT,
  contract_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_borrower_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_borrower_id_fkey
  FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_number TEXT NOT NULL UNIQUE,
  borrower_id UUID NOT NULL REFERENCES borrowers(id),
  principal NUMERIC(14,2) NOT NULL CHECK (principal > 0),
  monthly_rate NUMERIC(7,4) NOT NULL CHECK (monthly_rate >= 0),
  term_months INTEGER NOT NULL CHECK (term_months > 0),
  interest NUMERIC(14,2) NOT NULL,
  total_due NUMERIC(14,2) NOT NULL,
  start_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'RENEWED')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (loan_id, installment_number)
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id),
  borrower_id UUID NOT NULL REFERENCES borrowers(id),
  receipt_number TEXT NOT NULL UNIQUE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  remaining_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES
  ('monthly_rate', '10'),
  ('penalty_rate', '0'),
  ('organization_name', '"ALIVIO Lending"')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS borrowers_name_idx ON borrowers (last_name, first_name);
CREATE INDEX IF NOT EXISTS loans_borrower_status_idx ON loans (borrower_id, status);
CREATE INDEX IF NOT EXISTS installments_due_date_idx ON installments (due_date);
CREATE INDEX IF NOT EXISTS payments_paid_at_idx ON payments (paid_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);
