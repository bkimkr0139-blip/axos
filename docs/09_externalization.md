# 09 · 외부화 (Base44 클라우드 → 로컬 브리지/n8n)

> 문제: Base44(클라우드/브라우저)가 `http://localhost:4100`(브리지)에 못 닿아 `ERR_CONNECTION_REFUSED`.
> 해결: 단일 ngrok 예약도메인 + 리버스 프록시로 n8n과 브리지를 함께 외부 노출(외부화 지시서 **방법 B**).
> 구축 2026-06-05. (방법 A=cloudflared quick tunnel은 이 환경에서 엣지 404 systemic → 미사용.)

## 구조
```
Base44(클라우드) ──fetch(+ngrok-skip-browser-warning)──▶ ngrok 예약도메인
  https://hardware-finalize-faceted.ngrok-free.dev
        │
        ▼  (ngrok 타깃 = :5000)
  리버스 프록시  mock/reverse_proxy.cjs  (:5000)
        ├─ /bridge/*  ─▶ 브리지 :4100  (prefix 제거)
        └─ /*         ─▶ n8n   :5678
```

- **n8n 외부**: `https://hardware-finalize-faceted.ngrok-free.dev/webhook/...`
- **브리지 외부**: `https://hardware-finalize-faceted.ngrok-free.dev/bridge/...`
- Base44 `BRIDGE_URL` 상수 = `https://hardware-finalize-faceted.ngrok-free.dev/bridge`

## 기동 순서 (전부 같은 PC)
```powershell
# 1) n8n (:5678) — ../n8n-pipeline/RESUME §2
# 2) mock 콜백 (:4000)
node C:\Users\User\works\base44\n8n-pipeline\mock\mock_callback_server.cjs
# 3) 브리지 (:4100) — axos/.env 자동 로드(N8N_API_KEY 등). 수동 주입 불필요.
node C:\Users\User\works\base44\axos\mock\bridge_server.cjs   # .env 없거나 키 없으면 /workflow만 502, 나머지 정상
# 4) 리버스 프록시 (:5000)
node C:\Users\User\works\base44\axos\mock\reverse_proxy.cjs
# 5) ngrok 타깃을 5000으로 (예약도메인 유지)
&"...\ngrok.exe" http --domain=hardware-finalize-faceted.ngrok-free.dev 5000 --log=stdout
```

## 검증
```bash
DOM=https://hardware-finalize-faceted.ngrok-free.dev
curl -H "ngrok-skip-browser-warning:true" $DOM/webhook/health   # n8n  → ok
curl -H "ngrok-skip-browser-warning:true" $DOM/bridge/health    # 브리지 → axos-bridge
```
Base44 화면 새로고침 → 콘솔에 `localhost:4100 ERR_CONNECTION_REFUSED` 사라지면 성공.

## n8n 에디터 push (WebSocket) — 필수
- n8n push 백엔드 = **WebSocket**(`/rest/push`). 리버스 프록시(`mock/reverse_proxy.cjs`)는 `server.on('upgrade')`로 WebSocket을 n8n으로 raw 터널링한다. 미처리 시 에디터에서 워크플로우 실행 시 **"Lost connection to the server"** 발생. (검증: proxy/ngrok 모두 `/rest/push` 업그레이드 → 101)
- AI 어시스트 생성 워크플로우는 **Manual Trigger → Code** 구조 → 에디터 "Execute Workflow" 클릭 시 즉시 실행(Webhook 트리거는 'Listening for test event' 무한 대기라 클릭 실행 불가하므로 수동 트리거 사용). code 노드는 템플릿 복제로 typeVersion 호환 보장. (수정본 복제는 원본 구조 유지)

## Base44 URL 규칙 (필수)
- Base44(클라우드)는 **절대 localhost를 호출하면 안 됨**. 앱 상수만 사용:
  - `BRIDGE_URL` = `https://hardware-finalize-faceted.ngrok-free.dev/bridge` (브리지 API)
  - `N8N_URL` = `https://hardware-finalize-faceted.ngrok-free.dev` (MX-Flow 에디터 루트)
- n8n 에디터는 상대경로 `/rest`를 사용 → 터널 루트로 부팅 정상(`/rest/settings` 200 확인). `${N8N_URL}/workflow/<id>` 딥링크는 서버 404지만 SPA 부팅됨(보조 링크로 사용).
- **AI 어시스트 생성물 확인**: n8n 에디터 의존 최소화 위해, 생성/수정 후 `${BRIDGE_URL}/workflow?id=<new_id>`로 **앱 내 플로우 다이어그램**을 1차 표시(에디터 링크는 보조). 생성물은 비활성·`[AI]` 접두.

## 핵심 주의
- **ngrok 경고 우회**: Base44 fetch는 모든 브리지 요청에 헤더 `ngrok-skip-browser-warning: true` 필수. 이 헤더는 CORS 프리플라이트를 유발 → 브리지 CORS `Access-Control-Allow-Headers`에 `ngrok-skip-browser-warning` 포함됨(bridge_server.cjs).
- **ngrok free 단일 터널**: n8n과 브리지를 동시에 노출하려면 프록시 1개로 합쳐야 함(그래서 방법 B). ngrok은 5678이 아니라 **5000(프록시)** 를 가리킴.
- **trycloudflare URL 변동**: 방법 A는 미사용(엣지 404). 만약 쓰게 되면 재시작마다 URL 변경 → Base44 BRIDGE_URL 갱신 필요.
- **재부팅 영속성**: 로그인 autostart `C:\Users\User\works\n8n\start-stack.ps1` 는 ngrok을 **5678**로 띄움. 외부화 유지하려면 그 스크립트의 ngrok 타깃을 5000으로 바꾸거나, 부팅 후 위 4)·5)를 재적용. (현재는 수동 적용 상태.)
- **node 전체 종료 금지**: n8n·브리지·프록시·MCP가 모두 node — 5678/4100/5000 리스너 PID만 정확히 종료.
