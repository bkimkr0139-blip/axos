/**
 * Procurement Agent — 발주 추천/공급사 선정 (docs/05 §2.3). intent: reorder
 * 입력(mock): 품목 발주 필요량 + 공급사 성과(납기 OTD/단가/품질). live: axos.silver.supplier_perf.
 * 결정: create_po(공급사·단가·조건 보강). 금액 임계 → 승인/이중승인. ERP 어댑터 실행.
 */
'use strict';
const B = require('./_base.cjs');

const ITEMS = {
  A: { unit_price: 10000, need_qty: 550 },
  B: { unit_price: 8000, need_qty: 300 },
  C: { unit_price: 22000, need_qty: 200 },
  D: { unit_price: 60000, need_qty: 300 },   // 고액 설비부품 → 이중승인 임계 초과(>1000만)
};
const SUPPLIERS = {
  A: [
    { id: 'SUP-B', name: '공급사B', otd: 0.97, price_factor: 0.97, quality: 0.98 },
    { id: 'SUP-A', name: '공급사A', otd: 0.90, price_factor: 1.00, quality: 0.95 },
  ],
  B: [{ id: 'SUP-A', name: '공급사A', otd: 0.95, price_factor: 1.00, quality: 0.96 }],
  C: [{ id: 'SUP-C', name: '공급사C', otd: 0.92, price_factor: 1.05, quality: 0.99 }],
  D: [{ id: 'SUP-D', name: '공급사D', otd: 0.94, price_factor: 0.98, quality: 0.97 }],
};
const APPROVAL_THRESHOLD = 1000000;     // 100만원 초과 승인
const DUAL_THRESHOLD = 10000000;        // 1000만원 초과 이중승인

function retrieve(item) {
  const it = ITEMS[item]; if (!it) return null;
  return { item, ...it, suppliers: SUPPLIERS[item] || [] };
}

function reason(d) {
  // 공급사 점수 = OTD*0.5 + 품질*0.3 + 단가경쟁력(1/price_factor)*0.2
  const ranked = d.suppliers.map((s) => ({ ...s,
    score: Number((s.otd * 0.5 + s.quality * 0.3 + (1 / s.price_factor) * 0.2).toFixed(4)) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const qty = d.need_qty;
  const amount = best ? Math.round(qty * d.unit_price * best.price_factor) : qty * d.unit_price;
  return { ranked, best, qty, amount };
}

function handle(req) {
  const ctx = req.context || {};
  const item = ctx.item || 'A';
  const d = retrieve(item);
  if (!d) {
    return B.envelope({ agent: 'procurement', decision: 'noop', summary: 'unknown item: ' + item, confidence: 0,
      evidence: [{ kind: 'delta_query', ref: 'axos.silver.items', detail: 'not found' }],
      actions: [{ type: 'noop', target_system: 'base44', payload: {} }],
      approval: { level: 'rejected', reason: 'item not found' } });
  }
  const r = reason(d);
  const sup = r.best;
  const evidence = [
    { kind: 'delta_query', ref: 'axos.silver.supplier_perf', detail: `candidates=${r.ranked.length}, best=${sup ? sup.name : 'none'} score=${sup ? sup.score : 0}` },
    { kind: 'policy', ref: 'doc:procurement_policy_v2', detail: 'score = OTD*.5 + quality*.3 + price*.2' },
    { kind: 'calc', ref: 'erp:po_estimate', detail: `qty=${r.qty} unit=${d.unit_price} factor=${sup ? sup.price_factor : 1} amount=${r.amount}` },
  ];
  const dual = r.amount > DUAL_THRESHOLD;
  const needApproval = r.amount > APPROVAL_THRESHOLD;
  return B.envelope({
    agent: 'procurement', decision: 'create_po',
    summary: `품목 ${item} ${r.qty}개 발주 — 공급사 ${sup ? sup.name : '미정'} 추천(점수 ${sup ? sup.score : 0}, ${(r.amount).toLocaleString()}원)`,
    confidence: sup ? sup.score : 0.5, evidence,
    actions: [{ type: 'create_po', target_system: 'erp', dry_run_supported: true,
      payload: { item, qty: r.qty, supplier_id: sup ? sup.id : null, supplier_name: sup ? sup.name : null,
        unit_price: d.unit_price, amount: r.amount, request_id: B.uid('req'),
        project_id: ctx.project_id || 'PRJ-DEMO', user_id: ctx.user_id || 'U-DEMO' },
      compensation: { type: 'cancel_po' } }],
    approval: dual
      ? { level: 'dual_approval', reason: `발주금액 ${r.amount.toLocaleString()}원 > 이중승인 임계 ${DUAL_THRESHOLD.toLocaleString()}`, approvers: ['role:procurement_lead', 'role:finance_lead'] }
      : needApproval
        ? { level: 'approval_required', reason: `발주금액 ${r.amount.toLocaleString()}원 > 임계 ${APPROVAL_THRESHOLD.toLocaleString()}`, approvers: ['role:procurement_approver'] }
        : { level: 'auto', reason: '소액 발주' },
    guard: { amount_limit: 50000000, qty_limit: 10000 },
  });
}

module.exports = { handle, retrieve, reason };
