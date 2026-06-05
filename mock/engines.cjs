/**
 * 엔진 노출 메타데이터 — n8n(실행)·Databricks(판단)의 강점을 화면/기능으로 가시화.
 *   WORKFLOWS : n8n 01~10 레지스트리 + 결정→워크플로우 라우팅 (실행 레이어 강조)
 *   CATALOG   : Unity Catalog 메달리온(Bronze/Silver/Gold/ops/memory) + 계보 (판단 레이어 강조)
 *   predictions(agents) : Mosaic AI 예측(수요/매출/이직/불량/비용) — agent reason() 재사용(부작용 없음)
 * 정적 메타는 docs/00·step1_databricks_mapping 과 일치. live에서도 동일 구조(계약 불변).
 */
'use strict';

// ── n8n 실행 레이어 (BC44 파이프라인 01~10) ── n8n_id = 실제 n8n 워크플로우 ID(에디터/플로우 조회용)
const WORKFLOWS = [
  { id: '01', name: 'document-ingest', desc: '문서 적재→임베딩', triggers: ['webhook'], memory: 'document_memory', n8n_id: 'UkAaB6vqATmoRqk2' },
  { id: '02', name: 'rag-chat', desc: 'RAG 대화 응답', triggers: ['webhook'], memory: 'conversation_memory', n8n_id: 'l5FiRxpbkoQv7Jlq' },
  { id: '03', name: 'web-crawl', desc: '웹 수집', triggers: ['webhook', 'schedule'], n8n_id: 'o9uu5L3w1KO7pyUW' },
  { id: '04', name: 'evaluation-simulate', desc: '예측/시뮬레이션', triggers: ['webhook'], n8n_id: 'q83JgEzoaf95nhnC' },
  { id: '05', name: 'report-generate', desc: '리포트 생성', triggers: ['webhook'], n8n_id: 'ceOeKkZS7jSHqJbE' },
  { id: '06', name: 'wbs-delay-check', desc: '프로젝트 지연 점검', triggers: ['webhook', 'schedule'], memory: 'project_memory', n8n_id: 'UXjXvJqH4KkwCxrQ' },
  { id: '07', name: 'llm-route', desc: 'LLM 라우팅/요약', triggers: ['webhook'], n8n_id: 'Qmx5AEi25ybBlkwg' },
  { id: '08', name: 'notify', desc: '알림(텔레그램/메일)', triggers: ['webhook'], n8n_id: 'q3hKK18G4WV88AC9' },
  { id: '09', name: 'vector-reindex', desc: '벡터 재색인', triggers: ['webhook', 'schedule'], n8n_id: 'h9vUdJTAeLGivAPt' },
  { id: '10', name: 'health', desc: '헬스/상태', triggers: ['webhook'], n8n_id: '54x25z8fKKCrd1Ab' },
];

// 결정(decision) → n8n 워크플로우 라우팅 (브리지 mapWorkflow 미러 + 강조용 메타)
const DECISION_ROUTING = [
  { decision: 'send_alert', workflow: '08 notify', note: '임계/이상 알림' },
  { decision: 'generate_report', workflow: '05 report-generate', note: '근거 리포트' },
  { decision: 'create_po', workflow: 'ERP 어댑터 + 08 notify', note: '발주(승인 필수)' },
  { decision: 'index_document', workflow: '01 document-ingest', note: '문서 기억 적재' },
  { decision: 'reindex_vector', workflow: '09 vector-reindex', note: '재색인' },
  { decision: 'rag_answer', workflow: '02 rag-chat', note: 'Copilot 응답' },
  { decision: 'route_llm', workflow: '07 llm-route', note: '요약/라우팅' },
  { decision: 'check_wbs_delay', workflow: '06 wbs-delay-check', note: '프로젝트 지연' },
  { decision: 'simulate_eval', workflow: '04 evaluation-simulate', note: '예측/시뮬' },
];

