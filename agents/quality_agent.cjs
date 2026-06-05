/**
 * Quality Agent — 품질 이상 탐지 (docs/05 §2.6). intent: quality_anomaly
 * 입력(mock): 라인별 불량률/설비 상관 + 불량예측(STEP8, MES/IoT). live: axos.silver.mes_*.
 * 결정: send_alert(품질/생산) + 이상 시 simulate_eval(원인 시뮬). L1→L2→L3(이슈 생성).
 */
'use strict';
const B = require('./_base.cjs');

const LINES = {
  '3': { defect_rate: 0.072, baseline: 0.03, suspect_equip: 'EQP-3B', corr: 0.81, label: '라인3' },
  '1': { defect_rate: 0.021, baseline: 0.03, suspect_equip: null, corr: 0.1, label: '라인1' },
};

function retrieve() { return LINES; }

function reason(d) {
  const rows = Object.entries(d).map(([k, v]) => ({ line: k, ...v,
    anomaly: v.defect_rate > v.baseline * 1.5, ratio: Number((v.defect_rate / v.baseline).toFixed(2)) }));
  const anomalies = rows.filter((r) => r.anomaly).sort((a, b) => b.ratio - a.ratio);
  return { rows, anomalies };
}

function handle(req) {
  const ctx = req.context || {};
  const d = retrieve();
  const r = reason(d);
  const evidence = [
    { kind: 'mes', ref: 'axos.silver.mes_inspection', detail: r.rows.map((x) => `${x.label}:${(x.defect_rate * 100).toFixed(1)}%(기준 ${(x.baseline * 100).toFixed(0)}%)`).join(', ') },
    { kind: 'prediction', ref: 'mosaic:defect_forecast', detail: r.anomalies[0] ? `설비상관 ${r.anomalies[0].suspect_equip}=${r.anomalies[0].corr}` : 'no anomaly' },
    { kind: 'policy', ref: 'doc:quality_sop_v3', detail: 'anomaly if defect_rate > baseline*1.5' },
  ];

  if (r.anomalies.length > 0) {
    const a = r.anomalies[0];
    const msg = `[Quality] ${a.label} 불량률 ${(a.defect_rate * 100).toFixed(1)}% (기준 ${a.ratio}배) — 설비 ${a.suspect_equip} 상관 ${a.corr} → 점검·원인 시뮬 권장`;
    return B.envelope({ agent: 'quality', decision: 'send_alert', summary: msg,
      confidence: a.corr, evidence,
      actions: [
        B.alertAction(ctx, msg),
        { type: 'simulate_eval', target_system: 'n8n', dry_run_supported: true,
          payload: { request_id: B.uid('req'), project_id: ctx.project_id || 'PRJ-DEMO', user_id: ctx.user_id || 'U-DEMO',
            scenario: 'defect_root_cause', line: a.line, suspect_equip: a.suspect_equip } },
      ],
      approval: { level: 'auto', reason: '품질 경보(점검 권장)' } });
  }
  return B.envelope({ agent: 'quality', decision: 'send_alert',
    summary: '전 라인 품질 정상 (불량률 기준 이내)', confidence: 0.92, evidence,
    actions: [B.alertAction(ctx, '[Quality] 전 라인 품질 정상.')],
    approval: { level: 'auto', reason: '정보성' } });
}

module.exports = { handle, retrieve, reason };
