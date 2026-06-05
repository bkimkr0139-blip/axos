/**
 * Finance Agent — 재무 분석 (docs/05 §2.4). intent: cost_anomaly | budget_check
 * 입력(mock): 부서별 비용 MTD vs 예산 + 매출예측. live: axos.gold.cost_daily, axos.silver.budget.
 * 결정: send_alert(임계 초과/예산 소진) | generate_report(비용 이상 리포트). L1→L2.
 */
'use strict';
const B = require('./_base.cjs');

const COST = {
  cloud:   { mtd: 118000000, budget: 100000000, label: '클라우드 인프라' },
  travel:  { mtd: 22000000,  budget: 40000000,  label: '출장비' },
  rnd:     { mtd: 95000000,  budget: 100000000, label: 'R&D' },
};

function retrieve() { return COST; }

function reason(d) {
  const rows = Object.entries(d).map(([k, v]) => {
    const ratio = v.mtd / v.budget;
    return { key: k, label: v.label, mtd: v.mtd, budget: v.budget, ratio: Number(ratio.toFixed(2)),
      over: ratio > 1, near: ratio >= 0.9 && ratio <= 1 };
  });
  const breaches = rows.filter((r) => r.over);
  const warnings = rows.filter((r) => r.near);
  return { rows, breaches, warnings };
}

function handle(req) {
  const ctx = req.context || {};
  const d = retrieve();
  const r = reason(d);
  const evidence = [
    { kind: 'metric', ref: 'axos.gold.cost_daily', detail: r.rows.map((x) => `${x.label}=${(x.ratio * 100).toFixed(0)}%`).join(', ') },
    { kind: 'policy', ref: 'doc:budget_policy_v1', detail: 'alert if ratio>1.0, warn if >=0.9' },
  ];

  if (r.breaches.length > 0) {
    const b = r.breaches[0];
    const msg = `[Finance] ${b.label} 예산 초과: MTD ${(b.mtd / 1e8).toFixed(1)}억 / 예산 ${(b.budget / 1e8).toFixed(1)}억 (${(b.ratio * 100).toFixed(0)}%)`;
    return B.envelope({ agent: 'finance', decision: 'send_alert', summary: msg,
      confidence: Number(Math.min(0.99, b.ratio - 0.5).toFixed(2)), evidence,
      actions: [B.alertAction(ctx, msg)], approval: { level: 'auto', reason: '내부 비용 경보' } });
  }
  if (r.warnings.length > 0) {
    const w = r.warnings[0];
    const msg = `[Finance] ${w.label} 예산 ${(w.ratio * 100).toFixed(0)}% 소진 — 주의`;
    return B.envelope({ agent: 'finance', decision: 'send_alert', summary: msg, confidence: 0.7, evidence,
      actions: [B.alertAction(ctx, msg)], approval: { level: 'auto', reason: '예산 경고' } });
  }
  return B.envelope({ agent: 'finance', decision: 'generate_report',
    summary: '비용 전 항목 예산 내 — 재무 상태 리포트 생성', confidence: 0.9, evidence,
    actions: [B.reportAction(ctx, '재무 상태 리포트', r.rows.map((x) => `${x.label}: ${(x.ratio * 100).toFixed(0)}%`).join('; '))],
    approval: { level: 'auto', reason: '정기 리포트' } });
}

module.exports = { handle, retrieve, reason };
