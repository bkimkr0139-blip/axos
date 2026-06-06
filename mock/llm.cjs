/**
 * LLM 클라이언트 — AI 워크플로우 생성용. 기본 Anthropic(Claude), OpenAI·Ollama 옵션.
 * 키 소스 우선순위: process.env → aep-dt/.env(사용자 제공) → axos/.env
 * env:
 *   LLM_PROVIDER / AXOS_LLM_PROVIDER = anthropic(기본) | openai | ollama
 *   LLM_MODEL_DEFAULT / AXOS_LLM_MODEL = 모델명
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, OLLAMA_BASE_URL
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 키/설정 소스 로드 (process.env 우선, 없으면 파일에서 보충)
function loadEnvFile(p, into) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
      if (into[m[1]] === undefined || into[m[1]] === '') into[m[1]] = v;
    }
  } catch (_) { /* 파일 없으면 무시 */ }
}

const SRC = {};
for (const k of ['LLM_PROVIDER', 'AXOS_LLM_PROVIDER', 'LLM_MODEL_DEFAULT', 'AXOS_LLM_MODEL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'ANTHROPIC_VERSION']) {
  if (process.env[k]) SRC[k] = process.env[k];
}
loadEnvFile(process.env.AXOS_LLM_ENV || 'C:/Users/User/works/aep-dt/.env', SRC);
loadEnvFile(path.join(__dirname, '..', '.env'), SRC);

const CFG = {
  provider: (SRC.AXOS_LLM_PROVIDER || SRC.LLM_PROVIDER || 'anthropic').toLowerCase(),
  model: SRC.AXOS_LLM_MODEL || SRC.LLM_MODEL_DEFAULT || '',
  anthropicKey: SRC.ANTHROPIC_API_KEY || '',
  anthropicVersion: SRC.ANTHROPIC_VERSION || '2023-06-01',
  openaiKey: SRC.OPENAI_API_KEY || '',
  ollamaBase: SRC.OLLAMA_BASE_URL || 'http://localhost:11434',
};

function available() {
  if (CFG.provider === 'anthropic') return !!CFG.anthropicKey;
  if (CFG.provider === 'openai') return !!CFG.openaiKey;
  return true;
}
function modelName() {
  // provider별 적합 모델만 사용 (폴백 시 타 provider 모델명 오용 방지)
  const m = CFG.model;
  if (CFG.provider === 'anthropic') return (m && m.startsWith('claude')) ? m : 'claude-haiku-4-5-20251001';
  if (CFG.provider === 'openai') return (m && /^(gpt|o\d|chatgpt)/i.test(m)) ? m : 'gpt-4o';
  return (m && !m.startsWith('claude') && !/^gpt/i.test(m)) ? m : 'qwen2.5-coder:7b';
}

function req(lib, urlStr, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const data = Buffer.from(JSON.stringify(body));
    const opts = { method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, timeout: timeoutMs || 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } };
    const r = lib.request(opts, (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: b }); }); });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.write(data); r.end();
  });
}

async function chat(system, user, timeoutMs) {
  const to = timeoutMs || 60000;
  if (CFG.provider === 'anthropic') {
    if (!CFG.anthropicKey) return { ok: false, error: 'no_anthropic_key' };
    const r = await req(https, 'https://api.anthropic.com/v1/messages',
      { 'x-api-key': CFG.anthropicKey, 'anthropic-version': CFG.anthropicVersion },
      { model: modelName(), max_tokens: 2048, system, messages: [{ role: 'user', content: user }] }, to);
    const txt = r.ok && r.body && Array.isArray(r.body.content) && r.body.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    return txt ? { ok: true, text: txt, model: modelName(), provider: 'anthropic' }
      : { ok: false, error: (r.body && r.body.error && r.body.error.message) || r.error || ('http ' + r.status) };
  }
  if (CFG.provider === 'openai') {
    if (!CFG.openaiKey) return { ok: false, error: 'no_openai_key' };
    const r = await req(https, 'https://api.openai.com/v1/chat/completions',
      { Authorization: 'Bearer ' + CFG.openaiKey },
      { model: modelName(), temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, to);
    const txt = r.ok && r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message.content;
    return txt ? { ok: true, text: txt, model: modelName(), provider: 'openai' } : { ok: false, error: r.error || ('http ' + r.status) };
  }
  const r = await req(http, CFG.ollamaBase + '/api/chat', {},
    { model: modelName(), stream: false, options: { temperature: 0.2 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, to);
  const txt = r.ok && r.body && r.body.message && r.body.message.content;
  return txt ? { ok: true, text: txt, model: modelName(), provider: 'ollama' } : { ok: false, error: r.error || ('http ' + r.status) };
}

// 폴백: 설정 provider 우선 → 실패 시 openai → ollama 순으로 시도(잔액부족/오류 대비)
async function complete(system, user, timeoutMs) {
  const order = [];
  const add = (p) => { if (!order.includes(p)) order.push(p); };
  add(CFG.provider);
  if (CFG.openaiKey) add('openai');
  add('ollama');
  const orig = CFG.provider;
  let lastErr = '';
  for (const p of order) {
    CFG.provider = p;
    if (!available()) continue;
    const r = await chat(system, user, timeoutMs);
    if (r.ok) { CFG.provider = orig; return { ...r, fallback_from: p !== orig ? orig : undefined }; }
    lastErr = r.error || lastErr;
  }
  CFG.provider = orig;
  return { ok: false, error: lastErr || 'no_provider' };
}

module.exports = { chat, complete, available, modelName, provider: () => CFG.provider };
