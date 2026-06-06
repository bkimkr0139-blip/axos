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

// 실제 이메일 발송 — 등록된 SMTP 자격증명(Gmail) 재사용. 더미/시뮬레이션 금지.
const EMAIL = {
  credId: process.env.AXOS_SMTP_CRED_ID || '9ocJakHheQojhfiT',
  credName: process.env.AXOS_SMTP_CRED_NAME || 'SMTP account 2',
  from: process.env.AXOS_EMAIL_FROM || 'BC Kim <bkimkr0139@gmail.com>',
  defaultTo: process.env.AXOS_EMAIL_DEFAULT_TO || 'bckim@wizbase.co.kr',
};
function isEmailIntent(s) { return /메일|이메일|e-?mail|smtp|gmail|발송|보내|send\s*(an?\s*)?(test\s*)?e?-?mail/i.test(String(s || '')); }
function emailSendNode(pos) {
  return { parameters: { fromEmail: EMAIL.from, toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
      emailFormat: 'text', text: '={{ $json.body }}', options: { appendAttribution: false } },
    id: uid(), name: 'Send Email (SMTP)', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: pos,
    credentials: { smtp: { id: EMAIL.credId, name: EMAIL.credName } } };
}

// n8n Code 노드 샌드박스 규칙 (생성/수정 공통) — process.env 등 미지원 → 실행 실패 방지
const N8N_CODE_RULES = [
  'n8n Code node sandbox — STRICT RULES (violating these makes the workflow fail at runtime):',
  '- NO process, NO process.env, NO require(), NO import, NO fs, NO __dirname. These are NOT defined in n8n Code nodes.',
  '- Available: $input.all() (array of {json}), $json, standard JS (Math, Date, JSON, Array, etc.),',
  '  and await this.helpers.httpRequest({ method, url, headers, body, json:true }) for HTTP.',
  '- API keys / secrets are NOT in process.env. If a task needs an API key or credential, declare it as a literal placeholder at the top,',
  "  e.g. const API_KEY = 'REPLACE_WITH_KEY';  then: if (API_KEY === 'REPLACE_WITH_KEY') return [{ json: { simulated: true, note: 'API 키 미설정 — 실제 호출 생략(시뮬레이션)', ...preparedData } }];",
  '  Only call the external API when the placeholder has been replaced. This way the workflow ALWAYS runs without throwing.',
  '- Every Code node MUST end with: return [{ json: {...} }];',
].join('\n');
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
  N8N_CODE_RULES,
  'COMMON FIX: if the error is "process is not defined", the code used process.env — replace it per the placeholder rule above so it runs.',
  'Output ONLY minified JSON: {"name":"<workflow name>","steps":[{"name":"<step, NO # numbers>","code":"<javascript>"}]}',
  'Fix common errors (undefined vars, process.env, JSON parse, missing await, wrong return shape). Keep it runnable. Korean names allowed. JSON only, no markdown.',
].join('\n');

