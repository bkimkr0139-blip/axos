# AXOS — 다시 시작 가이드 (RESUME)

> AXOS = 경험(Base44) · 판단(Databricks) · 실행(n8n). 최초 구축 2026-06-05.
> 전체 설계는 `README.md` + `docs/00`~`07`. 본 문서는 재개 절차만.

## 0. 핵심 사실
| 항목 | 값 |
|------|----|
| repo | `C:\Users\User\works\base44\axos` (신규 git, 로컬) |
| 실행 레이어 | n8n v2.57.1 `localhost:5678`, `[BC44·파이프라인] 01~10` active(mock). → `../n8n-pipeline/RESUME.md` |
| 판단 레이어 | Databricks **미연결** → contract·mock 우선. mock 브리지가 대체 |
| 경험 레이어 | Base44 앱 `6a225124042c1a7db62f27fb`. STEP1은 Base44 MCP 연결 후 (→ `docs/07`) |
| mock 브리지 | `mock/bridge_server.cjs` 포트 **4100**. 판단→봉투→승인게이트→n8n 실행→감사 |
| mock 콜백 | `../n8n-pipeline/mock/mock_callback_server.cjs` 포트 4000 |
| 백업 | 신규 `axos` repo (로컬 커밋만, push 보류 — 사용자 승인 시) |

## 1. 세션 재시작
- `C:\Users\User\works\base44` 에서 세션 시작(n8n MCP 로드). Base44 MCP는 `docs/07` 절차로 등록 필요.

## 2. mock end-to-end 기동·검증
```powershell
curl http://localhost:5678/webhook/health                      # n8n 01~10 active 확인
node C:\Users\User\works\base44\axos\mock\bridge_server.cjs     # 브리지 :4100
powershell -ExecutionPolicy Bypass -File C:\Users\User\works\base44\axos\scripts\smoke_bridge.ps1
```
브리지 엔드포인트: `POST /insight`(?dry_run=1) · `POST /approve {decision_id,approver}` · `POST /reject` · `GET /pending` · `GET /audit?n=` · `GET /health`.
구성요소: `agents/scm_agent.cjs`(재고예측→발주추천) · `adapters/erp_mock.cjs`(PO 쓰기/취소) · 라우팅 intent→agent.
기대: (1)dry_run+erp.would_create (2)held (3)pending=1 (4)approve→PO생성+notify (5)(6)auto notify (7)decided/held/approved/executed.

## 3. 검증 결과 (완료분)
- ✅ (2026-06-05) 마스터 청사진 + STEP1~10 매핑 + 레거시통합 + AX전환 플레이북 + 거버넌스(docs/00~07)
- ✅ 브리지 3계약 + Agent I/O 계약(contracts/), mock 브리지 end-to-end
- ✅ **STEP2 SCM 수직슬라이스**: SCM agent(item A 결품예측→550개 발주, 5,335,000원)→ERP 어댑터 PO 생성 + notify
- ✅ **STEP3 승인 응답 루프**: held→/approve→execute(ERP+notify), /reject 폐기, /pending. HITL 체인 감사 기록
- ✅ STEP1 Base44 MCP **등록·인증 완료**(✓Connected).
- ✅ **STEP1 스캔 완료**(2026-06-05): MCP 실측 6 엔티티(AIAgent·DataSource·DatabricksConfig·WorkflowRequest·Document·User) → `docs/step1_base44_inventory.md` + 엔티티→Databricks 메달리온 매핑 `docs/step1_databricks_mapping.md`. AIAgent.type 6종=판단 도메인(1:1), 발주 승인 시드=STEP2 SCM 슬라이스와 동일. DataSource/DatabricksConfig 0건(live 미연결 일치). 화면은 추론(MCP 페이지조회 미지원, Preview 확인은 보강과제).

