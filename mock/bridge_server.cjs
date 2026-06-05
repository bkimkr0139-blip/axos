/**
 * AXOS 실행 브리지 (mock)  ─ 판단(Databricks 대체) → 브리지 → 실행(n8n)
 * ----------------------------------------------------------------------------
 * 이 mock 하나로 "판단→봉투→승인게이트→실행→감사"의 골격이 Databricks 없이 돈다.
 * live 전환 시: judge()를 Databricks Model Serving/Jobs 호출로, audit를 Delta append로 교체.
 * 계약(contracts/bridge/*)은 불변.
 *
 * 확장자 .cjs : 상위 C:\Users\User\package.json 이 "type":"module" 이므로 .js는 ESM 오류.
 *
 * 실행:  node bridge_server.cjs        (기본 포트 4100)
 * 엔드포인트:
 *   GET  /health           브리지 상태
 *   POST /insight          InsightRequest → 전체 파이프라인 실행, trace 반환
 *   GET  /audit            감사 로그(jsonl) 마지막 N건
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ───────────────────────────── 감사 ─────────────────────────────
function audit(rec) {
  const line = JSON.stringify({ audit_id: uid('aud'), ts: now(), ...rec });
  try { fs.appendFileSync(CFG.auditFile, line + '\n'); } catch (e) { /* mock: best-effort */ }
  return line;
}

// ───────────────────── 1) 판단 (Databricks mock) ─────────────────────
// intent → DecisionEnvelope. live: Databricks 추론으로 교체.
function judge(req) {
  const ctx = req.context || {};
  const base = {
    decision_id: uid('dec'),
    confidence: 0.9,
    ts: now(),
    guardrails: { expires_at: new Date(Date.now() + 3600e3).toISOString() },
  };
  const project_id = ctx.project_id || 'PRJ-DEMO';
  const user_id = ctx.user_id || 'U-DEMO';

  switch (req.intent) {
    case 'stock_risk':
      return { ...base, agent: 'scm',
        decision: 'send_alert',
        summary: '품목 ' + (ctx.item || 'A') + ' 결품 위험 — 안전재고 미달 + 리드타임 7일 + 수요 상승',
        evidence: [
          { kind: 'delta_query', ref: 'axos.gold.demand_features', detail: 'safety_stock_breach=true' },
          { kind: 'prediction', ref: 'mosaic:demand_forecast', detail: 'next_week_shortage_prob=0.82' },
          { kind: 'policy', ref: 'doc:reorder_policy_v3', detail: 'reorder_point rule' },
        ],
        proposed_actions: [{
          type: 'send_alert', target_system: 'n8n', dry_run_supported: true,
          payload: { request_id: uid('req'), project_id, user_id,
            message: '[SCM] 품목 ' + (ctx.item || 'A') + ' 결품 위험. 발주 검토 권장(권장수량 500).',
            channel: ctx.channel || 'telegram' },
        }],
        approval_policy: { level: 'auto', reason: '내부 알림(되돌릴 수 있음)' },
      };
    case 'cost_anomaly':
      return { ...base, agent: 'finance',
        decision: 'send_alert',
        summary: '이번달 클라우드 비용 임계 초과 추세',
        evidence: [{ kind: 'metric', ref: 'axos.gold.cost_daily', detail: 'mtd_vs_budget=+18%' }],
        proposed_actions: [{
          type: 'send_alert', target_system: 'n8n', dry_run_supported: true,
          payload: { request_id: uid('req'), project_id, user_id,
            message: '[Finance] 클라우드 비용 예산 대비 +18% 초과 추세. 검토 요망.',
            channel: ctx.channel || 'telegram' },
        }],
        approval_policy: { level: 'auto', reason: '내부 경보' },
      };
    case 'create_po_demo':
      // 승인 게이트가 작동함을 보이는 경로: 자동 실행되지 않고 held 된다.
      return { ...base, agent: 'procurement', confidence: 0.86,
        decision: 'create_po',
        summary: '품목 ' + (ctx.item || 'A') + ' 500개 발주 권장 (공급사 B)',
        evidence: [{ kind: 'prediction', ref: 'mosaic:demand_forecast', detail: 'shortage' },
                   { kind: 'metric', ref: 'axos.gold.supplier_perf', detail: 'B: 납기안정+단가-3%' }],
        proposed_actions: [{
          type: 'create_po', target_system: 'erp', dry_run_supported: true,
          payload: { item: ctx.item || 'A', qty: 500, supplier: 'B', amount: 5000000 },
          compensation: { type: 'cancel_po' },
        }],
        approval_policy: { level: 'approval_required', reason: '외부 쓰기 + 금액 임계', approvers: ['role:procurement_approver'] },
        guardrails: { amount_limit: 10000000, qty_limit: 1000, expires_at: base.guardrails.expires_at },
      };
    default:
      return { ...base, agent: 'copilot', decision: 'noop', confidence: 0.0,
        summary: 'unknown intent: ' + req.intent,
        evidence: [{ kind: 'policy', ref: 'bridge:default', detail: 'no rule' }],
        proposed_actions: [{ type: 'noop', target_system: 'base44', payload: {} }],
        approval_policy: { level: 'rejected', reason: 'no matching judgment rule' } };
  }
}

