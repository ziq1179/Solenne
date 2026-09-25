-- Phase 5 — SSO / OIDC Integration
-- Adds sso_config_json to tenants for per-tenant SSO configuration.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sso_config_json JSONB;
-- NULL = SSO disabled (default). Non-null = SSO enabled for this tenant.
