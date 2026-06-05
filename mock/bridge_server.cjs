/**
 * AXOS 실행 브리지 (mock)  ─ 판단(Agent/Databricks 대체) → 브리지 → 실행(n8n/ERP)
 * ----------------------------------------------------------------------------
 * 파이프라인: judge → validate → idempotency → approval gate(HITL) → execute → audit
 * STEP2: SCM Agent(agents/scm_agent) + ERP mock 어댑터(adapters/erp_mock) 연동
 * STEP3: 승인 응답 루프 — 보류(held) → /approve → execute, /reject → 폐기
 * live 전환: judge를 Databricks Model Serving/Jobs로, audit를 Delta append로 교체. 계약 불변.
 *
 * 확장자 .cjs : 상위 package.json("type":"module") 때문에 .js는 ESM 오류.
 * 실행:  node bridge_server.cjs   (기본 포트 4100)
 * 엔드포인트:
 *   GET  /health           브리지 상태
 *   POST /insight          InsightRequest → 판단·게이트·(auto면)실행. ?dry_run=1 지원
 *   POST /approve          { decision_id, approver } → 보류건 실행
 *   POST /reject           { decision_id, approver, reason } → 보류건 폐기
 *   GET  /pending          승인 대기(held) 목록
 *   GET  /audit?n=20       감사 로그 마지막 N건
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// .env 자동 로드 (의존성 없음) — axos/.env 의 KEY=VALUE. 실제 process.env 가 우선.
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue; // 주석(#)·빈 줄은 매칭 안 됨
      let val = m[2];
      if ((val[0] === '"' && val.slice(-1) === '"') || (val[0] === "'" && val.slice(-1) === "'")) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
    console.log('[axos-bridge] .env loaded');
  } catch (_) { /* .env 없으면 무시(env 직접 주입 가능) */ }
})();

const scmAgent = require('../agents/scm_agent.cjs');
const salesAgent = require('../agents/sales_agent.cjs');
const procurementAgent = require('../agents/procurement_agent.cjs');
const financeAgent = require('../agents/finance_agent.cjs');
const hrAgent = require('../agents/hr_agent.cjs');
const qualityAgent = require('../agents/quality_agent.cjs');
const memory = require('../memory/memory_mock.cjs');
const gov = require('./governance.cjs');
const engines = require('./engines.cjs');
const dbxJudge = require('../adapters/databricks_judge.cjs');
const erp = require('../adapters/erp_mock.cjs');
const base44Card = require('../adapters/base44_card.cjs');

// Agent 레지스트리 — Base44 AIAgent.type ↔ 판단 도메인 alias (계약 불변, docs/step1_databricks_mapping §3.1)
const AGENT_REGISTRY = {
  inventory: { domain: 'scm', label: '재고 Agent' },
  purchasing: { domain: 'procurement', label: '구매 Agent' },
  sales: { domain: 'sales', label: '영업 Agent' },
  quality: { domain: 'quality', label: '품질 Agent' },
  hr: { domain: 'hr', label: '인사 Agent' },
  finance: { domain: 'finance', label: '재무 Agent' },
};

const CFG = {
  port: parseInt(process.env.BRIDGE_PORT || '4100', 10),
  n8nBase: process.env.N8N_BASE_URL || 'http://localhost:5678',
  n8nToken: process.env.N8N_WEBHOOK_TOKEN || 'dev-local-token',
  n8nApiKey: process.env.N8N_API_KEY || '', // n8n REST(워크플로우 플로우 조회)용. 서버사이드 전용, Base44에 미노출
  callbackUrl: process.env.BASE44_CALLBACK_URL || 'http://localhost:4000/mock-callback',
  auditFile: path.join(__dirname, 'audit.jsonl'),
};

const now = () => new Date().toISOString();
const uid = (p) => p + '-' + crypto.randomUUID().slice(0, 8);
const idempotency = new Map(); // decision_id -> ActionResult (중복 실행 차단)
const held = new Map();        // decision_id -> { env, req, ts, card_id, approvals[] } (승인 대기)
const killed = { global: false, agents: new Set() }; // 킬 스위치 (docs/06 §3.6)
const poByDecision = new Map();  // decision_id -> po_id (보상용)

