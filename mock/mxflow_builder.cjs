/**
 * MX-Flow AI 빌더 — 자연어 → n8n 워크플로우 생성/수정 (AI 어시스트 백엔드).
 * ----------------------------------------------------------------------------
 * 안전 원칙:
 *  - 생성물은 검증된 기존 워크플로우를 "복제 + 파라미터 주입"해 만든다(노드/타입버전 유효성 보장).
 *  - 생성 워크플로우는 항상 inactive + 이름 "[AI]" 접두어 → 운영 파이프라인에 영향 없음.
 *  - 수정(modify)은 원본을 변경하지 않고 "수정본 복제"를 새로 만든다.
 *  - 실제 쓰기(create)는 브리지에서 거버넌스(killswitch)·감사로 감싼다.
 * LLM 연동(선택): ANTHROPIC_API_KEY 가 있으면 코드노드 로직을 LLM으로 생성(없으면 템플릿 주입).
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const llm = require('./llm.cjs');
const uid = () => crypto.randomUUID();
const slug = (s) => (s || 'ai').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ai';

// 인텐트 → 복제 기반 템플릿(n8n 실제 워크플로우 id). engines.WORKFLOWS와 정합.
const TEMPLATES = [
  { intent: 'notify', baseId: 'q3hKK18G4WV88AC9', label: '알림(notify)',
    kw: ['알림', '통지', 'notify', '텔레그램', '메일', '경보', 'alert'] },
  { intent: 'report', baseId: 'ceOeKkZS7jSHqJbE', label: '리포트 생성(report-generate)',
    kw: ['리포트', '보고서', 'report', '요약본'] },
  { intent: 'rag', baseId: 'l5FiRxpbkoQv7Jlq', label: 'RAG 응답(rag-chat)',
    kw: ['rag', '질의', '챗', 'chat', '검색응답'] },
  { intent: 'llm', baseId: 'Qmx5AEi25ybBlkwg', label: 'LLM 라우팅(llm-route)',
    kw: ['llm', '요약', '분류', '생성', '라우팅'] },
  { intent: 'health', baseId: '54x25z8fKKCrd1Ab', label: '기본(헬스/웹훅 골격)',
    kw: ['웹훅', 'webhook', '기본', '골격', 'http'] },
];

function classify(instruction) {
  const m = (instruction || '').toLowerCase();
  let best = TEMPLATES[0], score = 0;
  for (const t of TEMPLATES) {
    const s = t.kw.reduce((a, k) => a + (m.includes(k.toLowerCase()) ? 1 : 0), 0);
    if (s > score) { best = t; score = s; }
  }
  return { ...best, matched: score };
}

function httpJson(method, urlStr, headers, bodyObj) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const opts = { method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } };
    const req = http.request(opts, (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: b }); }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (data) req.write(data); req.end();
  });
}

async function fetchWorkflow(cfg, id) {
  const r = await httpJson('GET', cfg.n8nBase + '/api/v1/workflows/' + id, { 'X-N8N-API-KEY': cfg.n8nApiKey });
  return r.ok ? r.body : null;
}

// 노드/연결 → 간단 엣지(미리보기용)
function toEdges(connections) {
  const edges = [];
  for (const from of Object.keys(connections || {})) {
    for (const arr of ((connections[from] || {}).main || [])) {
      for (const c of (arr || [])) if (c && c.node) edges.push({ from, to: c.node });
    }
  }
  return edges;
}

// 실행 가능형: Manual Trigger → Code. 에디터에서 "Execute Workflow" 클릭 시 webhook 대기 없이 즉시 실행.
// (Webhook 트리거는 테스트 시 'Listening for test event' 무한 대기 → 클릭 실행 불가하므로 수동 트리거 사용)
// code 노드는 템플릿에서 복제해 typeVersion 호환 보장. webhook/외부 노드는 제거.
function selfContain(nodes, connections) {
  const code = nodes.find((n) => String(n.type || '') === 'n8n-nodes-base.code');
  if (!code) return { nodes, connections }; // 코드노드 없으면 원본 유지
  const codeNode = JSON.parse(JSON.stringify(code));
  codeNode.id = uid(); codeNode.name = 'Code'; codeNode.position = [520, 300];
  const manual = { parameters: {}, id: uid(), name: 'When clicking Execute',
    type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [280, 300] };
  const conns = {};
  conns[manual.name] = { main: [[{ node: codeNode.name, type: 'main', index: 0 }]] };
  return { nodes: [manual, codeNode], connections: conns };
}

// 복제 기반 드래프트: 검증된 base에서 name/webhook path/code 메시지 주입
function buildDraft(base, instruction, intent, opts) {
  opts = opts || {};
  let nodes = JSON.parse(JSON.stringify(base.nodes || []));
  let connections = base.connections || {};
  if (opts.selfContained) {
    const sc = selfContain(nodes, connections);
    nodes = sc.nodes; connections = sc.connections;
  }
  const newPath = (opts.pathPrefix || 'ai') + '-' + slug(instruction) + '-' + uid().slice(0, 6);
  let injectedInto = null;
  for (const n of nodes) {
    const t = String(n.type || '');
    if (t.endsWith('webhook')) {                       // 웹훅 경로 고유화(충돌 방지)
      n.parameters = n.parameters || {}; n.parameters.path = newPath;
      n.webhookId = uid();
    }
    if (t.endsWith('.code') && !injectedInto) {        // 첫 코드노드에 NL 의도 주입
      n.parameters = n.parameters || {};
      const safeMsg = String(instruction || '').replace(/`/g, "'").slice(0, 500);
      n.parameters.jsCode =
        "// [AI 생성] 사용자 지시: " + safeMsg + "\n" +
        "return [{ json: { ok: true, generated_by: 'axos-ai-assist', instruction: " + JSON.stringify(safeMsg) + " } }];";
      injectedInto = n.name;
    }
  }
  const prefix = opts.namePrefix || '[AI]';
  const baseName = opts.name || (instruction || 'workflow').slice(0, 40);
  const name = baseName.trim().startsWith(prefix) ? baseName : prefix + ' ' + baseName;
  const hasWebhook = nodes.some((n) => String(n.type || '').endsWith('webhook'));
  return {
    payload: { name, nodes, connections, settings: base.settings || { executionOrder: 'v1' } },
    meta: { intent, trigger: hasWebhook ? 'webhook' : 'manual',
      webhook_path: hasWebhook ? newPath : null, injected_code_node: injectedInto,
      self_contained: !!opts.selfContained },
  };
}

async function updateWorkflow(cfg, id, payload) {
  return httpJson('PUT', cfg.n8nBase + '/api/v1/workflows/' + id, { 'X-N8N-API-KEY': cfg.n8nApiKey }, payload);
}
async function deactivate(cfg, id) {
  return httpJson('POST', cfg.n8nBase + '/api/v1/workflows/' + id + '/deactivate', { 'X-N8N-API-KEY': cfg.n8nApiKey });
}
async function createWorkflow(cfg, payload) {
  const r = await httpJson('POST', cfg.n8nBase + '/api/v1/workflows',
    { 'X-N8N-API-KEY': cfg.n8nApiKey }, payload);
  if (!r.ok) return { ok: false, status: r.status, error: r.raw || r.error };
  return { ok: true, id: r.body && r.body.id, name: r.body && r.body.name };
}

// 반환용 노드 요약 (코드 노드는 첫 의미 라인)
function nodeBrief(n) {
  const type = String(n.type || '').replace('n8n-nodes-base.', '');
  let detail;
  if (type === 'code') {
    const l = String((n.parameters || {}).jsCode || '').split('\n').find((x) => x.trim() && !x.trim().startsWith('//'));
    detail = (l || 'code').trim().slice(0, 90);
  }
  return { name: n.name, type, detail };
}
function aiAName(name, instruction) {
  const base = name || (instruction || 'workflow').slice(0, 40);
  return String(base).trim().startsWith('[AI]') ? base : '[AI] ' + base;
}

// ── 공개 API ──
async function preview(cfg, instruction, workflowId) {
  // 신규(미수정)면 LLM 생성 우선
  if (!workflowId) {
    const gen = await aiGenerate(instruction);
    if (gen.ok) {
      return { ok: true, intent: 'llm', engine: gen.engine, model: gen.model,
        name: aiAName(gen.payload.name, instruction),
        nodes: gen.payload.nodes.map(nodeBrief), edges: toEdges(gen.payload.connections),
        meta: { trigger: 'manual', engine: gen.engine } };
    }
    // 폴백: 템플릿
    const t = classify(instruction);
    const base = await fetchWorkflow(cfg, t.baseId);
    if (!base) return { ok: false, error: 'llm_failed_and_no_template: ' + gen.error };
    const draft = buildDraft(base, instruction, t.intent, { selfContained: true });
    return { ok: true, intent: t.intent, engine: 'template(fallback): ' + gen.error, template: t.label,
      name: aiAName(draft.payload.name, instruction), nodes: draft.payload.nodes.map(nodeBrief),
      edges: toEdges(draft.payload.connections), meta: draft.meta };
  }
  // 수정 미리보기
  const base = await fetchWorkflow(cfg, workflowId);
  if (!base) return { ok: false, error: 'target_not_found' };
  const draft = buildDraft(base, instruction, 'modify', { name: base.name + ' (AI 수정본)' });
  return { ok: true, intent: 'modify', template: '수정 대상: ' + base.name, name: draft.payload.name,
    nodes: draft.payload.nodes.map(nodeBrief), edges: toEdges(draft.payload.connections), meta: draft.meta };
}

async function create(cfg, instruction) {
  let payload, engine = 'template', model;
  const gen = await aiGenerate(instruction);
  if (gen.ok) { payload = gen.payload; engine = gen.engine; model = gen.model; }
  else {
    const t = classify(instruction);
    const base = await fetchWorkflow(cfg, t.baseId);
    if (!base) return { ok: false, error: 'llm_failed_and_no_template: ' + gen.error };
    payload = buildDraft(base, instruction, t.intent, { selfContained: true }).payload;
    engine = 'template(fallback): ' + gen.error;
  }
  payload.name = aiAName(payload.name, instruction);
  const res = await createWorkflow(cfg, payload);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  return { ok: true, workflow_id: res.id, name: res.name, engine, model, active: false,
    nodes: payload.nodes.map(nodeBrief), edges: toEdges(payload.connections) };
}

// AI 오류 수정/개선 — 현재 코드 + 에러/지시를 LLM에 주고 수정본으로 제자리 업데이트
const FIX_SYSTEM = [
  'You are fixing/improving an existing n8n workflow. You are given the current Code-node scripts (in order) and the user report,',
  'which may be an n8n ERROR MESSAGE and/or a change request. Diagnose and FIX the issue, and apply requested changes.',
  'Output ONLY minified JSON: {"name":"<workflow name>","steps":[{"name":"<step>","code":"<javascript>"}]}',
  'Each Code node is n8n JS (Run Once for All Items), MUST end with: return [{ json: {...} }];  Read prior step output via $input.all().',
  'For HTTP use: await this.helpers.httpRequest({method,url,body,json:true}). Fix common errors (undefined vars, JSON parse, await, return shape).',
  'Keep it runnable. Korean names allowed. JSON only, no markdown.',
].join('\n');

async function modify(cfg, workflowId, instruction) {
  const wf = await fetchWorkflow(cfg, workflowId);
  if (!wf) return { ok: false, error: 'target_not_found' };
  // 안전 가드: AI 생성 워크플로우만 수정(운영 파이프라인 보호)
  if (!String(wf.name || '').startsWith('[AI]'))
    return { ok: false, error: 'protected (AI 생성 워크플로우만 AI 수정 가능)' };

  const codes = (wf.nodes || []).filter((n) => String(n.type).endsWith('.code'))
    .map((n, i) => '[' + (i + 1) + '] ' + n.name + ':\n' + ((n.parameters || {}).jsCode || ''));
  const userMsg = '현재 워크플로우 이름: ' + wf.name + '\n\n현재 Code 노드:\n'
    + (codes.join('\n\n') || '(코드 노드 없음)') + '\n\n사용자 보고(에러/수정 요청):\n' + instruction;

  const out = await llm.complete(FIX_SYSTEM, userMsg, 60000);
  if (!out.ok) return { ok: false, error: 'llm_fix_failed: ' + out.error };
  const spec = extractJson(out.text);
  const steps = (spec && Array.isArray(spec.steps) ? spec.steps : [])
    .filter((s) => s && typeof s.code === 'string' && s.code.trim()).slice(0, 4);
  if (!steps.length) return { ok: false, error: 'llm_unparseable_fix' };

  const built = buildFromSteps(wf.name, steps); // 이름 유지(제자리)
  const payload = { name: wf.name, nodes: built.nodes, connections: built.connections, settings: wf.settings || { executionOrder: 'v1' } };
  if (wf.active) await deactivate(cfg, workflowId); // 활성 워크플로우는 수정 위해 비활성화(재검토 후 재활성)
  const upd = await updateWorkflow(cfg, workflowId, payload);
  if (!upd.ok) return { ok: false, error: upd.raw || upd.error, status: upd.status };
  return { ok: true, workflow_id: workflowId, name: wf.name, in_place: true, active: false,
    engine: 'llm:' + (out.provider || '') + (out.fallback_from ? '(fallback from ' + out.fallback_from + ')' : ''), model: out.model,
    note: '제자리 수정 완료(원본 id 유지). 비활성 상태이니 n8n에서 재실행/검토 후 활성화하세요.',
    nodes: built.nodes.map(nodeBrief), edges: toEdges(built.connections) };
}

// ── LLM 기반 실제 워크플로우 생성 ──
const GEN_SYSTEM = [
  'You are an expert n8n workflow engineer. Design a RUNNABLE n8n workflow that starts with a Manual Trigger.',
  'Decompose the user task into 1 to 4 sequential steps. EACH step is an n8n "Code" node (JavaScript, mode "Run Once for All Items").',
  'Each Code node MUST end with: return [{ json: {...} }];  (an array of items). It can read previous step output via $input.all() (array of {json}).',
  'For external HTTP, use: const res = await this.helpers.httpRequest({ method, url, body, json:true }); inside the code.',
  'Write REAL, working logic that actually performs the task (compute, transform, fetch, format) — do NOT just echo text.',
  'Output ONLY valid minified JSON, no markdown, with shape:',
  '{"name":"<short workflow name>","steps":[{"name":"<step name>","code":"<javascript>"}]}',
  'Keep code self-contained and safe. Korean names allowed. JSON only.',
].join('\n');

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');     // 코드펜스 제거
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { return null; }
}

// 스텝(코드) 배열 → manualTrigger + code 체인 n8n 노드/연결
function buildFromSteps(name, steps) {
  const manual = { parameters: {}, id: uid(), name: 'When clicking Execute',
    type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [240, 300] };
  const nodes = [manual]; const connections = {}; let prev = manual; let x = 480;
  steps.forEach((st, i) => {
    const nm = (st.name && String(st.name).slice(0, 40)) || ('Step ' + (i + 1));
    const node = { parameters: { jsCode: String(st.code || 'return $input.all();') },
      id: uid(), name: nm + ' #' + (i + 1), type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 300] };
    nodes.push(node);
    connections[prev.name] = { main: [[{ node: node.name, type: 'main', index: 0 }]] };
    prev = node; x += 240;
  });
  return { name, nodes, connections };
}

// 자연어 → 실제 워크플로우(LLM). 실패 시 null(상위에서 템플릿 폴백).
async function aiGenerate(instruction) {
  const out = await llm.complete(GEN_SYSTEM, '작업 지시: ' + instruction, 60000);
  if (!out.ok) return { ok: false, error: out.error };
  const spec = extractJson(out.text);
  if (!spec || !Array.isArray(spec.steps) || !spec.steps.length) return { ok: false, error: 'llm_unparseable' };
  const steps = spec.steps.filter((s) => s && typeof s.code === 'string' && s.code.trim()).slice(0, 4);
  if (!steps.length) return { ok: false, error: 'no_valid_steps' };
  const built = buildFromSteps(spec.name || instruction.slice(0, 40), steps);
  return { ok: true, payload: { name: built.name, nodes: built.nodes, connections: built.connections, settings: { executionOrder: 'v1' } },
    engine: 'llm:' + (out.provider || '') + (out.fallback_from ? '(fallback from ' + out.fallback_from + ')' : ''), model: out.model };
}

// 앱 내 실행 — [AI] 워크플로우의 Code 로직을 임시 webhook으로 감싸 실제 실행, 결과/실행오류 반환.
// (생성물은 Manual Trigger라 API 직접 실행 불가 → 임시 webhook 래퍼로 즉시 실행 후 삭제)
async function runWorkflow(cfg, workflowId) {
  const wf = await fetchWorkflow(cfg, workflowId);
  if (!wf) return { ok: false, error: 'not_found' };
  if (!String(wf.name || '').startsWith('[AI]')) return { ok: false, error: 'protected (AI 워크플로우만 실행)' };
  const codeNodes = (wf.nodes || []).filter((n) => String(n.type).endsWith('.code'));
  if (!codeNodes.length) return { ok: false, error: 'no_code_nodes' };
  const path = 'run-' + uid().slice(0, 8);
  const codes = codeNodes.map((n, i) => ({ parameters: { jsCode: (n.parameters || {}).jsCode || 'return $input.all();' },
    id: uid(), name: 'C' + (i + 1), type: 'n8n-nodes-base.code', typeVersion: 2, position: [460 + i * 200, 300] }));
  const webhook = { parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} },
    id: uid(), name: 'WH', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [240, 300], webhookId: path };
  const respond = { parameters: { respondWith: 'json', responseBody: '={{ $json }}' },
    id: uid(), name: 'RP', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5, position: [460 + codes.length * 200, 300] };
  const chain = [webhook, ...codes, respond];
  const conns = {};
  for (let i = 0; i < chain.length - 1; i++) conns[chain[i].name] = { main: [[{ node: chain[i + 1].name, type: 'main', index: 0 }]] };
  const temp = await createWorkflow(cfg, { name: '[AI-RUN-TEMP] ' + path, nodes: chain, connections: conns, settings: { executionOrder: 'v1' } });
  if (!temp.ok || !temp.id) return { ok: false, error: 'temp_create_failed: ' + (temp.error || '') };
  const nkey = { 'X-N8N-API-KEY': cfg.n8nApiKey };
  await httpJson('POST', cfg.n8nBase + '/api/v1/workflows/' + temp.id + '/activate', nkey);
  await new Promise((s) => setTimeout(s, 1500)); // webhook 등록 대기
  const hit = await httpJson('POST', cfg.n8nBase + '/webhook/' + path, {}, { trigger: 'axos-run' });
  // n8n은 코드 에러 시에도 webhook을 200 빈본문으로 닫음 → 실행 로그에서 에러 판정
  await new Promise((s) => setTimeout(s, 500));
  let execErr = null, execStatus = 'unknown';
  const list = await httpJson('GET', cfg.n8nBase + '/api/v1/executions?workflowId=' + temp.id + '&limit=1', nkey);
  const exId = list.body && list.body.data && list.body.data[0] && list.body.data[0].id;
  if (exId) {
    const ex = await httpJson('GET', cfg.n8nBase + '/api/v1/executions/' + exId + '?includeData=true', nkey);
    const eb = ex.body || {};
    execStatus = eb.status || (eb.finished ? 'success' : 'unknown');
    const rd = eb.data && eb.data.resultData;
    if (rd && rd.error) execErr = rd.error.message || (rd.error.description) || JSON.stringify(rd.error).slice(0, 400);
  }
  await httpJson('DELETE', cfg.n8nBase + '/api/v1/workflows/' + temp.id, nkey); // 임시 정리
  if (execErr || execStatus === 'error')
    return { ok: false, execution_error: String(execErr || 'execution failed').slice(0, 600), status: 'error' };
  const result = (hit.body !== null && hit.body !== undefined && hit.raw !== '') ? hit.body : null;
  return { ok: true, result, status: execStatus };
}

// AI 생성 워크플로우 목록 ([AI] 접두만)
async function listAi(cfg) {
  const r = await httpJson('GET', cfg.n8nBase + '/api/v1/workflows?limit=250', { 'X-N8N-API-KEY': cfg.n8nApiKey });
  if (!r.ok) return { ok: false, error: 'n8n_list_failed', status: r.status };
  const all = (r.body && (r.body.data || r.body)) || [];
  const items = all.filter((w) => String(w.name || '').startsWith('[AI]'))
    .map((w) => ({ id: String(w.id), name: w.name, active: !!w.active, updated_at: w.updatedAt }));
  return { ok: true, count: items.length, workflows: items };
}

// 삭제 — 안전 가드: [AI] 접두 워크플로우만 삭제(운영 파이프라인 보호). 무엇을 받아도 서버에서 검증.
async function deleteMany(cfg, ids) {
  const listed = await listAi(cfg);
  if (!listed.ok) return { ok: false, error: listed.error };
  const aiMap = new Map(listed.workflows.map((w) => [w.id, w.name]));
  const results = [];
  for (const id of (ids || [])) {
    const sid = String(id);
    if (!aiMap.has(sid)) { results.push({ id: sid, deleted: false, reason: 'protected_or_not_found(비-AI 워크플로우는 삭제 불가)' }); continue; }
    const r = await httpJson('DELETE', cfg.n8nBase + '/api/v1/workflows/' + sid, { 'X-N8N-API-KEY': cfg.n8nApiKey });
    results.push({ id: sid, name: aiMap.get(sid), deleted: r.ok, status: r.ok ? undefined : r.status });
  }
  return { ok: true, deleted: results.filter((x) => x.deleted).length, total: results.length, results };
}

module.exports = { classify, preview, create, modify, runWorkflow, listAi, deleteMany, TEMPLATES };
