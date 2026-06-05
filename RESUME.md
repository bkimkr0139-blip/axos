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
- ✅ STEP1 Base44 MCP **등록·인증 완료**(✓Connected). 실제 엔티티/화면/API 스캔만 세션 재시작 후(OAuth 불필요)

## 4. 다음 작업 (TODO, 우선순위)
- [ ] **STEP1 스캔**: 세션 재시작 → base44 MCP 도구로 엔티티/화면/API 조회 → `docs/step1_base44_inventory.md` 채우기
- [ ] **나머지 5 Agent**: SCM 골격(agents/scm_agent.cjs) 템플릿화 → Sales/Procurement/Finance/HR/Quality 수평 복제
- [ ] **Base44 승인 카드 연동**: 현재 /approve는 API. Base44 화면 승인 버튼→브리지 /approve 콜백 연결
- [ ] **Databricks live**: judge(agents)를 Model Serving/Jobs로, audit를 Delta append로 교체. 계약 불변
- [ ] **운영토큰**: n8n `N8N_WEBHOOK_TOKEN`·브리지 토큰 강한 값으로 (현 dev 폴백, 로컬 전용)
- [ ] **GitHub push**: 신규 axos repo 원격 생성·push (gh auth 확인)

## 5. 함정
- `.js`는 상위 package.json(type:module) 때문에 ESM 오류 → Node 단독 실행은 `.cjs`.
- PowerShell 5.1 콘솔은 한글 출력이 깨져 보임(표시만, 파일/데이터는 정상 UTF-8).
- 브리지가 n8n 호출 시 `Authorization: Bearer dev-local-token` + 필수필드(request_id/project_id/user_id/message). 누락 시 n8n이 VALIDATION_ERROR 반환.