// ───────────────────────────── 감사 ─────────────────────────────
function audit(rec) {
  const line = JSON.stringify({ audit_id: uid('aud'), ts: now(), ...rec });
  try { fs.appendFileSync(CFG.auditFile, line + '\n'); } catch (e) { /* best-effort */ }
  return line;
}

// ───────────────────── 1) 판단 (Agent 라우팅) ─────────────────────
// intent → agent.handle. live: Databricks 추론(adapters/databricks_judge)으로 교체.
const INTENT_ROUTE = {
  // SCM(재고): 결품 예측
  stock_risk: scmAgent.handle, stock_check: scmAgent.handle,
  // Procurement(구매): 발주/공급사 선정
  reorder: procurementAgent.handle, supplier_select: procurementAgent.handle,
  // Sales(영업)
  sales_risk: salesAgent.handle, sales_brief: salesAgent.handle,
  // Finance(재무)
  cost_anomaly: financeAgent.handle, budget_check: financeAgent.handle,
  // HR(인사)
  hr_insight: hrAgent.handle, attrition_risk: hrAgent.handle,
  // Quality(품질)
  quality_anomaly: qualityAgent.handle, defect_check: qualityAgent.handle,
};
function judge(req) {
  const agentFn = INTENT_ROUTE[req.intent];
  if (agentFn) {
    // Retrieve 보강: 업무기억(task_memory)에서 유사 상황 회수 → 판단 신뢰에 참고(mock)
    const recall = memory.retrieve('task_memory', req.intent, 1);
    const env = agentFn(req);
    if (recall.length) env._memory_hint = recall[0];
    return env;
  }
  return copilotDefault(req); // 미매칭/요약 인텐트
}
function copilotDefault(req) {
  const ctx = req.context || {};
  const base = { decision_id: uid('dec'), confidence: 0.85, ts: now(),
    guardrails: { expires_at: new Date(Date.now() + 3600e3).toISOString() } };
  const project_id = ctx.project_id || 'PRJ-DEMO', user_id = ctx.user_id || 'U-DEMO';
  // 문서요약/일반질의 → route_llm (n8n 07 llm-route)
  if (req.intent === 'doc_summary' || req.intent === 'rag_answer') {
    return { ...base, agent: 'copilot', decision: req.intent === 'doc_summary' ? 'route_llm' : 'rag_answer',
      summary: 'Copilot: ' + (req.query || req.intent),
      evidence: [{ kind: 'vector', ref: 'axos.memory.document_memory', detail: 'top-k 회수(mock)' }],
      proposed_actions: [{ type: req.intent === 'doc_summary' ? 'route_llm' : 'rag_answer', target_system: 'n8n', dry_run_supported: true,
        payload: { request_id: uid('req'), project_id, user_id, query: req.query || '', task: req.intent } }],
      approval_policy: { level: 'auto', reason: '읽기/요약' } };
  }
  return { ...base, agent: 'copilot', decision: 'noop', confidence: 0,
    summary: 'unknown intent: ' + req.intent,
    evidence: [{ kind: 'policy', ref: 'bridge:default', detail: 'no rule' }],
    proposed_actions: [{ type: 'noop', target_system: 'base44', payload: {} }],
    approval_policy: { level: 'rejected', reason: 'no matching judgment rule' } };
}

// ───────────────────── 2) 검증 게이트 ─────────────────────
function validateEnvelope(env) {
  if (!env.evidence || env.evidence.length === 0) return 'evidence_required';
  if (typeof env.confidence !== 'number') return 'confidence_required';
  if (!env.proposed_actions || env.proposed_actions.length === 0) return 'actions_required';
  return null;
}

