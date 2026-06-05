/**
 * Base44 승인 카드 어댑터 — 브리지 승인 게이트 ↔ Base44 WorkflowRequest 엔티티
 * ----------------------------------------------------------------------------
 * 방향 1 (브리지→Base44): held(approval_required) 결정 → WorkflowRequest 카드 생성(status=pending)
 * 방향 2 (Base44→브리지): 카드 승인/거부 버튼 → 브리지 /approve|/reject {decision_id} (브리지 본체 처리)
 * 방향 3 (브리지→Base44): 실행/폐기 완료 → 카드 status 닫기(completed/rejected)
 *
 * 연결 키: decision_id. 카드의 description·comments에 decision_id를 심어 Base44 승인 버튼이 회신.
 * 토큰(BASE44_TOKEN) 미설정 시 mock 모드 — 실제 호출 대신 매핑 결과를 반환(로컬 검증용).
 * live 전환: env BASE44_TOKEN 주입(또는 DatabricksConfig/시크릿) → 동일 코드로 실 REST 호출.
 *
 * 실측 스키마(2026-06-05, MCP list_entity_schemas):
 *   WorkflowRequest{ title, type(approval|request|notification|automation),
 *     status(pending|approved|rejected|in_progress|completed), priority(low|medium|high|urgent),
 *     description, requester_name, department, assignee_name, due_date, comments[{author,text,date}] }
 */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const now = () => new Date().toISOString();

const CFG = {
  appId: process.env.BASE44_APP_ID || '6a225124042c1a7db62f27fb',
  apiBase: process.env.BASE44_API_BASE || 'https://base44.app',
  token: process.env.BASE44_TOKEN || '', // 없으면 mock 모드
};

// agent → 부서 매핑 (Base44 시드 부서명과 정합)
const DEPT = { scm: '구매팀', procurement: '구매팀', sales: '영업팀',
  finance: '재무팀', hr: '인사팀', quality: '품질팀', copilot: '경영기획팀' };

function priorityFor(env) {
  const amt = ((env.proposed_actions && env.proposed_actions[0]) || {}).payload || {};
  const v = amt.amount || 0;
  if (v >= 5000000) return 'urgent';
  if (v >= 1000000) return 'high';
  return 'medium';
}

// DecisionEnvelope → WorkflowRequest 필드
function toCard(env, req) {
  const p = ((env.proposed_actions && env.proposed_actions[0]) || {}).payload || {};
  const pol = env.approval_policy || {};
  return {
    title: env.summary,
    type: 'approval',
    status: 'pending',
    priority: priorityFor(env),
    description: [
      pol.reason,
      p.amount ? ('발주금액: ' + Number(p.amount).toLocaleString() + '원') : null,
      p.item ? ('품목 ' + p.item + ' x' + p.qty + (p.supplier_name ? ' / ' + p.supplier_name : '')) : null,
      'confidence=' + env.confidence,
      'decision_id=' + env.decision_id, // ← 승인 버튼이 회신할 연결 키
    ].filter(Boolean).join(' | '),
    requester_name: String(env.agent || 'agent').toUpperCase() + ' Agent',
    department: DEPT[env.agent] || 'AXOS',
    assignee_name: (pol.approvers || []).join(', ') || '승인자',
    comments: [{ author: 'AXOS Bridge', text: 'decision_id=' + env.decision_id +
      '; intent=' + ((req && req.intent) || '') + '; agent=' + env.agent, date: now() }],
  };
}

function request(method, pathStr, bodyObj) {
  return new Promise((resolve) => {
    let url; try { url = new URL(CFG.apiBase + pathStr); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const opts = { method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'X-App-Id': CFG.appId,
        Authorization: 'Bearer ' + CFG.token, ...(data ? { 'Content-Length': data.length } : {}) } };
    const r = lib.request(opts, (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: b }); }); });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (data) r.write(data); r.end();
  });
}

// 방향 1: held → 승인 카드 생성
async function createCard(env, req) {
  const card = toCard(env, req);
  if (!CFG.token) {
    return { mock: true, card_id: 'mockcard-' + crypto.randomUUID().slice(0, 8), fields: card,
      note: 'BASE44_TOKEN 미설정 → mock. live: POST ' + CFG.apiBase + '/api/apps/' + CFG.appId + '/entities/WorkflowRequest' };
  }
  const res = await request('POST', '/api/apps/' + CFG.appId + '/entities/WorkflowRequest', card);
  return { mock: false, ok: res.ok, card_id: res.body && res.body.id, status: res.status,
    fields: card, error: res.ok ? undefined : (res.raw || res.error) };
}

// 방향 3: 승인 실행/거부 완료 → 카드 닫기 (status: completed | rejected)
async function closeCard(cardId, status, note) {
  if (!CFG.token || !cardId || String(cardId).startsWith('mockcard-')) {
    return { mock: true, card_id: cardId, would_set: { status }, note: note || null };
  }
  const res = await request('PUT', '/api/apps/' + CFG.appId + '/entities/WorkflowRequest/' + cardId,
    { status, comments: [{ author: 'AXOS Bridge', text: note || ('resolved: ' + status), date: now() }] });
  return { mock: false, ok: res.ok, card_id: cardId, status: res.status, error: res.ok ? undefined : (res.raw || res.error) };
}

module.exports = { createCard, closeCard, toCard, _CFG: CFG };
