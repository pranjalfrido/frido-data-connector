-- Run this in Supabase SQL editor (as service role / postgres)

CREATE TABLE IF NOT EXISTS user_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('founder','finance','ops','marketing','analyst')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  approved_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_profiles_updated ON user_profiles;
CREATE TRIGGER trg_user_profiles_updated
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable RLS — only service role can read/write
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON user_profiles
  USING (auth.role() = 'service_role');

-- Seed: add the first admin user (change email/name as needed)
-- INSERT INTO user_profiles (email, full_name, role, approved_by)
-- VALUES ('pranjal.t@myfrido.com', 'Pranjal Tripathi', 'founder', 'system');
