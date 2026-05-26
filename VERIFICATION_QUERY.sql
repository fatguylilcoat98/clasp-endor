-- CLASP-ENDOR VERIFICATION QUERY
-- Run this after MASTER_MIGRATION.sql to verify everything is set up correctly

WITH table_check AS (
  SELECT
    'TABLES' as check_type,
    string_agg(table_name, ', ' ORDER BY table_name) as result
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'pilot_instances', 'users', 'companion_profile', 'supported_person_profile',
      'circle_contacts', 'memory_vaults', 'memory_vault_sessions', 'memory_store',
      'governance_audit_log', 'setup_state', 'governance_review_queue',
      'governance_review_decisions', 'governance_execution_authorizations',
      'governance_execution_claims', 'governance_execution_attempts',
      'governance_execution_outcomes', 'governance_execution_verifications'
    )
),
column_check AS (
  SELECT
    'MEMORY_STATUS_COLUMN' as check_type,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_store' AND column_name = 'memory_status'
    ) THEN 'EXISTS' ELSE 'MISSING' END as result
),
role_check AS (
  SELECT
    'LYLO_ROLES' as check_type,
    string_agg(rolname, ', ' ORDER BY rolname) as result
  FROM pg_roles
  WHERE rolname IN ('lylo_app', 'lylo_admin', 'lylo_runtime', 'lylo_setup')
),
count_check AS (
  SELECT
    'TABLE_COUNT' as check_type,
    COUNT(*)::text as result
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'pilot_instances', 'users', 'companion_profile', 'supported_person_profile',
      'circle_contacts', 'memory_vaults', 'memory_vault_sessions', 'memory_store',
      'governance_audit_log', 'setup_state', 'governance_review_queue',
      'governance_review_decisions', 'governance_execution_authorizations',
      'governance_execution_claims', 'governance_execution_attempts',
      'governance_execution_outcomes', 'governance_execution_verifications'
    )
),
rls_check AS (
  SELECT
    'RLS_ENABLED' as check_type,
    COUNT(*)::text || ' of 17 tables' as result
  FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relrowsecurity = true
    AND c.relname IN (
      'pilot_instances', 'users', 'companion_profile', 'supported_person_profile',
      'circle_contacts', 'memory_vaults', 'memory_vault_sessions', 'memory_store',
      'governance_audit_log', 'setup_state', 'governance_review_queue',
      'governance_review_decisions', 'governance_execution_authorizations',
      'governance_execution_claims', 'governance_execution_attempts',
      'governance_execution_outcomes', 'governance_execution_verifications'
    )
)

SELECT check_type, result FROM table_check
UNION ALL SELECT check_type, result FROM column_check
UNION ALL SELECT check_type, result FROM role_check
UNION ALL SELECT check_type, result FROM count_check
UNION ALL SELECT check_type, result FROM rls_check
ORDER BY check_type;