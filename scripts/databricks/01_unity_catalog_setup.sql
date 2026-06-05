-- AXOS · Unity Catalog / Delta 초기 셋업 (STEP2/3/9)
-- 실행: Databricks SQL Editor 또는 Workflows. 워크스페이스+UC 활성 + 권한 필요.
-- 메달리온: bronze(원본) -> silver(정규화) -> gold(피처/KPI). audit(불변). memory(벡터 원천).

-- 1) 카탈로그/스키마 (SSOT)
CREATE CATALOG IF NOT EXISTS axos COMMENT 'AXOS 단일 데이터 원천';
CREATE SCHEMA  IF NOT EXISTS axos.bronze COMMENT '레거시 원본 수집(ERP/MES/CRM/SCM/HR/IoT/Mail/File/DB)';
CREATE SCHEMA  IF NOT EXISTS axos.silver COMMENT '정규화/조인';
CREATE SCHEMA  IF NOT EXISTS axos.gold   COMMENT '피처/KPI/예측입력';
CREATE SCHEMA  IF NOT EXISTS axos.audit  COMMENT '결정/실행 감사 (불변 append)';
CREATE SCHEMA  IF NOT EXISTS axos.memory COMMENT 'Agent Memory 원천(STEP9)';

-- 2) Bronze 예시 — ERP/SCM 수집 (docs/02 레거시 연계)
CREATE TABLE IF NOT EXISTS axos.bronze.erp_orders (
  order_id STRING, item STRING, qty INT, order_date TIMESTAMP, status STRING,
  _ingested_at TIMESTAMP, _source STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS axos.bronze.scm_inventory (
  item STRING, on_hand INT, safety_stock INT, lead_time_days INT, snapshot_at TIMESTAMP,
  _ingested_at TIMESTAMP, _source STRING
) USING DELTA;

-- 3) Gold — SCM Agent 입력 피처 (agents/scm_agent.cjs retrieve()가 읽는 자리)
CREATE TABLE IF NOT EXISTS axos.gold.stock (
  item STRING, on_hand INT, safety_stock INT, lead_time_days INT,
  avg_daily_demand DOUBLE, unit_price DOUBLE, updated_at TIMESTAMP
) USING DELTA;

CREATE TABLE IF NOT EXISTS axos.gold.demand_features (
  item STRING, horizon_days INT, forecast_demand INT, shortage_prob DOUBLE,
  computed_at TIMESTAMP
) USING DELTA;

CREATE TABLE IF NOT EXISTS axos.gold.supplier_perf (
  item STRING, supplier_id STRING, supplier_name STRING, otd DOUBLE, price_factor DOUBLE
) USING DELTA;

-- 4) Audit — 브리지 감사 로그 (mock/audit.jsonl 의 live 대체, docs/04 §5 / docs/06 §4)
CREATE TABLE IF NOT EXISTS axos.audit.decision_log (
  audit_id STRING, ts TIMESTAMP, decision_id STRING, action_id STRING,
  agent STRING, actor STRING, event STRING,        -- decided|held_for_approval|approved|rejected_by_human|executed|failed|compensated|dry_run
  summary STRING, confidence DOUBLE, value DOUBLE, evidence_ref STRING
) USING DELTA;

-- 5) Memory(STEP9) — 4종 기억의 정형 원천. 임베딩/인덱스는 Vector Search로 생성.
CREATE TABLE IF NOT EXISTS axos.memory.task_memory (
  id STRING, decision_id STRING, item STRING, decision STRING, outcome STRING,  -- good|bad|neutral
  summary STRING, ts TIMESTAMP
) USING DELTA;

-- 6) Vector Search 인덱스 (STEP9) — UI/SDK로 생성. 참고 형태:
--   conversation_memory / document_memory / task_memory / project_memory
--   예) Databricks Vector Search endpoint 'axos-vs' + delta-sync index on axos.memory.task_memory
-- (SQL로는 인덱스 생성 불가 — databricks_vector_search SDK 또는 UI 사용)