// ───────────────────── 3) 실행 ─────────────────────
function mapWorkflow(decision) {
  const m = { send_alert: 'notify', generate_report: 'report-generate', index_document: 'document-ingest',
    reindex_vector: 'vector-reindex', rag_answer: 'rag-chat', route_llm: 'llm-route',
    check_wbs_delay: 'wbs-delay-check', simulate_eval: 'evaluation-simulate' };
  return m[decision] || 'notify';
}
function postJson(urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad_url:' + urlStr }); }
    const data = Buffer.from(JSON.stringify(bodyObj));
    const opts = { method: 'POST', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } };
    const req = http.request(opts, (res) => { let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: buf }); }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(data); req.end();
  });
}
async function callN8n(workflow, payload) {
  const url = CFG.n8nBase + '/webhook/' + workflow;
  const body = { ...payload, callback_url: CFG.callbackUrl };
  return postJson(url, { Authorization: 'Bearer ' + CFG.n8nToken }, body);
}
// n8n 실행 레이어 헬스 (워크플로우 화면용)
function getN8nHealth() {
  return new Promise((resolve) => {
    let u; try { u = new URL(CFG.n8nBase + '/webhook/health'); } catch (e) { return resolve({ ok: false }); }
    const r = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body: j }); });
    });
    r.on('error', () => resolve({ ok: false })); r.on('timeout', () => { r.destroy(); resolve({ ok: false }); });
  });
}
// n8n 워크플로우 정의 조회 → 단순화(노드+연결 엣지). API 키는 서버사이드(브리지)에만.
function fetchWorkflowFlow(id) {
  return new Promise((resolve) => {
    if (!CFG.n8nApiKey) return resolve({ ok: false, error: 'n8n_api_key_not_set' });
    let u; try { u = new URL(CFG.n8nBase + '/api/v1/workflows/' + id); } catch (e) { return resolve({ ok: false, error: 'bad_id' }); }
    const r = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 6000,
      headers: { 'X-N8N-API-KEY': CFG.n8nApiKey, Accept: 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => {
        if (res.statusCode >= 300) return resolve({ ok: false, error: 'n8n ' + res.statusCode });
        let w; try { w = JSON.parse(b); } catch (_) { return resolve({ ok: false, error: 'parse' }); }
        const nodes = (w.nodes || []).map((n) => ({ name: n.name,
          type: String(n.type || '').replace('n8n-nodes-base.', ''), position: n.position || [0, 0] }));
        // connections → edges [{from,to}]
        const edges = [];
        const conns = w.connections || {};
        for (const from of Object.keys(conns)) {
          const outs = (conns[from] && conns[from].main) || [];
          outs.forEach((arr) => (arr || []).forEach((c) => { if (c && c.node) edges.push({ from, to: c.node }); }));
        }
        resolve({ ok: true, id: w.id, name: w.name, active: !!w.active, nodes, edges });
      });
    });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function execute(env, dryRun) {
  const action = env.proposed_actions[0];
  const action_id = uid('act');

  // 킬 스위치 (docs/06 §3.6) — 실 실행 직전 차단 (dryRun은 영향 없음)
  if (!dryRun && (killed.global || killed.agents.has(env.agent)))
    return { action_id, decision_id: env.decision_id, status: 'failed',
      error: { message: 'kill_switch_active:' + (killed.global ? 'global' : env.agent) }, ts: now() };

  // create_po → ERP 어댑터(쓰기) + 결과 알림(n8n notify)
  if (action.type === 'create_po' && action.target_system === 'erp') {
    const po = erp.createPO(action.payload, { dry_run: dryRun, idempotency_key: env.decision_id });
    if (dryRun) return { action_id, decision_id: env.decision_id, status: 'skipped_dry_run', result: { erp: po }, ts: now() };
    if (po && po.po_id) poByDecision.set(env.decision_id, po.po_id); // 보상용 기록
    // 발주 완료 → 담당자 알림 (실행 레이어 체이닝)
    const note = await callN8n('notify', { request_id: uid('req'), project_id: action.payload.project_id || 'PRJ',
      user_id: action.payload.user_id || 'U', channel: 'telegram',
      message: `[SCM] 발주 생성 완료 ${po.po_id} — ${action.payload.item} x${action.payload.qty} (${action.payload.supplier_name || ''}, ${(action.payload.amount||0).toLocaleString()}원)` });
    return { action_id, decision_id: env.decision_id, status: po && po.po_id ? 'succeeded' : 'failed',
      result: { erp: po, notify: note.body || null }, ts: now() };
  }

  // n8n 직접 실행 (send_alert/report 등)
  if (action.target_system === 'n8n') {
    if (dryRun) return { action_id, decision_id: env.decision_id, status: 'skipped_dry_run',
      result: { would_call: CFG.n8nBase + '/webhook/' + mapWorkflow(env.decision), payload: action.payload }, ts: now() };
    const r = await callN8n(mapWorkflow(env.decision), action.payload);
    return { action_id, decision_id: env.decision_id, status: r.ok ? 'succeeded' : 'failed',
      result: r.body || null, error: r.ok ? undefined : { message: r.error || ('http ' + r.status), raw: r.raw }, ts: now() };
  }
  if (action.type === 'noop') return { action_id, decision_id: env.decision_id, status: 'succeeded', result: { noop: true }, ts: now() };
  return { action_id, decision_id: env.decision_id, status: 'failed', error: { message: 'adapter_not_implemented:' + action.target_system }, ts: now() };
}

// 공통 실행+감사+멱등 기록
async function runExecute(env, dryRun, actor) {
  const result = await execute(env, dryRun);
  if (!dryRun) idempotency.set(env.decision_id, result);
  const eventByStatus = { succeeded: 'executed', skipped_dry_run: 'dry_run', compensated: 'compensated', failed: 'failed' };
  audit({ decision_id: env.decision_id, action_id: result.action_id, actor: actor || 'ai',
    event: eventByStatus[result.status] || 'failed', summary: env.summary });
  // Remember: 결정→행동→결과를 업무기억에 적재 (자가향상 루프, docs/05 §3)
  if (!dryRun) memory.remember('task_memory', { agent: env.agent, decision: env.decision,
    summary: env.summary, confidence: env.confidence, status: result.status,
    value: ((env.proposed_actions[0] || {}).payload || {}).amount, actor: actor || 'ai' });
  return result;
}

// ───────────────────── 파이프라인 ─────────────────────
async function runInsight(req, dryRun) {
  const trace = { request_id: req.request_id, steps: [] };
  const env = judge(req);
  trace.envelope = env;
  audit({ decision_id: env.decision_id, agent: env.agent, actor: 'ai', event: 'decided', summary: env.summary, confidence: env.confidence });
  trace.steps.push({ step: 'judge', agent: env.agent, decision: env.decision, confidence: env.confidence });

  const vErr = validateEnvelope(env);
  if (vErr) { trace.steps.push({ step: 'validate', rejected: vErr });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: vErr });
    return { ok: false, reason: vErr, trace }; }

  if (idempotency.has(env.decision_id)) { trace.steps.push({ step: 'idempotency', note: 'duplicate' });
    return { ok: true, idempotent: true, result: idempotency.get(env.decision_id), trace }; }

  let level = env.approval_policy.level;
  if (level === 'rejected') { trace.steps.push({ step: 'gate', result: 'rejected' });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: env.approval_policy.reason });
    return { ok: false, reason: env.approval_policy.reason, trace }; }

  // ── 거버넌스 강제 (docs/06) ──
  // §3.4 한도: 초과 → 거부
  const grd = gov.checkGuardrails(env);
  if (grd.verdict === 'reject') { trace.steps.push({ step: 'guardrail', result: 'rejected', reason: grd.reason });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: 'guardrail: ' + grd.reason });
    return { ok: false, reason: 'guardrail: ' + grd.reason, trace }; }
  // §5 신뢰도 임계: auto인데 낮으면 승인 강제(승급)
  const conf = gov.checkConfidence(env);
  if (conf.verdict === 'escalate' && level === 'auto') {
    level = 'approval_required';
    env.approval_policy = { ...env.approval_policy, level, reason: conf.reason, escalated_from: 'auto' };
    trace.steps.push({ step: 'confidence', result: 'escalated', reason: conf.reason });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'escalated', summary: conf.reason });
  }

  if (level !== 'auto' && !dryRun) {
    // 방향1: Base44에 승인 카드 생성 (decision_id로 연결). 토큰 없으면 mock 매핑 반환.
    const card = await base44Card.createCard(env, req);
    held.set(env.decision_id, { env, req, ts: now(), card_id: card.card_id, approvals: [] });
    trace.steps.push({ step: 'gate', result: 'held_for_approval', level, reason: env.approval_policy.reason,
      requires: gov.requiredApprovals(env) });
    trace.steps.push({ step: 'base44_card', card_id: card.card_id, mock: !!card.mock });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'held_for_approval', summary: env.summary,
      value: (env.proposed_actions[0].payload || {}).amount, evidence_ref: card.card_id });
    return { ok: true, held: true, decision_id: env.decision_id, approval: env.approval_policy,
      base44_card: card, trace, note: 'Base44 승인 카드 생성. POST /approve {decision_id} 로 승인 시 실행, /reject 로 폐기' };
  }

  trace.steps.push({ step: 'gate', result: 'auto_pass' });
  const result = await runExecute(env, dryRun, 'ai');
  trace.result = result;
  trace.steps.push({ step: 'execute', status: result.status, decision: env.decision });
  return { ok: result.status === 'succeeded' || result.status === 'skipped_dry_run', result, trace };
}

