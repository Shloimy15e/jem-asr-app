-- Make intent explicit: whatsapp_users and whatsapp_usage are service-role
-- only. RLS was enabled in 20260331_whatsapp_billing.sql with no policies,
-- which already denies authenticated/anon access by default — but explicit
-- deny policies prevent a future migration from inadvertently opening these
-- billing tables to end users.

CREATE POLICY whatsapp_users_deny_authenticated ON whatsapp_users
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY whatsapp_users_deny_anon ON whatsapp_users
  FOR ALL TO anon USING (false) WITH CHECK (false);

CREATE POLICY whatsapp_usage_deny_authenticated ON whatsapp_usage
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY whatsapp_usage_deny_anon ON whatsapp_usage
  FOR ALL TO anon USING (false) WITH CHECK (false);
