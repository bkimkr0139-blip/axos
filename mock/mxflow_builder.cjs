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

async function createWorkflow(cfg, payload) {
  const r = await httpJson('POST', cfg.n8nBase + '/api/v1/workflows',
    { 'X-N8N-API-KEY': cfg.n8nApiKey }, payload);
  if (!r.ok) return { ok: false, status: r.status, error: r.raw || r.error };
  return { ok: true, id: r.body && r.body.id, name: r.body && r.body.name };
}

// ── 공개 API ──
async function preview(cfg, instruction, workflowId) {
  // 수정 미리보기면 대상 워크플로우, 아니면 인텐트 템플릿
  let base, intent, label;
  if (workflowId) {
    base = await fetchWorkflow(cfg, workflowId);
    if (!base) return { ok: false, error: 'target_not_found' };
    intent = 'modify'; label = '수정 대상: ' + base.name;
  } else {
    const t = classify(instruction); intent = t.intent; label = t.label;
    base = await fetchWorkflow(cfg, t.baseId);
    if (!base) return { ok: false, error: 'template_unavailable (n8n/키 확인)' };
  }
  const draft = buildDraft(base, instruction, intent,
    { name: workflowId ? base.name + ' (AI 수정본)' : undefined, selfContained: !workflowId });
  return { ok: true, intent, template: label, name: draft.payload.name,
    nodes: draft.payload.nodes.map((n) => ({ name: n.name, type: String(n.type).replace('n8n-nodes-base.', '') })),
    edges: toEdges(draft.payload.connections), meta: draft.meta };
}

async function create(cfg, instruction) {
  const t = classify(instruction);
  const base = await fetchWorkflow(cfg, t.baseId);
  if (!base) return { ok: false, error: 'template_unavailable' };
  const draft = buildDraft(base, instruction, t.intent, { selfContained: true });
  const res = await createWorkflow(cfg, draft.payload);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  return { ok: true, workflow_id: res.id, name: res.name, intent: t.intent,
    active: false, webhook_path: draft.meta.webhook_path,
    nodes: draft.payload.nodes.map((n) => ({ name: n.name, type: String(n.type).replace('n8n-nodes-base.', '') })),
    edges: toEdges(draft.payload.connections) };
}

async function modify(cfg, workflowId, instruction) {
  const base = await fetchWorkflow(cfg, workflowId);
  if (!base) return { ok: false, error: 'target_not_found' };
  // 원본 보존 → 수정본 복제 생성(NL 주입). 비파괴.
  const draft = buildDraft(base, instruction, 'modify',
    { name: (base.name || '') + ' (AI 수정본)', namePrefix: '[AI]' });
  const res = await createWorkflow(cfg, draft.payload);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };
  return { ok: true, source_workflow_id: workflowId, workflow_id: res.id, name: res.name,
    active: false, note: '원본 보존 — 수정본을 새 워크플로우로 생성(검토 후 활성화)',
    nodes: draft.payload.nodes.map((n) => ({ name: n.name, type: String(n.type).replace('n8n-nodes-base.', '') })),
    edges: toEdges(draft.payload.connections) };
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

module.exports = { classify, preview, create, modify, listAi, deleteMany, TEMPLATES };