// ───────────────────── STEP3: 승인 응답 루프 ─────────────────────
async function approve(decision_id, approver) {
  const h = held.get(decision_id);
  if (!h) return { ok: false, reason: 'not_found_or_already_resolved', decision_id };

  // 만료 검증 (docs/06 §1 설계원칙2) — 만료 봉투는 승인 불가, 폐기
  if (gov.isExpired(h.env, Date.now())) {
    held.delete(decision_id);
    audit({ decision_id, actor: 'bridge', event: 'expired', summary: h.env.summary });
    await base44Card.closeCard(h.card_id, 'rejected', '만료(expires_at 경과)로 자동 폐기');
    return { ok: false, reason: 'expired', decision_id };
  }
  // RBAC + SoD (docs/06 §2) — 승인자 권한·직무분리 검증
  const auth = gov.authorizeApprover(h.env, approver, h.approvals);
  if (!auth.ok) {
    audit({ decision_id, actor: approver || '(none)', event: 'approval_denied', summary: auth.reason });
    return { ok: false, reason: auth.reason, decision_id };
  }

  // 이중승인 추적
  h.approvals.push(approver);
  const need = gov.requiredApprovals(h.env);
  audit({ decision_id, actor: approver, event: 'approved', summary: `${h.approvals.length}/${need} ${h.env.summary}` });
  if (h.approvals.length < need) {
    return { ok: true, pending_more_approval: true, approvals: h.approvals.slice(), need, decision_id,
      note: `이중승인: ${h.approvals.length}/${need} — 다른 승인자 1명 더 필요` };
  }

  held.delete(decision_id);
  const result = await runExecute(h.env, false, approver);
  // 방향3: Base44 카드 닫기 (실행 성공이면 completed)
  const card = await base44Card.closeCard(h.card_id,
    result.status === 'succeeded' ? 'completed' : 'in_progress',
    `브리지 승인 실행: ${result.status} (by ${h.approvals.join(', ')})`);
  return { ok: result.status === 'succeeded', approved_by: h.approvals.slice(), result, base44_card: card };
}

