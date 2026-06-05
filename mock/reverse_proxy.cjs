/**
 * 리버스 프록시 (외부화 지시서 방법 B) — 단일 ngrok 도메인으로 n8n + 브리지 동시 서빙.
 * ----------------------------------------------------------------------------
 *   ngrok(예약도메인) ──▶ 이 프록시(:5000)
 *        /bridge/*  ─▶ http://localhost:4100  (브리지, prefix 제거)
 *        그 외 /*   ─▶ http://localhost:5678  (n8n, 그대로 전달)
 * 투명 전달: 메서드/헤더/본문/쿼리/상태/응답 스트림 보존. CORS는 브리지가 이미 부여.
 * 실행: node reverse_proxy.cjs   (PROXY_PORT 기본 5000)
 * 외부 URL: https://<ngrok-domain>/bridge/...  (브리지), https://<ngrok-domain>/webhook/...(n8n)
 */
'use strict';
const http = require('http');

const CFG = {
  port: parseInt(process.env.PROXY_PORT || '5000', 10),
  bridge: { host: '127.0.0.1', port: parseInt(process.env.BRIDGE_PORT || '4100', 10) },
  n8n: { host: '127.0.0.1', port: parseInt(process.env.N8N_PORT || '5678', 10) },
  prefix: '/bridge',
};

const server = http.createServer((cReq, cRes) => {
  const toBridge = cReq.url === CFG.prefix || cReq.url.startsWith(CFG.prefix + '/') || cReq.url.startsWith(CFG.prefix + '?');
  const target = toBridge ? CFG.bridge : CFG.n8n;
  // /bridge prefix 제거 (빈 경로는 /로)
  let path = cReq.url;
  if (toBridge) { path = cReq.url.slice(CFG.prefix.length) || '/'; if (path[0] !== '/') path = '/' + path; }

  const headers = { ...cReq.headers, host: target.host + ':' + target.port };
  const opts = { host: target.host, port: target.port, method: cReq.method, path, headers };

  const pReq = http.request(opts, (pRes) => {
    cRes.writeHead(pRes.statusCode, pRes.headers);
    pRes.pipe(cRes);
  });
  pReq.on('error', (e) => {
    if (!cRes.headersSent) cRes.writeHead(502, { 'Content-Type': 'application/json' });
    cRes.end(JSON.stringify({ error: 'bad_gateway', upstream: target.port, message: e.message }));
  });
  cReq.pipe(pReq);
});

server.listen(CFG.port, () => {
  console.log('[axos-proxy] reverse proxy on http://localhost:' + CFG.port);
  console.log('[axos-proxy]   ' + CFG.prefix + '/*  -> bridge :' + CFG.bridge.port);
  console.log('[axos-proxy]   /*        -> n8n    :' + CFG.n8n.port);
});
