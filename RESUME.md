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
# (n8n 01~10 active 확인)
curl http://localhost:5678/webhook/health
# 브리지 기동
node C:\Users\User\works\base44\axos\mock\bridge_server.cjs    # :4100
# 스모크 (판단->봉투->게이트->실행->감사)
powershell -ExecutionPolicy Bypass -File C:\Users\User\works\base44\axos\scripts\smoke_bridge.ps1
```
기대: (1) skipped_dry_run (2) succeeded + n8n payload (3) held_for_approval (4) audit 이벤트.

## 3. 2026-06-05 검증 결과 (완료분)
- ✅ 마스터 청사진 + STEP1~10 매핑 + 레거시통합 + AX전환 플레이북 + 거버넌스 문서(docs/00~07)
- ✅ 브리지 3계약(InsightRequest/DecisionEnvelope/ActionRequest) + Agent I/O 계약(contracts/)
- ✅ mock 브리지 end-to-end 통과: stock_risk → n8n 08 notify 실행(succeeded), create_po → 승인게이트 held

## 4. 다음 작업 (TODO, 우선순위)
- [ ] **STEP1**: Base44 MCP 연결(docs/07) → `docs/step1_base44_inventory.md`(엔티티/화면/API)
- [ ] **SCM Agent 수직슬라이스**: 판단(mock)→봉투→브리지→08/ERP어댑터(mock)→감사→업무기억 (대표 시나리오, docs/00 §3)
- [ ] **승인 응답 루프**: 현 mock은 held까지만. Base44 승인카드→브리지 콜백→execute 완성
- [ ] **Databricks live**: 자격증명 확보 시 judge()를 Model Serving/Jobs 호출로, audit를 Delta append로 교체. 계약 불변
- [ ] **운영토큰**: n8n `N8N_WEBHOOK_TOKEN`·브리지 토큰 강한 값으로 (현 dev 폴백, 로컬 전용)
- [ ] **GitHub push**: 사용자 승인 시 신규 axos repo 원격 생성·push

## 5. 함정
- `.js`는 상위 package.json(type:module) 때문에 ESM 오류 → Node 단독 실행은 `.cjs`.
- PowerShell 5.1 콘솔은 한글 출력이 깨져 보임(표시만, 파일/데이터는 정상 UTF-8).
- 브리지가 n8n 호출 시 `Authorization: Bearer dev-local-token` + 필수필드(request_id/project_id/user_id/message). 누락 시 n8n이 VALIDATION_ERROR 반환.
