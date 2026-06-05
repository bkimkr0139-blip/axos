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

## 4. 다음 작업 (TODO, 우선순위)
- [ ] **Databricks live**(핵심 잔여): 자격증명 확보 시 `adapters/databricks_judge.cjs`로 judge 교체(PIPELINE_MODE=live), audit/memory를 Delta·Vector로. 계약 불변. DatabricksConfig 엔티티에 값 주입.
- [ ] **승인 카드 live 호출**: `BASE44_TOKEN` 주입 시 실 REST 카드 생성. 클라우드 빌더↔localhost는 터널 필요(SECL 패턴).
- [ ] **n8n 가동 의존**: 자동실행(send_alert/report/route_llm) 완결은 n8n :5678 active 필요. 다운 시 판단·게이트는 정상, 실행만 failed.
- [ ] **운영토큰**: n8n `N8N_WEBHOOK_TOKEN`·브리지 토큰 강한 값으로 (현 dev 폴백, 로컬 전용)
- [ ] **GitHub push**: 신규 axos repo 원격 생성·push (gh auth 확인)

## 5. 함정
- `.js`는 상위 package.json(type:module) 때문에 ESM 오류 → Node 단독 실행은 `.cjs`.
- PowerShell 5.1 콘솔은 한글 출력이 깨져 보임(표시만, 파일/데이터는 정상 UTF-8).
- 브리지가 n8n 호출 시 `Authorization: Bearer dev-local-token` + 필수필드(request_id/project_id/user_id/message). 누락 시 n8n이 VALIDATION_ERROR 반환.