// 보상 트랜잭션 (docs/06 §3, docs/04 §5) — 실행된 발주 취소
async function compensate(decision_id, actor, reason) {
  const po_id = poByDecision.get(decision_id);
  if (!po_id) return { ok: false, reason: 'no_executed_po_for_decision', decision_id };
  const r = erp.cancelPO(po_id);
  const ok = r && r.status === 'cancelled';
  idempotency.delete(decision_id); // 보상 후 재실행 가능하도록 멱등 해제
  poByDecision.delete(decision_id);
  audit({ decision_id, actor: actor || 'user', event: 'compensated', summary: `PO ${po_id} 취소: ${reason || '(사유없음)'}` });
  memory.remember('task_memory', { agent: 'bridge', decision: 'cancel_po', summary: `보상: PO ${po_id} 취소`, status: ok ? 'compensated' : 'failed', actor: actor || 'user' });
  return { ok, decision_id, po: r, compensated_by: actor || 'user' };
}
async function reject(decision_id, approver, reason) {
  const h = held.get(decision_id);
  if (!h) return { ok: false, reason: 'not_found_or_already_resolved', decision_id };
  audit({ decision_id, actor: approver || 'user', event: 'rejected_by_human', summary: reason || h.env.summary });
  held.delete(decision_id);
  // 방향3: Base44 카드 닫기 (rejected)
  const card = await base44Card.closeCard(h.card_id, 'rejected', `거부됨: ${reason || '(사유없음)'} (by ${approver || 'user'})`);
  return { ok: true, rejected_by: approver || 'user', reason: reason || null, decision_id, base44_card: card };
}

