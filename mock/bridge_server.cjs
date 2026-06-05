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

const scmAgent = require('../agents/scm_agent.cjs');
const erp = require('../adapters/erp_mock.cjs');

const CFG = {
  port: parseInt(process.env.BRIDGE_PORT || '4100', 10),
  n8nBase: process.env.N8N_BASE_URL || 'http://localhost:5678',
  n8nToken: process.env.N8N_WEBHOOK_TOKEN || 'dev-local-token',
  callbackUrl: process.env.BASE44_CALLBACK_URL || 'http://localhost:4000/mock-callback',
  auditFile: path.join(__dirname, 'audit.jsonl'),
};

const now = () => new Date().toISOString();
const uid = (p) => p + '-' + crypto.randomUUID().slice(0, 8);
const idempotency = new Map(); // decision_id -> ActionResult (중복 실행 차단)
const held = new Map();        // decision_id -> { env, req, ts } (승인 대기)

// ───────────────────────────── 감사 ─────────────────────────────
function audit(rec) {
  const line = JSON.stringify({ audit_id: uid('aud'), ts: now(), ...rec });
  try { fs.appendFileSync(CFG.auditFile, line + '\n'); } catch (e) { /* best-effort */ }
  return line;
}

// ───────────────────── 1) 판단 (Agent 라우팅) ─────────────────────
// intent → agent. live: Databricks 추론으로 교체.
const INTENT_ROUTE = {
  stock_risk: scmAgent.handle, reorder: scmAgent.handle, stock_check: scmAgent.handle,
};
function judge(req) {
  const agentFn = INTENT_ROUTE[req.intent];
  if (agentFn) return agentFn(req);
  return financeOrDefault(req); // 나머지 인텐트
}
function financeOrDefault(req) {
  const ctx = req.context || {};
  const base = { decision_id: uid('dec'), confidence: 0.9, ts: now(),
    guardrails: { expires_at: new Date(Date.now() + 3600e3).toISOString() } };
  const project_id = ctx.project_id || 'PRJ-DEMO', user_id = ctx.user_id || 'U-DEMO';
  if (req.intent === 'cost_anomaly') {
    return { ...base, agent: 'finance', decision: 'send_alert', summary: '클라우드 비용 임계 초과 추세',
      evidence: [{ kind: 'metric', ref: 'axos.gold.cost_daily', detail: 'mtd_vs_budget=+18%' }],
      proposed_actions: [{ type: 'send_alert', target_system: 'n8n', dry_run_supported: true,
        payload: { request_id: uid('req'), project_id, user_id, message: '[Finance] 클라우드 비용 예산 대비 +18% 초과 추세.', channel: ctx.channel || 'telegram' } }],
      approval_policy: { level: 'auto', reason: '내부 경보' } };
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

async function execute(env, dryRun) {
  const action = env.proposed_actions[0];
  const action_id = uid('act');

  // create_po → ERP 어댑터(쓰기) + 결과 알림(n8n notify)
  if (action.type === 'create_po' && action.target_system === 'erp') {
    const po = erp.createPO(action.payload, { dry_run: dryRun, idempotency_key: env.decision_id });
    if (dryRun) return { action_id, decision_id: env.decision_id, status: 'skipped_dry_run', result: { erp: po }, ts: now() };
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

  const level = env.approval_policy.level;
  if (level === 'rejected') { trace.steps.push({ step: 'gate', result: 'rejected' });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: env.approval_policy.reason });
    return { ok: false, reason: env.approval_policy.reason, trace }; }

  if (level !== 'auto' && !dryRun) {
    held.set(env.decision_id, { env, req, ts: now() });
    trace.steps.push({ step: 'gate', result: 'held_for_approval', level, reason: env.approval_policy.reason });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'held_for_approval', summary: env.summary,
      value: (env.proposed_actions[0].payload || {}).amount });
    return { ok: true, held: true, decision_id: env.decision_id, approval: env.approval_policy, trace,
      note: 'POST /approve {decision_id} 로 승인 시 실행, /reject 로 폐기' };
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
  audit({ decision_id, actor: approver || 'user', event: 'approved', summary: h.env.summary });
  held.delete(decision_id);
  const result = await runExecute(h.env, false, approver || 'user');
  return { ok: result.status === 'succeeded', approved_by: approver || 'user', result };
}
function reject(decision_id, approver, reason) {
  const h = held.get(decision_id);
  if (!h) return { ok: false, reason: 'not_found_or_already_resolved', decision_id };
  audit({ decision_id, actor: approver || 'user', event: 'rejected_by_human', summary: reason || h.env.summary });
  held.delete(decision_id);
  return { ok: true, rejected_by: approver || 'user', reason: reason || null, decision_id };
}

// ───────────────────────────── HTTP ─────────────────────────────
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => b += c);
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && u.pathname === '/health')
      return send(res, 200, { status: 'ok', service: 'axos-bridge', mode: 'mock', ts: now(), pending: held.size,
        config: { n8nBase: CFG.n8nBase, callbackUrl: CFG.callbackUrl, token_configured: !!CFG.n8nToken } });

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
      return send(res, 200, reject(body.decision_id, body.approver, body.reason));
    }
    if (req.method === 'GET' && u.pathname === '/pending')
      return send(res, 200, { count: held.size, pending: Array.from(held.values()).map((h) => ({
        decision_id: h.env.decision_id, agent: h.env.agent, decision: h.env.decision, summary: h.env.summary,
        approval: h.env.approval_policy, ts: h.ts })) });

    if (req.method === 'GET' && u.pathname === '/audit') {
      let lines = []; try { lines = fs.readFileSync(CFG.auditFile, 'utf8').trim().split('\n').filter(Boolean); } catch (_) {}
      const n = parseInt(u.searchParams.get('n') || '20', 10);
      return send(res, 200, { count: lines.length, last: lines.slice(-n).map((l) => JSON.parse(l)) });
    }
    send(res, 404, { error: 'not_found', try: ['GET /health', 'POST /insight', 'POST /approve', 'POST /reject', 'GET /pending', 'GET /audit'] });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

server.listen(CFG.port, () => {
  console.log('[axos-bridge] mock 브리지 listening on http://localhost:' + CFG.port);
  console.log('[axos-bridge] n8n=' + CFG.n8nBase + '  callback=' + CFG.callbackUrl + '  token=' + (CFG.n8nToken ? 'set' : 'none'));
  console.log('[axos-bridge] agents: scm(stock_risk/reorder), finance(cost_anomaly) | adapters: erp_mock');
});