async function modify(cfg, workflowId, instruction) {
  const wf = await fetchWorkflow(cfg, workflowId);
  if (!wf) return { ok: false, error: 'target_not_found' };
  // 안전 가드: AI 생성 워크플로우만 수정(운영 파이프라인 보호)
  if (!String(wf.name || '').startsWith('[AI]'))
    return { ok: false, error: 'protected (AI 생성 워크플로우만 AI 수정 가능)' };

  const hadEmail = (wf.nodes || []).some((n) => String(n.type).endsWith('.emailSend')) || isEmailIntent(wf.name) || isEmailIntent(instruction);
  const codes = (wf.nodes || []).filter((n) => String(n.type).endsWith('.code'))
    .map((n, i) => '[' + (i + 1) + '] ' + n.name + ':\n' + ((n.parameters || {}).jsCode || ''));
  const emailNote = hadEmail
    ? '\n\n[중요] 이것은 이메일 워크플로우다. 너의 마지막 Code 스텝은 반드시 return [{ json: { to, subject, body } }] 형태여야 한다. 직접 발송하지 마라(process.env/SMTP 금지). AXOS가 실제 Email Send 노드를 뒤에 자동으로 붙인다.'
    : '';
  const userMsg = '현재 워크플로우 이름: ' + wf.name + '\n\n현재 Code 노드:\n'
    + (codes.join('\n\n') || '(코드 노드 없음)') + emailNote + '\n\n사용자 보고(에러/수정 요청):\n' + instruction;

  const out = await llm.complete(FIX_SYSTEM, userMsg, 60000);
  if (!out.ok) return { ok: false, error: 'llm_fix_failed: ' + out.error };
  const spec = extractJson(out.text);
  const steps = (spec && Array.isArray(spec.steps) ? spec.steps : [])
    .filter((s) => s && typeof s.code === 'string' && s.code.trim()).slice(0, 4);
  if (!steps.length) return { ok: false, error: 'llm_unparseable_fix' };

  const built = buildFromSteps(wf.name, steps, { appendEmail: hadEmail }); // 이름 유지(제자리), 이메일이면 실발송 노드 재부착
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
  'It can read previous step output via $input.all().',
  N8N_CODE_RULES,
  'Write REAL, working logic that actually performs the task (compute, transform, fetch, format) — do NOT just echo text.',
  'Output ONLY valid minified JSON, no markdown, with shape:',
  '{"name":"<short workflow name>","steps":[{"name":"<step name, NO # numbers>","code":"<javascript>"}]}',
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

// 스텝(코드) 배열 → manualTrigger + code 체인 n8n 노드/연결. appendEmail=true면 끝에 실제 발송 Email Send 노드 추가.
function buildFromSteps(name, steps, opts) {
  opts = opts || {};
  const manual = { parameters: {}, id: uid(), name: 'When clicking Execute',
    type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [240, 300] };
  const nodes = [manual]; const connections = {}; let prev = manual; let x = 480;
  steps.forEach((st, i) => {
    // 이름 정리: 누적된 " #N" 접미 제거(수정 반복 시 '#1 #1 #1' 오염 방지)
    const clean = String(st.name || ('Step ' + (i + 1))).replace(/(\s*#\d+)+\s*$/g, '').trim().slice(0, 40) || ('Step ' + (i + 1));
    const node = { parameters: { jsCode: String(st.code || 'return $input.all();') },
      id: uid(), name: clean + ' #' + (i + 1), type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 300] };
    nodes.push(node);
    connections[prev.name] = { main: [[{ node: node.name, type: 'main', index: 0 }]] };
    prev = node; x += 240;
  });
  if (opts.appendEmail) { // 마지막 Code는 {to,subject,body} 반환 → 실제 SMTP 발송
    const en = emailSendNode([x, 300]);
    nodes.push(en);
    connections[prev.name] = { main: [[{ node: en.name, type: 'main', index: 0 }]] };
  }
  return { name, nodes, connections };
}

// 이메일 워크플로우 전용 — LLM은 {to,subject,body} 준비 스텝만 생성, AXOS가 실제 Email Send 노드 자동 추가
const EMAIL_GEN_SYSTEM = [
  'You design the DATA-PREPARATION steps for an n8n EMAIL workflow (the user wants to send a real email).',
  'Produce 1-2 Code-node steps; the FINAL step MUST return [{ json: { to, subject, body } }] with values extracted from the task.',
  "If no recipient is specified, use to: '" + EMAIL.defaultTo + "'. Make subject/body meaningful for the task (Korean ok).",
  'Do NOT send the email yourself, do NOT use process.env / SMTP / SendGrid / fetch. AXOS appends a REAL Email Send node',
  '(registered Gmail SMTP) right after your last step, which sends using { to, subject, body }.',
  N8N_CODE_RULES,
  'Output ONLY minified JSON: {"name":"<name>","steps":[{"name":"<step, NO #>","code":"<javascript>"}]}. JSON only.',
].join('\n');

// 자연어 → 실제 워크플로우(LLM). 실패 시 null(상위에서 템플릿 폴백).
async function aiGenerate(instruction) {
  const emailMode = isEmailIntent(instruction);
  const out = await llm.complete(emailMode ? EMAIL_GEN_SYSTEM : GEN_SYSTEM, '작업 지시: ' + instruction, 60000);
  if (!out.ok) return { ok: false, error: out.error };
  const spec = extractJson(out.text);
  if (!spec || !Array.isArray(spec.steps) || !spec.steps.length) return { ok: false, error: 'llm_unparseable' };
  const steps = spec.steps.filter((s) => s && typeof s.code === 'string' && s.code.trim()).slice(0, 4);
  if (!steps.length) return { ok: false, error: 'no_valid_steps' };
  const built = buildFromSteps(spec.name || instruction.slice(0, 40), steps, { appendEmail: emailMode });
  return { ok: true, email: emailMode, payload: { name: built.name, nodes: built.nodes, connections: built.connections, settings: { executionOrder: 'v1' } },
    engine: 'llm:' + (out.provider || '') + (out.fallback_from ? '(fallback from ' + out.fallback_from + ')' : ''), model: out.model };
}

// 앱 내 실행 — [AI] 워크플로우의 Code 로직을 임시 webhook으로 감싸 실제 실행, 결과/실행오류 반환.
// (생성물은 Manual Trigger라 API 직접 실행 불가 → 임시 webhook 래퍼로 즉시 실행 후 삭제)
async function runWorkflow(cfg, workflowId) {
  const wf = await fetchWorkflow(cfg, workflowId);
  if (!wf) return { ok: false, error: 'not_found' };
  if (!String(wf.name || '').startsWith('[AI]')) return { ok: false, error: 'protected (AI 워크플로우만 실행)' };
  // 트리거를 제외한 모든 노드를 그대로 실행(emailSend 등 자격증명 보존) → webhook으로 트리거 치환, 끝에 respond
  const isTrigger = (n) => /(manualTrigger|^.*\.webhook$|executeWorkflowTrigger|scheduleTrigger|\.cron)/i.test(String(n.type)) || /trigger$/i.test(String(n.type));
  const trigger = (wf.nodes || []).find(isTrigger);
  const others = (wf.nodes || []).filter((n) => !isTrigger(n)).map((n) => JSON.parse(JSON.stringify(n)));
  if (!others.length) return { ok: false, error: 'no_runnable_nodes' };
  const path = 'run-' + uid().slice(0, 8);
  const webhook = { parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} },
    id: uid(), name: 'WH(run)', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [120, 300], webhookId: path };
  const conns = {};
  for (const [from, val] of Object.entries(wf.connections || {})) {
    if (trigger && from === trigger.name) conns[webhook.name] = val; // 트리거→X 를 webhook→X 로
    else conns[from] = val;
  }
  if (!conns[webhook.name] && others[0]) conns[webhook.name] = { main: [[{ node: others[0].name, type: 'main', index: 0 }]] };
  const hasOut = new Set(Object.keys(conns));
  const terminal = others.find((n) => !hasOut.has(n.name)) || others[others.length - 1];
  const respond = { parameters: { respondWith: 'json', responseBody: '={{ $json }}' },
    id: uid(), name: 'RP(run)', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5, position: [1200, 300] };
  conns[terminal.name] = { main: [[{ node: respond.name, type: 'main', index: 0 }]] };
  const temp = await createWorkflow(cfg, { name: '[AI-RUN-TEMP] ' + path, nodes: [webhook, ...others, respond], connections: conns, settings: { executionOrder: 'v1' } });
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