// ───────────────────── 2) 거버넌스/검증 게이트 ─────────────────────
function validateEnvelope(env) {
  if (!env.evidence || env.evidence.length === 0) return 'evidence_required'; // 근거 없는 결정 금지
  if (typeof env.confidence !== 'number') return 'confidence_required';
  if (!env.proposed_actions || env.proposed_actions.length === 0) return 'actions_required';
  return null;
}

// ───────────────────── 3) 실행 (n8n 호출) ─────────────────────
function postJson(urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad_url:' + urlStr }); }
    const data = Buffer.from(JSON.stringify(bodyObj));
    const opts = { method: 'POST', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } };
    const req = http.request(opts, (res) => {
      let buf = ''; res.on('data', (c) => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: buf }); });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(data); req.end();
  });
}

async function execute(env, dryRun) {
  const action = env.proposed_actions[0];
  const actionReq = {
    action_id: uid('act'), decision_id: env.decision_id, workflow: mapWorkflow(env.decision),
    target_system: action.target_system, payload: action.payload, dry_run: !!dryRun,
    callback_url: CFG.callbackUrl, ts: now(),
  };
  if (dryRun) {
    return { action_id: actionReq.action_id, decision_id: env.decision_id, status: 'skipped_dry_run',
      result: { would_call: CFG.n8nBase + '/webhook/' + actionReq.workflow, payload: action.payload }, ts: now() };
  }
  if (action.target_system === 'n8n') {
    const url = CFG.n8nBase + '/webhook/' + actionReq.workflow;
    const body = { ...action.payload, callback_url: CFG.callbackUrl };
    const r = await postJson(url, { Authorization: 'Bearer ' + CFG.n8nToken }, body);
    return { action_id: actionReq.action_id, decision_id: env.decision_id,
      status: r.ok ? 'succeeded' : 'failed', result: r.body || null,
      error: r.ok ? undefined : { message: r.error || ('http ' + r.status), raw: r.raw }, ts: now() };
  }
  // ERP 등 미구현 어댑터: 계약상 자리만, 실제 호출은 추후
  return { action_id: actionReq.action_id, decision_id: env.decision_id, status: 'failed',
    error: { message: 'adapter_not_implemented:' + action.target_system }, ts: now() };
}

function mapWorkflow(decision) {
  const m = { send_alert: 'notify', generate_report: 'report-generate', index_document: 'document-ingest',
    reindex_vector: 'vector-reindex', rag_answer: 'rag-chat', route_llm: 'llm-route',
    check_wbs_delay: 'wbs-delay-check', simulate_eval: 'evaluation-simulate' };
  return m[decision] || 'notify';
}