// ───────────────────────────── HTTP ─────────────────────────────
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => b += c);
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } }); }); }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, ngrok-skip-browser-warning' };
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(obj, null, 2)); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    // CORS 프리플라이트 — Base44 브라우저 앱의 승인 버튼 fetch 허용
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'GET' && u.pathname === '/health')
      return send(res, 200, { status: 'ok', service: 'axos-bridge', mode: 'mock', ts: now(), pending: held.size,
        config: { n8nBase: CFG.n8nBase, callbackUrl: CFG.callbackUrl, token_configured: !!CFG.n8nToken,
          base44: { appId: base44Card._CFG.appId, apiBase: base44Card._CFG.apiBase,
            mode: base44Card._CFG.token ? 'live' : 'mock' } } });

    if (req.method === 'POST' && u.pathname === '/insight') {
      const body = await readBody(req);
      const reqObj = { request_id: body.request_id || uid('req'), source: body.source || 'agent',
        intent: body.intent || 'unknown', query: body.query, context: body.context || {}, ts: now() };
      const dryRun = u.searchParams.get('dry_run') === '1' || body.dry_run === true;
      const out = await runInsight(reqObj, dryRun);
      return send(res, out.ok ? 200 : 422, out);
    }

    if (req.method === 'POST' && u.pathname === '/approve') {
      const body = await readBody(req);
      if (!body.decision_id) return send(res, 400, { ok: false, reason: 'decision_id required' });
      const out = await approve(body.decision_id, body.approver);
      return send(res, out.ok ? 200 : 404, out);
    }
    if (req.method === 'POST' && u.pathname === '/reject') {
      const body = await readBody(req);
      if (!body.decision_id) return send(res, 400, { ok: false, reason: 'decision_id required' });
      return send(res, 200, await reject(body.decision_id, body.approver, body.reason));
    }
    if (req.method === 'POST' && u.pathname === '/compensate') {
      const body = await readBody(req);
      if (!body.decision_id) return send(res, 400, { ok: false, reason: 'decision_id required' });
      const out = await compensate(body.decision_id, body.actor, body.reason);
      return send(res, out.ok ? 200 : 404, out);
    }
    // 킬 스위치 (docs/06 §3.6): body.agent 없으면 global
    if (req.method === 'POST' && u.pathname === '/kill') {
      const body = await readBody(req);
      if (body.agent) killed.agents.add(body.agent); else killed.global = true;
      audit({ decision_id: '-', actor: body.actor || 'ops', event: 'kill_switch_on', summary: body.agent || 'global' });
      return send(res, 200, { ok: true, killed: { global: killed.global, agents: Array.from(killed.agents) } });
    }
    if (req.method === 'POST' && u.pathname === '/unkill') {
      const body = await readBody(req);
      if (body.agent) killed.agents.delete(body.agent); else killed.global = false;
      audit({ decision_id: '-', actor: body.actor || 'ops', event: 'kill_switch_off', summary: body.agent || 'global' });
      return send(res, 200, { ok: true, killed: { global: killed.global, agents: Array.from(killed.agents) } });
    }
    if (req.method === 'GET' && u.pathname === '/pending')
      return send(res, 200, { count: held.size, pending: Array.from(held.values()).map((h) => ({
        decision_id: h.env.decision_id, agent: h.env.agent, decision: h.env.decision, summary: h.env.summary,
        approval: h.env.approval_policy, approvals: h.approvals, requires: gov.requiredApprovals(h.env), ts: h.ts })) });

    if (req.method === 'GET' && u.pathname === '/agents')
      return send(res, 200, { count: Object.keys(AGENT_REGISTRY).length, registry: AGENT_REGISTRY,
        intents: Object.keys(INTENT_ROUTE) });

    if (req.method === 'GET' && u.pathname === '/memory')
      return send(res, 200, { indexes: memory.INDEXES, stats: memory.stats() });

    if (req.method === 'GET' && u.pathname === '/audit') {
      let lines = []; try { lines = fs.readFileSync(CFG.auditFile, 'utf8').trim().split('\n').filter(Boolean); } catch (_) {}
      const n = parseInt(u.searchParams.get('n') || '20', 10);
      return send(res, 200, { count: lines.length, last: lines.slice(-n).map((l) => JSON.parse(l)) });
    }

    // STEP10 운영 지표 — 감사로그 집계 (Base44 대시보드가 소비 가능)
    if (req.method === 'GET' && u.pathname === '/metrics') {
      let recs = []; try { recs = fs.readFileSync(CFG.auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) {}
      const ev = (e) => recs.filter((r) => r.event === e).length;
      const executed = ev('executed'), decided = ev('decided');
      const byAgent = {};
      recs.filter((r) => r.event === 'decided' && r.agent).forEach((r) => { byAgent[r.agent] = (byAgent[r.agent] || 0) + 1; });
      const savedValue = recs.filter((r) => r.event === 'executed' && typeof r.value === 'number').reduce((s, r) => s + r.value, 0);
      // ROI 추정: 자동/승인 실행 1건당 표준 절감 2h × 30,000원
      const roi_saved_krw = executed * 2 * 30000;
      return send(res, 200, { ts: now(),
        totals: { decided, held: ev('held_for_approval'), approved: ev('approved'), executed,
          rejected: ev('rejected') + ev('rejected_by_human'), escalated: ev('escalated'),
          compensated: ev('compensated'), failed: ev('failed') },
        automation_rate: decided ? Number((executed / decided).toFixed(2)) : 0,
        success_rate: (executed + ev('failed')) ? Number((executed / (executed + ev('failed'))).toFixed(2)) : 1,
        decisions_by_agent: byAgent,
        roi: { auto_executed: executed, est_hours_saved: executed * 2, est_saved_krw: roi_saved_krw, transacted_value_krw: savedValue },
        kill_switch: { global: killed.global, agents: Array.from(killed.agents) },
        memory: memory.stats() });
    }

    // n8n 실행 레이어 노출 — 워크플로우 카탈로그 + 라우팅 + 실시간 헬스
    if (req.method === 'GET' && u.pathname === '/workflows') {
      const h = await getN8nHealth();
      return send(res, 200, { engine: 'n8n', base: CFG.n8nBase,
        online: h.ok, health: h.body || null, flow_api: !!CFG.n8nApiKey,
        count: engines.WORKFLOWS.length, workflows: engines.WORKFLOWS, routing: engines.DECISION_ROUTING });
    }

    // 단일 워크플로우 플로우(노드+연결) — 카드 클릭 시 n8n 플로우 표시용
    if (req.method === 'GET' && u.pathname === '/workflow') {
      const id = u.searchParams.get('id');
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const flow = await fetchWorkflowFlow(id);
      return send(res, flow.ok ? 200 : 502, flow);
    }

    // Databricks 판단 레이어 노출 — 메달리온 카탈로그 + 계보 + judge 모드
    if (req.method === 'GET' && u.pathname === '/catalog')
      return send(res, 200, { engine: 'databricks',
        judge_mode: dbxJudge.isConfigured() ? 'live' : 'mock',
        vector_search: memory.INDEXES, memory_stats: memory.stats(),
        ...engines.CATALOG });

    // Mosaic AI 예측 노출 (수요/매출/이직/불량/비용)
    if (req.method === 'GET' && u.pathname === '/predictions')
      return send(res, 200, { engine: 'databricks:mosaic_ai', ts: now(),
        predictions: engines.predictions({ scm: scmAgent, sales: salesAgent, hr: hrAgent, quality: qualityAgent, finance: financeAgent, procurement: procurementAgent }) });

    send(res, 404, { error: 'not_found', try: ['GET /health', 'POST /insight', 'POST /approve', 'POST /reject', 'POST /compensate', 'POST /kill', 'POST /unkill', 'GET /pending', 'GET /audit', 'GET /metrics', 'GET /agents', 'GET /memory', 'GET /workflows', 'GET /workflow?id=', 'GET /catalog', 'GET /predictions'] });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

server.listen(CFG.port, () => {
  console.log('[axos-bridge] mock 브리지 listening on http://localhost:' + CFG.port);
  console.log('[axos-bridge] n8n=' + CFG.n8nBase + '  callback=' + CFG.callbackUrl + '  token=' + (CFG.n8nToken ? 'set' : 'none'));
  console.log('[axos-bridge] agents: scm·procurement·sales·finance·hr·quality | memory: task/doc/conv/project(mock) | adapters: erp_mock, base44_card');
  console.log('[axos-bridge] governance: guardrail·confidence(min ' + gov.CONFIDENCE_MIN + ')·expiry·RBAC/SoD·dual-approval·kill-switch·compensation | /metrics');
});
