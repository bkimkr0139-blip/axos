/**
 * Agent 공통 골격 헬퍼 (docs/05 §1) — Retrieve→Reason→Decide→DecisionEnvelope.
 * 모든 Agent가 동일 유틸/봉투 빌더를 공유한다. live: retrieve/predict를 Databricks로 교체.
 */
'use strict';
const crypto = require('crypto');
const uid = (p) => p + '-' + crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

// 표준 가드레일(만료 1시간)
function guardrails(extra) {
  return { expires_at: new Date(Date.now() + 3600e3).toISOString(), ...(extra || {}) };
}

// DecisionEnvelope 빌더 — 계약(contracts/bridge/decision_envelope.schema.json) 준수
function envelope({ agent, decision, summary, confidence, evidence, actions, approval, guard }) {
  return {
    decision_id: uid('dec'), agent, decision,
    summary, confidence: Number(confidence),
    ts: now(),
    evidence: evidence || [],
    proposed_actions: actions || [],
    approval_policy: approval || { level: 'auto', reason: '정보성' },
    guardrails: guardrails(guard),
  };
}

// send_alert 액션(공통) — n8n notify로 라우팅
function alertAction(ctx, message) {
  return { type: 'send_alert', target_system: 'n8n', dry_run_supported: true,
    payload: { request_id: uid('req'), project_id: ctx.project_id || 'PRJ-DEMO',
      user_id: ctx.user_id || 'U-DEMO', message, channel: ctx.channel || 'telegram' } };
}

// generate_report 액션(공통) — n8n report-generate로 라우팅
function reportAction(ctx, title, body) {
  return { type: 'generate_report', target_system: 'n8n', dry_run_supported: true,
    payload: { request_id: uid('req'), project_id: ctx.project_id || 'PRJ-DEMO',
      user_id: ctx.user_id || 'U-DEMO', title, body } };
}

// 결정성 의사난수(테스트 안정성 위해 Math.random 회피) — 시드 문자열 해시 0~1
function seeded(seedStr) {
  const h = crypto.createHash('md5').update(String(seedStr)).digest();
  return (h.readUInt32BE(0) % 10000) / 10000;
}

module.exports = { uid, now, guardrails, envelope, alertAction, reportAction, seeded };
