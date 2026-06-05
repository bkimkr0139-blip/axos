/**
 * HR Agent — 인사 분석 (docs/05 §2.5). intent: hr_insight
 * 입력(mock): 팀별 근태/초과근무/이직위험. **민감 — UC 마스킹·접근통제(docs/06). 쓰기 없음.**
 * 결정: generate_report(인사 인사이트) | send_alert(이상 근태). L1, 자동실행 지양.
 */
'use strict';
const B = require('./_base.cjs');

const TEAMS = {
  'Y': { headcount: 12, overtime_hr_avg: 38, attrition_risk: 0.42, label: '개발Y팀' },
  'X': { headcount: 8,  overtime_hr_avg: 12, attrition_risk: 0.15, label: '영업X팀' },
};

function retrieve() { return TEAMS; }

function reason(d) {
  const rows = Object.entries(d).map(([k, v]) => ({ team: k, ...v,
    overload: v.overtime_hr_avg >= 30, high_attrition: v.attrition_risk >= 0.35 }));
  const flagged = rows.filter((r) => r.overload || r.high_attrition);
  return { rows, flagged };
}

function handle(req) {
  const ctx = req.context || {};
  const d = retrieve();
  const r = reason(d);
  // 민감 데이터 → evidence는 마스킹된 집계만 (개인정보 비노출)
  const evidence = [
    { kind: 'hr_aggregate', ref: 'axos.silver.hr_masked', detail: r.rows.map((x) => `${x.label}:OT${x.overtime_hr_avg}h/이직위험${(x.attrition_risk * 100).toFixed(0)}%`).join(', ') },
    { kind: 'prediction', ref: 'mosaic:attrition_risk', detail: `flagged_teams=${r.flagged.map((x) => x.label).join(',') || 'none'}` },
    { kind: 'policy', ref: 'doc:hr_governance_v1', detail: 'read-only, masked aggregates, no auto-write' },
  ];

  if (r.flagged.length > 0) {
    const f = r.flagged[0];
    const msg = `[HR] ${f.label} 초과근무 ${f.overtime_hr_avg}h/이직위험 ${(f.attrition_risk * 100).toFixed(0)}% → 충원·면담 검토 권장`;
    return B.envelope({ agent: 'hr', decision: 'generate_report', summary: msg, confidence: f.attrition_risk,
      evidence, actions: [B.reportAction(ctx, '인사 리스크 인사이트', msg)],
      approval: { level: 'auto', reason: '읽기·인사이트(쓰기 없음)' } });
  }
  return B.envelope({ agent: 'hr', decision: 'generate_report',
    summary: '인사 지표 안정 — 정기 인사 인사이트 리포트', confidence: 0.85, evidence,
    actions: [B.reportAction(ctx, '인사 인사이트', r.rows.map((x) => `${x.label} OT${x.overtime_hr_avg}h`).join('; '))],
    approval: { level: 'auto', reason: '정기 리포트' } });
}

module.exports = { handle, retrieve, reason };