- ✅ **Base44 승인 카드 연동**(2026-06-05): 양방향. 브리지 `adapters/base44_card.cjs`(held→카드 생성, approve/reject→카드 닫기, decision_id 연결, CORS+OPTIONS) + Base44 "승인 센터" 화면(MCP 자연어 구축). mock+실제앱(WorkflowRequest id=6a228f10…b540) 검증. → docs/04 §3.1
- ✅ **STEP6 6 Agent 전체 구현**(2026-06-05): `agents/_base.cjs`(공통 골격) + scm/procurement/sales/finance/hr/quality. 브리지 INTENT_ROUTE 12 인텐트, `AGENT_REGISTRY` alias(inventory→scm, purchasing→procurement). STEP8 예측 mock은 각 agent reason()에 내장. 스모크 `scripts/smoke_agents.ps1` 6 agent sweep 통과(판단·게이트).
- ✅ **STEP9 Agent Memory(mock)**: `memory/memory_mock.cjs`(4종 인덱스 jsonl, remember/retrieve) + `memory/memory.schema.json`. 브리지 실행완료→task_memory 적재(자가향상 루프), judge가 retrieve 회수. `/memory` 엔드포인트.
- ✅ **STEP5 Copilot + STEP6 Agent 콘솔 화면**(Base44 MCP): 자연어 질의→/insight, 6 Agent 트리거→DecisionEnvelope 표시.
- ✅ **STEP10 운영 대시보드 + STEP3 데이터소스 + STEP2 Databricks 화면**(Base44 MCP): KPI/ROI/차트, DataSource 9종·DatabricksConfig 5종 시드.
- ✅ **end-to-end 실증**(2026-06-05, n8n :5678 UP): 자동실행 sales/hr/quality/copilot 전부 succeeded, 승인루프 SCM held→approve→ERP PO(PO-99BF3E8D, 5,335,000원)+notify delivered+카드 completed. 감사 decided→held→approved→executed, task_memory 누적.
- ✅ **GitHub push**(커밋 6c38451): origin main. 런타임 jsonl(audit/memory)는 .gitignore.
- ✅ **거버넌스 하드닝**(2026-06-05, docs/06 §3): `mock/governance.cjs` + 브리지 게이트 강제 — 한도(거부)·신뢰도임계(승급)·만료·RBAC/SoD·이중승인(2인)·킬스위치(/kill·/unkill)·보상(/compensate)·운영지표(/metrics). 검증: `scripts/test_governance.cjs`(단위 15/15), `scripts/smoke_governance.ps1`(e2e: RBAC 거부→실행, 이중승인 PO 17,640,000원, 킬스위치 차단, 보상 취소, metrics).
- ✅ **Base44 거버넌스/운영 패널**(MCP): 운영 대시보드 실시간 `/metrics` 연결(자동화율·성공률·ROI·agent별, 오프라인 배지) + "거버넌스 제어" 화면(킬스위치 토글·이중승인 진행률·보상 실행). 브리지 엔드포인트 CORS 검증 완료(브라우저 fetch).
- ✅ **FastAPI AXOS Bridge**(2026-06-05, `axos-bridge/`): 작업지시서(ClaudeCode_Integration_Guide) Phase1~5 전체. Node mock 브리지와 별개 포트 8000. MX-Flow(n8n 실연계: workflows/상세/실행/로그)·Databricks(MCP→REST→SQL→Vector fallback, 미설정 시 mock 메달리온)·AX Copilot 루프(intent 6종→근거검색→simulation→승인정책 엔진[confidence/risk/amount/security]→결재/실행→audit)·승인(RBAC/SoD/이중승인)·거버넌스(kill/compensate)·audit(sqlite). pytest 11/11. venv·.env·*.db는 .gitignore. 기동: `axos-bridge/.venv/Scripts/python -m uvicorn app.main:app --port 8000`. → `axos-bridge/README.md`, `docs/api_contract.md`, `docs/demo_scenarios.md`(데모 3종).
- ✅ **엔진 강점 노출**(2026-06-05): `mock/engines.cjs` + 브리지 `/workflows`(n8n: 01~10 카탈로그·결정→워크플로우 라우팅·실시간 헬스)·`/catalog`(Databricks: 메달리온 5계층·계보 4·judge 모드·Vector 4종)·`/predictions`(Mosaic AI: 수요/매출/이직/불량/비용). Base44 화면 2종(자동화 워크플로우 n8n / 데이터 레이크하우스 Databricks) MCP 구축.
- ✅ **외부화**(2026-06-05, docs/09): Base44 클라우드→로컬 브리지 `ERR_CONNECTION_REFUSED` 해결. 방법 B(cloudflared는 이 환경 엣지 404). `mock/reverse_proxy.cjs`(:5000, /bridge/*→4100·그 외→5678) + ngrok 예약도메인 타깃 5678→5000 재지정. 브리지 외부=`https://hardware-finalize-faceted.ngrok-free.dev/bridge`. 브리지 CORS에 `ngrok-skip-browser-warning` 허용 추가. Base44 BRIDGE_URL 교체+헤더 적용. 외부 /webhook/health·/bridge/health·CORS 프리플라이트 200 검증.

## 4. 다음 작업 (TODO — 자격증명 의존, 코드는 드롭인 준비완료)
- [ ] **Databricks live**(핵심 잔여): 워크스페이스/PAT 확보 시 `adapters/databricks_judge.cjs`로 judge 교체(PIPELINE_MODE=live), audit/memory를 Delta·Vector로. 계약 불변. DatabricksConfig 엔티티에 값 주입.
- [ ] **승인 카드 live REST**: `BASE44_TOKEN` 주입 시 브리지가 실 WorkflowRequest 생성. 클라우드 빌더↔localhost는 터널 필요(SECL 패턴).
- [ ] **운영토큰**: n8n `N8N_WEBHOOK_TOKEN`·브리지 토큰 강한 값으로 (현 dev 폴백, 로컬 전용)

## n8n 기동 메모 (실행 검증 전제)
native n8n v2.20.11. 다운 시: `$env:N8N_BLOCK_ENV_ACCESS_IN_NODE='false'` 후 `C:\Users\User\AppData\Local\npm-cache\_npx\a8a7eec953f1f314\node_modules\.bin\n8n.cmd start` (자세히 ../n8n-pipeline/RESUME §2). ⚠️ `node` 전체 종료 금지 — n8n·MCP까지 끊김. 5678 리스너만 정확히 종료.

## 5. 함정
- `.js`는 상위 package.json(type:module) 때문에 ESM 오류 → Node 단독 실행은 `.cjs`.
- PowerShell 5.1 콘솔은 한글 출력이 깨져 보임(표시만, 파일/데이터는 정상 UTF-8).
- 브리지가 n8n 호출 시 `Authorization: Bearer dev-local-token` + 필수필드(request_id/project_id/user_id/message). 누락 시 n8n이 VALIDATION_ERROR 반환.
