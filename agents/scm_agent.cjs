/**
 * SCM Agent — 재고 예측 → 발주 추천 (STEP6/8 수직 슬라이스)
 * 공통 골격: Retrieve(Delta/Vector/예측 mock) → Reason(상황진단) → Decide(DecisionEnvelope)
 * 출력은 contracts/bridge/decision_envelope.schema.json 을 따른다.
 * live 전환: retrieve()를 Databricks SQL/Vector, predict()를 Mosaic AI 서빙으로 교체.
 */
'use strict';
const crypto = require('crypto');
const uid = (p) => p + '-' + crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

// ── mock 데이터 (live: axos.gold.* Delta 테이블) ──
const STOCK = {
  A: { on_hand: 120, safety_stock: 300, lead_time_days: 7, avg_daily_demand: 40, unit_price: 10000 },
  B: { on_hand: 800, safety_stock: 200, lead_time_days: 5, avg_daily_demand: 30, unit_price: 8000 },
  C: { on_hand: 50,  safety_stock: 150, lead_time_days: 14, avg_daily_demand: 25, unit_price: 22000 },
};
const SUPPLIERS = {
  A: [{ id: 'SUP-B', name: '공급사B', otd: 0.97, price_factor: 0.97 }, { id: 'SUP-A', name: '공급사A', otd: 0.90, price_factor: 1.0 }],
  B: [{ id: 'SUP-A', name: '공급사A', otd: 0.95, price_factor: 1.0 }],
  C: [{ id: 'SUP-C', name: '공급사C', otd: 0.92, price_factor: 1.05 }],
};
const APPROVAL_AMOUNT_THRESHOLD = 1000000; // 100만원 초과 발주는 승인 필수

// ── Retrieve ──
function retrieve(item) {
  const s = STOCK[item];
  if (!s) return null;
  const suppliers = SUPPLIERS[item] || [];
  // 예측 mock: 리드타임 동안 수요 + 변동성 가산 (live: Mosaic AI demand_forecast)
  const horizon = s.lead_time_days;
  const forecast_demand = Math.round(s.avg_daily_demand * horizon * 1.15);
  return { item, ...s, suppliers, horizon, forecast_demand };
}

// ── Reason ──
function reason(d) {
  // 리드타임 종료 시 예상 재고 = 현재고 - 예측수요
  const projected = d.on_hand - d.forecast_demand;
  const breach = projected < d.safety_stock;
  const shortage_prob = breach ? Math.min(0.99, (d.safety_stock - projected) / d.safety_stock) : 0.1;
  // 권장 발주량 = (안전재고 + 예측수요) - 현재고, 음수면 0, 50단위 반올림
  let reorder_qty = Math.max(0, d.safety_stock + d.forecast_demand - d.on_hand);
  reorder_qty = Math.ceil(reorder_qty / 50) * 50;
  const supplier = (d.suppliers[0]) || null;
  const amount = supplier ? Math.round(reorder_qty * d.unit_price * supplier.price_factor) : reorder_qty * d.unit_price;
  return { projected, breach, shortage_prob: Number(shortage_prob.toFixed(2)), reorder_qty, supplier, amount };
}

// ── Decide → DecisionEnvelope ──
function handle(req) {
  const ctx = req.context || {};
  const item = ctx.item || 'A';
  const project_id = ctx.project_id || 'PRJ-DEMO';
  const user_id = ctx.user_id || 'U-DEMO';
  const d = retrieve(item);

  if (!d) {
    return { decision_id: uid('dec'), agent: 'scm', decision: 'noop', confidence: 0,
      summary: 'unknown item: ' + item, ts: now(),
      evidence: [{ kind: 'delta_query', ref: 'axos.gold.stock', detail: 'item not found' }],
      proposed_actions: [{ type: 'noop', target_system: 'base44', payload: {} }],
      approval_policy: { level: 'rejected', reason: 'item not found' } };
  }

  const r = reason(d);
  const evidence = [
    { kind: 'delta_query', ref: 'axos.gold.stock', detail: `on_hand=${d.on_hand}, safety=${d.safety_stock}` },
    { kind: 'prediction', ref: 'mosaic:demand_forecast', detail: `lt=${d.horizon}d demand=${d.forecast_demand}, projected=${r.projected}, shortage_prob=${r.shortage_prob}` },
    { kind: 'policy', ref: 'doc:reorder_policy_v3', detail: 'reorder_point = safety_stock + lead_time_demand' },
  ];

  // 결품 위험 없음 → 정보성 알림(auto)
  if (!r.breach || r.reorder_qty <= 0) {
    return { decision_id: uid('dec'), agent: 'scm', decision: 'send_alert',
      confidence: Number((1 - r.shortage_prob).toFixed(2)),
      summary: `품목 ${item} 재고 안정 (예상재고 ${r.projected} ≥ 안전재고 ${d.safety_stock})`, ts: now(), evidence,
      proposed_actions: [{ type: 'send_alert', target_system: 'n8n', dry_run_supported: true,
        payload: { request_id: uid('req'), project_id, user_id,
          message: `[SCM] 품목 ${item} 재고 안정. 발주 불필요.`, channel: ctx.channel || 'telegram' } }],
      approval_policy: { level: 'auto', reason: '정보성 알림' } };
  }

  // 결품 위험 → 발주 추천. 금액 임계 따라 승인정책 결정
  const sup = r.supplier;
  const needApproval = r.amount > APPROVAL_AMOUNT_THRESHOLD;
  return {
    decision_id: uid('dec'), agent: 'scm', decision: 'create_po',
    confidence: r.shortage_prob,
    summary: `품목 ${item} 결품 위험(확률 ${r.shortage_prob}) → ${r.reorder_qty}개 발주 권장` + (sup ? ` (${sup.name})` : ''),
    ts: now(), evidence,
    proposed_actions: [{
      type: 'create_po', target_system: 'erp', dry_run_supported: true,
      payload: { item, qty: r.reorder_qty, supplier_id: sup ? sup.id : null,
        supplier_name: sup ? sup.name : null, unit_price: d.unit_price, amount: r.amount,
        request_id: uid('req'), project_id, user_id },
      compensation: { type: 'cancel_po' },
    }],
    approval_policy: needApproval
      ? { level: 'approval_required', reason: `발주금액 ${r.amount.toLocaleString()}원 > 임계 ${APPROVAL_AMOUNT_THRESHOLD.toLocaleString()}`, approvers: ['role:scm_approver'] }
      : { level: 'auto', reason: '소액 발주(임계 이하)' },
    guardrails: { amount_limit: 10000000, qty_limit: 5000, expires_at: new Date(Date.now() + 3600e3).toISOString() },
  };
}

module.exports = { handle, retrieve, reason, _STOCK: STOCK };