// ── Databricks 판단 레이어 (Unity Catalog 메달리온) ──
const CATALOG = {
  catalog: 'axos',
  schemas: {
    bronze: { desc: '원본 적재(제한 권한)', tables: [
      { t: 'erp_orders', src: 'SAP ERP' }, { t: 'erp_inventory', src: 'SAP ERP' },
      { t: 'mes_events', src: 'MES' }, { t: 'crm_contacts_raw', src: 'Salesforce CRM' },
      { t: 'scm_leadtime', src: 'SCM' }, { t: 'groupware_mail', src: '그룹웨어' },
      { t: 'file_docs', src: '파일 스토리지' }, { t: 'iot_sensor', src: 'IoT 게이트웨이' },
      { t: 'hr_masked', src: 'HR(마스킹)' } ] },
    silver: { desc: '정규화·조인(도메인팀)', tables: [
      { t: 'items' }, { t: 'supplier_perf' }, { t: 'crm_contacts' },
      { t: 'mes_inspection' }, { t: 'documents' }, { t: 'hr_masked' } ] },
    gold: { desc: '피처/KPI(Agent·분석)', tables: [
      { t: 'stock' }, { t: 'demand_features' }, { t: 'sales_pipeline' }, { t: 'cost_daily' } ] },
    ops: { desc: '운영(감사·결정·멱등)', tables: [
      { t: 'decision_envelope' }, { t: 'audit' }, { t: 'agent_registry' }, { t: 'source_registry' }, { t: 'actors' } ] },
    memory: { desc: 'Vector Search 4종 기억', tables: [
      { t: 'conversation_memory' }, { t: 'document_memory' }, { t: 'task_memory' }, { t: 'project_memory' } ] },
  },
  // 데이터 계보(예시): 결정 근거 → Gold → Silver → Bronze → 소스
  lineage: [
    { decision: 'create_po (SCM)', chain: ['axos.gold.stock', 'axos.silver.items', 'axos.bronze.scm_leadtime', 'SCM 공급망', 'mosaic:demand_forecast'] },
    { decision: 'send_alert (Finance)', chain: ['axos.gold.cost_daily', 'axos.bronze.erp_orders', 'SAP ERP'] },
    { decision: 'send_alert (Quality)', chain: ['axos.silver.mes_inspection', 'axos.bronze.mes_events', 'MES', 'mosaic:defect_forecast'] },
    { decision: 'send_alert (Sales)', chain: ['axos.gold.sales_pipeline', 'axos.silver.crm_contacts', 'Salesforce CRM', 'mosaic:revenue_forecast'] },
  ],
};

// Mosaic AI 예측 요약 — agent reason()을 부작용 없이 재사용
function predictions(agents) {
  const out = {};
  try { const d = agents.scm.reason(agents.scm.retrieve('A')); out.demand_shortage = { item: 'A', model: 'mosaic:demand_forecast', shortage_prob: d.shortage_prob, reorder_qty: d.reorder_qty, projected: d.projected }; } catch (e) { out.demand_shortage = { error: e.message }; }
  try { const r = agents.sales.reason(agents.sales.retrieve()); out.revenue = { model: 'mosaic:revenue_forecast', forecast_eom: r.forecast_eom, attainment: r.attainment, miss_risk: r.miss_risk }; } catch (e) { out.revenue = { error: e.message }; }
  try { const h = agents.hr.reason(agents.hr.retrieve()); out.attrition = { model: 'mosaic:attrition_risk', flagged: h.flagged.map((x) => ({ team: x.label, risk: x.attrition_risk })) }; } catch (e) { out.attrition = { error: e.message }; }
  try { const q = agents.quality.reason(agents.quality.retrieve()); out.defect = { model: 'mosaic:defect_forecast', anomalies: q.anomalies.map((x) => ({ line: x.label, defect_rate: x.defect_rate, equip: x.suspect_equip, corr: x.corr })) }; } catch (e) { out.defect = { error: e.message }; }
  try { const f = agents.finance.reason(agents.finance.retrieve()); out.cost = { model: 'rule:budget_v1', breaches: f.breaches.map((x) => ({ label: x.label, ratio: x.ratio })), warnings: f.warnings.map((x) => x.label) }; } catch (e) { out.cost = { error: e.message }; }
  return out;
}

module.exports = { WORKFLOWS, DECISION_ROUTING, CATALOG, predictions };
