/**
 * Sales Agent — 영업 분석 (docs/05 §2.1). intent: sales_risk
 * 입력(mock): CRM 파이프라인/상담 + 매출예측(STEP8). live: axos.gold.sales_* + Mosaic AI.
 * 결정: send_alert(이탈/목표미달 위험) | generate_report(주간 브리핑). 쓰기 없음 → L1.
 */
'use strict';
const B = require('./_base.cjs');

// mock 데이터 (live: Delta Gold)
const PIPELINE = {
  target_month: 1000000000, // 월 매출 목표 10억
  closed_mtd: 620000000,    // 현재 달성 6.2억
  days_elapsed: 18, days_in_month: 30,
  customers: [
    { id: 'CUST-B', name: 'B고객', last_contact_days: 21, overdue_payment: true, arr: 180000000 },
    { id: 'CUST-A', name: 'A고객', last_contact_days: 4, overdue_payment: false, arr: 240000000 },
  ],
};

function retrieve() { return PIPELINE; }

function reason(d) {
  // 매출예측(STEP8 mock): 현재 페이스 선형 외삽
  const pace = d.closed_mtd / d.days_elapsed;
  const forecast_eom = Math.round(pace * d.days_in_month);
  const attainment = forecast_eom / d.target_month;
  const miss_risk = attainment < 1 ? Number(Math.min(0.99, (1 - attainment)).toFixed(2)) : 0.1;
  // 이탈 위험 고객: 장기 미접촉 + 결제지연
  const churn = d.customers.filter((c) => c.last_contact_days >= 14 && c.overdue_payment);
  return { forecast_eom, attainment: Number(attainment.toFixed(2)), miss_risk, churn };
}

function handle(req) {
  const ctx = req.context || {};
  const d = retrieve();
  const r = reason(d);
  const evidence = [
    { kind: 'delta_query', ref: 'axos.gold.sales_pipeline', detail: `closed_mtd=${d.closed_mtd}, target=${d.target_month}` },
    { kind: 'prediction', ref: 'mosaic:revenue_forecast', detail: `forecast_eom=${r.forecast_eom}, attainment=${r.attainment}, miss_risk=${r.miss_risk}` },
    { kind: 'crm', ref: 'axos.silver.crm_contacts', detail: `churn_candidates=${r.churn.map((c) => c.name).join(',') || 'none'}` },
  ];

  // 목표 미달 위험 높음 또는 이탈 후보 존재 → 경보
  if (r.miss_risk >= 0.3 || r.churn.length > 0) {
    const msg = `[Sales] 월 매출 목표 미달 위험 ${(r.miss_risk * 100).toFixed(0)}% (예상 ${(r.forecast_eom / 1e8).toFixed(1)}억/목표 ${(d.target_month / 1e8).toFixed(0)}억)`
      + (r.churn.length ? ` · 이탈징후 고객: ${r.churn.map((c) => c.name).join(', ')}` : '');
    return B.envelope({ agent: 'sales', decision: 'send_alert', summary: msg, confidence: r.miss_risk,
      evidence, actions: [B.alertAction(ctx, msg)], approval: { level: 'auto', reason: '영업 경보(읽기)' } });
  }
  // 안정 → 주간 브리핑 리포트(자동)
  const title = '주간 영업 브리핑';
  return B.envelope({ agent: 'sales', decision: 'generate_report',
    summary: `영업 파이프라인 정상(달성률 ${(r.attainment * 100).toFixed(0)}%) → 주간 브리핑 생성`,
    confidence: Number((1 - r.miss_risk).toFixed(2)), evidence,
    actions: [B.reportAction(ctx, title, `달성률 ${(r.attainment * 100).toFixed(0)}%, 예상 마감 ${(r.forecast_eom / 1e8).toFixed(1)}억`)],
    approval: { level: 'auto', reason: '정기 리포트' } });
}

module.exports = { handle, retrieve, reason };