// ───────────────────── 파이프라인 오케스트레이션 ─────────────────────
async function runInsight(req, dryRun) {
  const trace = { request_id: req.request_id, steps: [] };

  // 1. 판단
  const env = judge(req);
  trace.envelope = env;
  audit({ decision_id: env.decision_id, agent: env.agent, actor: 'ai', event: 'decided',
    summary: env.summary, confidence: env.confidence });
  trace.steps.push({ step: 'judge', decision: env.decision, confidence: env.confidence });

  // 2. 검증
  const vErr = validateEnvelope(env);
  if (vErr) { trace.steps.push({ step: 'validate', rejected: vErr });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: vErr });
    return { ok: false, reason: vErr, trace }; }

  // 3. 멱등성
  if (idempotency.has(env.decision_id)) {
    trace.steps.push({ step: 'idempotency', note: 'duplicate, returning prior result' });
    return { ok: true, idempotent: true, result: idempotency.get(env.decision_id), trace };
  }

  // 4. 승인 게이트
  const level = env.approval_policy.level;
  if (level === 'rejected') { trace.steps.push({ step: 'gate', result: 'rejected' });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'rejected', summary: env.approval_policy.reason });
    return { ok: false, reason: env.approval_policy.reason, trace }; }
  if (level !== 'auto' && !dryRun) {
    trace.steps.push({ step: 'gate', result: 'held_for_approval', level, reason: env.approval_policy.reason });
    audit({ decision_id: env.decision_id, actor: 'bridge', event: 'held_for_approval',
      summary: env.summary, value: (env.proposed_actions[0].payload || {}).amount });
    return { ok: true, held: true, approval: env.approval_policy, trace,
      note: '승인 필요 — Base44 승인 카드/08 notify로 승인요청 발송 후, 승인 응답 시 execute (현 mock은 보류까지만)' };
  }

  // 5. 실행
  trace.steps.push({ step: 'gate', result: 'auto_pass' });
  const result = await execute(env, dryRun);
  idempotency.set(env.decision_id, result);
  trace.result = result;
  trace.steps.push({ step: 'execute', status: result.status, workflow: mapWorkflow(env.decision) });
  const eventByStatus = { succeeded: 'executed', skipped_dry_run: 'dry_run', compensated: 'compensated', failed: 'failed' };
  audit({ decision_id: env.decision_id, action_id: result.action_id, actor: 'ai',
    event: eventByStatus[result.status] || 'failed', summary: env.summary });

  return { ok: result.status === 'succeeded' || result.status === 'skipped_dry_run', result, trace };
}

// ───────────────────────────── HTTP 서버 ─────────────────────────────
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } }); });
}
function send(res, code, obj) { const s = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/health') {
    return send(res, 200, { status: 'ok', service: 'axos-bridge', mode: 'mock', ts: now(),
      config: { n8nBase: CFG.n8nBase, callbackUrl: CFG.callbackUrl, token_configured: !!CFG.n8nToken } });
  }
  if (req.method === 'POST' && u.pathname === '/insight') {
    const body = await readBody(req);
    const reqObj = { request_id: body.request_id || uid('req'), source: body.source || 'agent',
      intent: body.intent || 'unknown', query: body.query, context: body.context || {}, ts: now() };
    const dryRun = u.searchParams.get('dry_run') === '1' || body.dry_run === true;
    try { const out = await runInsight(reqObj, dryRun); return send(res, out.ok ? 200 : 422, out); }
    catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && u.pathname === '/audit') {
    let lines = []; try { lines = fs.readFileSync(CFG.auditFile, 'utf8').trim().split('\n').filter(Boolean); } catch (_) {}
    const n = parseInt(u.searchParams.get('n') || '20', 10);
    return send(res, 200, { count: lines.length, last: lines.slice(-n).map((l) => JSON.parse(l)) });
  }
  send(res, 404, { error: 'not_found', try: ['GET /health', 'POST /insight', 'GET /audit'] });
});

server.listen(CFG.port, () => {
  console.log('[axos-bridge] mock 브리지 listening on http://localhost:' + CFG.port);
  console.log('[axos-bridge] n8n=' + CFG.n8nBase + '  callback=' + CFG.callbackUrl + '  token=' + (CFG.n8nToken ? 'set' : 'none'));
  console.log('[axos-bridge] try: POST /insight {"intent":"stock_risk"}  | dry_run: /insight?dry_run=1');
});
