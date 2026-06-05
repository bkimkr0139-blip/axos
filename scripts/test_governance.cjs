/**
 * 거버넌스 정책 단위 테스트 (mock/governance.cjs) — 자연 트리거가 어려운 케이스(한도/만료) 포함 전수.
 * 실행: node scripts/test_governance.cjs   (종료코드 0=통과)
 */
'use strict';
const assert = require('assert');
const gov = require('../mock/governance.cjs');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// 봉투 헬퍼
const env = (over) => Object.assign({
  decision_id: 'dec-t', agent: 'scm', decision: 'create_po', confidence: 0.9,
  proposed_actions: [{ type: 'create_po', payload: { amount: 5000000, qty: 500 } }],
  approval_policy: { level: 'approval_required', approvers: ['role:scm_approver'] },
  guardrails: { amount_limit: 10000000, qty_limit: 5000, expires_at: '2999-01-01T00:00:00Z' },
}, over || {});

// 1. 한도 통과 / 금액 초과 거부 / 수량 초과 거부
assert.strictEqual(gov.checkGuardrails(env()).verdict, 'pass'); ok('guardrail pass (한도 내)');
assert.strictEqual(gov.checkGuardrails(env({ proposed_actions: [{ payload: { amount: 20000000, qty: 100 } }] })).verdict, 'reject'); ok('guardrail reject (금액 초과)');
assert.strictEqual(gov.checkGuardrails(env({ proposed_actions: [{ payload: { amount: 100, qty: 9999 } }] })).verdict, 'reject'); ok('guardrail reject (수량 초과)');

// 2. 신뢰도 임계: auto+저신뢰 → escalate, auto+고신뢰 → pass, 비auto → pass
assert.strictEqual(gov.checkConfidence(env({ approval_policy: { level: 'auto' }, confidence: 0.3 })).verdict, 'escalate'); ok('confidence escalate (auto+저신뢰)');
assert.strictEqual(gov.checkConfidence(env({ approval_policy: { level: 'auto' }, confidence: 0.9 })).verdict, 'pass'); ok('confidence pass (auto+고신뢰)');
assert.strictEqual(gov.checkConfidence(env({ confidence: 0.1 })).verdict, 'pass'); ok('confidence pass (비auto는 영향 없음)');

// 3. 만료
assert.strictEqual(gov.isExpired(env({ guardrails: { expires_at: '2000-01-01T00:00:00Z' } }), Date.now()), true); ok('expired (과거)');
assert.strictEqual(gov.isExpired(env(), Date.now()), false); ok('not expired (미래)');

// 4. RBAC + SoD
assert.strictEqual(gov.authorizeApprover(env(), 'user:scm_lead', []).ok, true); ok('RBAC allow (역할 구성원)');
assert.strictEqual(gov.authorizeApprover(env(), 'user:random', []).ok, false); ok('RBAC deny (비구성원)');
assert.strictEqual(gov.authorizeApprover(env(), 'ai', []).ok, false); ok('SoD deny (판단주체 승인 불가)');
assert.strictEqual(gov.authorizeApprover(env(), '', []).ok, false); ok('deny (승인자 없음)');
assert.strictEqual(gov.authorizeApprover(env(), 'user:scm_lead', ['user:scm_lead']).ok, false); ok('SoD deny (동일인 중복)');

// 5. 이중승인 인원
assert.strictEqual(gov.requiredApprovals(env({ approval_policy: { level: 'dual_approval' } })), 2); ok('dual_approval=2명');
assert.strictEqual(gov.requiredApprovals(env()), 1); ok('단일승인=1명');

console.log(`\nGOVERNANCE UNIT TESTS PASSED: ${n}/${n}`);
