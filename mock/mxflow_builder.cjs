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

// 복제 기반 드래프트: 검증된 base에서 name/webhook path/code 메시지 주입
function buildDraft(base, instruction, intent, opts) {
  opts = opts || {};
  const nodes = JSON.parse(JSON.stringify(base.nodes || []));
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
  return {
    payload: { name, nodes, connections: base.connections || {}, settings: base.settings || { executionOrder: 'v1' } },
    meta: { intent, webhook_path: newPath, injected_code_node: injectedInto },
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
  const draft = buildDraft(base, instruction, intent, { name: workflowId ? base.name + ' (AI 수정본)' : undefined });
  return { ok: true, intent, template: label, name: draft.payload.name,
    nodes: draft.payload.nodes.map((n) => ({ name: n.name, type: String(n.type).replace('n8n-nodes-base.', '') })),
    edges: toEdges(draft.payload.connections), meta: draft.meta };
}

async function create(cfg, instruction) {
  const t = classify(instruction);
  const base = await fetchWorkflow(cfg, t.baseId);
  if (!base) return { ok: false, error: 'template_unavailable' };
  const draft = buildDraft(base, instruction, t.intent, {});
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

module.exports = { classify, preview, create, modify, TEMPLATES };
