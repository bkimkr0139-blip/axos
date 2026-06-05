/**
 * Databricks 판단 어댑터 (live 전환 지점) — mock SCM agent를 대체하는 드롭인.
 * ----------------------------------------------------------------------------
 * 역할: 브리지의 judge 단계를 Databricks(Mosaic AI Model Serving + SQL/Vector)로 위임.
 * 인터페이스는 agents/scm_agent.cjs 의 handle(req) 와 동일 → DecisionEnvelope 반환.
 * 계약(contracts/bridge/decision_envelope.schema.json)은 불변.
 *
 * 전환 방법 (docs/08_databricks_live_transition.md):
 *   1) 환경변수: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_SERVING_ENDPOINT
 *   2) bridge_server.cjs 의 INTENT_ROUTE 를 이 모듈 handle 로 교체 (PIPELINE_MODE=live 분기)
 *   3) Model Serving 엔드포인트가 DecisionEnvelope(JSON)를 반환하도록 모델/체인 구성
 *
 * 자격증명 미설정 시: throw → 브리지가 mock agent로 폴백하도록 호출부에서 try/catch.
 */
'use strict';
const https = require('https');

const CFG = {
  host: process.env.DATABRICKS_HOST || null,           // 예: adb-1234567890.12.azuredatabricks.net
  token: process.env.DATABRICKS_TOKEN || null,          // PAT
  endpoint: process.env.DATABRICKS_SERVING_ENDPOINT || 'axos-judge', // Model Serving 엔드포인트명
};

function isConfigured() { return !!(CFG.host && CFG.token); }

function postServing(inputs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ inputs }));
    const opts = { method: 'POST', hostname: CFG.host, path: '/serving-endpoints/' + CFG.endpoint + '/invocations',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.token, 'Content-Length': data.length } };
    const req = https.request(opts, (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { try { const j = JSON.parse(b); res.statusCode < 300 ? resolve(j) : reject(new Error('serving ' + res.statusCode + ': ' + b)); }
        catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

/**
 * handle(req) — agent 호환. Databricks 판단 결과를 DecisionEnvelope로 반환.
 * 모델은 {predictions:[envelope]} 또는 envelope 자체를 반환한다고 가정(엔드포인트 계약).
 */
async function handle(req) {
  if (!isConfigured()) throw new Error('databricks_not_configured'); // 브리지가 mock으로 폴백
  const out = await postServing([{ intent: req.intent, context: req.context || {}, query: req.query || null }]);
  const env = Array.isArray(out.predictions) ? out.predictions[0] : (out.envelope || out);
  // 안전망: 모델이 결정한 봉투에 evidence/approval_policy 없으면 브리지 검증에서 거부됨(의도된 동작)
  return env;
}

module.exports = { handle, isConfigured, _cfg: CFG };
