/**
 * 거버넌스 정책 (docs/06) — "통제 가능한 자율성"의 강제 지점.
 * 순수 함수 모음: 브리지 게이트가 호출. live에서도 동일 정책(계약 불변).
 *   - checkGuardrails : 금액/수량 한도 (§3.4) → reject
 *   - checkConfidence : 신뢰도 임계 미만 자동실행 차단 (§5) → escalate(승인 강제)
 *   - isExpired       : 봉투 만료(expires_at) (§1 설계원칙2)
 *   - authorizeApprover : 승인자 RBAC 역할 매칭 + 직무분리(SoD, §2)
 */
'use strict';

const CONFIDENCE_MIN = parseFloat(process.env.AXOS_CONFIDENCE_MIN || '0.5'); // 자동실행 최소 신뢰도

// 역할 → 구성원(승인 가능자). live: UC/IdP 그룹. mock: 정적 매핑.
const ROLE_MEMBERS = {
  'role:scm_approver': ['user:scm_lead', 'user:scm_mgr'],
  'role:procurement_approver': ['user:proc_lead', 'user:proc_mgr'],
  'role:procurement_lead': ['user:proc_lead'],
  'role:finance_lead': ['user:fin_lead', 'user:cfo'],
  'role:finance_approver': ['user:fin_lead'],
  'role:quality_approver': ['user:qa_lead'],
};

// §3.4 한도: 금액/수량 초과 → 거부. (정책상 '초과 시 자동 승급'도 가능하나 안전 기본=거부)
function checkGuardrails(env) {
  const g = env.guardrails || {};
  const p = ((env.proposed_actions && env.proposed_actions[0]) || {}).payload || {};
  const amt = Number(p.amount || 0), qty = Number(p.qty || 0);
  if (g.amount_limit && amt > g.amount_limit)
    return { verdict: 'reject', reason: `금액 ${amt.toLocaleString()} > 한도 ${Number(g.amount_limit).toLocaleString()}` };
  if (g.qty_limit && qty > g.qty_limit)
    return { verdict: 'reject', reason: `수량 ${qty} > 한도 ${g.qty_limit}` };
  return { verdict: 'pass' };
}

// §5 신뢰도 임계: auto인데 confidence 낮으면 사람에게 승급
function checkConfidence(env) {
  const lvl = (env.approval_policy || {}).level;
  if (lvl === 'auto' && env.decision !== 'noop' && Number(env.confidence) < CONFIDENCE_MIN)
    return { verdict: 'escalate', reason: `confidence ${env.confidence} < 임계 ${CONFIDENCE_MIN} → 자동실행 불가, 승인 필요` };
  return { verdict: 'pass' };
}

// 만료: nowMs 주입(브리지가 Date.now 제공 — 테스트 가능)
function isExpired(env, nowMs) {
  const exp = (env.guardrails || {}).expires_at;
  if (!exp) return false;
  const t = Date.parse(exp);
  return !isNaN(t) && t < nowMs;
}

// §2 RBAC + SoD: approver가 요구 역할의 구성원인가 + 판단주체(ai)와 분리됐는가
function authorizeApprover(env, approver, priorApprovers) {
  const pol = env.approval_policy || {};
  const required = pol.approvers || [];
  if (!approver) return { ok: false, reason: 'approver_required' };
  if (approver === 'ai' || approver.startsWith('agent:'))
    return { ok: false, reason: 'SoD 위반: 판단 주체는 승인 불가' };
  // 요구 역할이 없으면(일반 승인) 사람이면 통과
  if (required.length === 0) return { ok: true };
  // 역할 구성원 매칭 (role:* → members, 또는 직접 사용자 지정 일치)
  const allowed = required.some((r) => {
    if (ROLE_MEMBERS[r]) return ROLE_MEMBERS[r].includes(approver);
    return r === approver; // 직접 사용자/역할 문자열 일치
  });
  if (!allowed) return { ok: false, reason: `권한 없음: ${approver} 는 ${required.join('/')} 아님` };
  // 이중승인 SoD: 이미 승인한 사람과 달라야 함
  if ((priorApprovers || []).includes(approver))
    return { ok: false, reason: 'SoD 위반: 동일인 중복 승인 불가(이중승인)' };
  return { ok: true };
}

// 이중승인 필요 인원
function requiredApprovals(env) {
  return (env.approval_policy || {}).level === 'dual_approval' ? 2 : 1;
}

module.exports = { checkGuardrails, checkConfidence, isExpired, authorizeApprover, requiredApprovals, ROLE_MEMBERS, CONFIDENCE_MIN };
