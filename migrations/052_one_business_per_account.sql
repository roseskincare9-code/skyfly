-- Only a Super Admin may belong to more than one business. Every other account is linked to exactly one
-- business, enforced by the database itself (even if application code forgot a check):
--   * a membership in a second business is refused for an account that is not a Super Admin;
--   * Super Admin access cannot be removed from an account that still belongs to several businesses
--     (its extra memberships must be handed over first).
-- Existing rows are not changed: today only the Super Admin account belongs to several businesses.
CREATE OR REPLACE FUNCTION skyfly_one_business_per_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND is_platform_admin) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM business_members WHERE user_id = NEW.user_id AND business_id <> NEW.business_id) THEN
    RAISE EXCEPTION 'skyfly_one_business: an account that is not a Super Admin can belong to one business only'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS business_members_one_business ON business_members;
CREATE TRIGGER business_members_one_business BEFORE INSERT OR UPDATE OF user_id, business_id ON business_members
  FOR EACH ROW EXECUTE FUNCTION skyfly_one_business_per_account();

CREATE OR REPLACE FUNCTION skyfly_admin_revoke_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(DISTINCT business_id) FROM business_members WHERE user_id = NEW.id) > 1 THEN
    RAISE EXCEPTION 'skyfly_one_business: this account belongs to several businesses; hand them over before removing Super Admin access'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_admin_revoke_guard ON users;
CREATE TRIGGER users_admin_revoke_guard BEFORE UPDATE OF is_platform_admin ON users
  FOR EACH ROW WHEN (OLD.is_platform_admin AND NOT NEW.is_platform_admin) EXECUTE FUNCTION skyfly_admin_revoke_guard();
