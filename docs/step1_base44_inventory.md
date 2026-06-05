# STEP1 · Base44 앱 인벤토리 (AXOS)

> 데이터모델·화면·API 분석 산출물. **상태: 완료** — Base44 MCP 실측 스캔(2026-06-05).
> 스캔 도구: `list_entity_schemas` · `query_entities` · `get_app_status` · `list_user_apps` · `get_app_preview_url`.

## 앱 식별 (실측 ✓)
- App Name: **AXOS** (MCP `list_user_apps` 확인 — 가칭 아님, 확정)
- App ID: `6a225124042c1a7db62f27fb`
- Owner: `nextmoreai@gmail.com` (role: admin, full_name: PM)
- Build Status: **ready** (`get_app_status`)
- Editor: https://app.base44.com/apps/6a225124042c1a7db62f27fb/editor
- Preview(sandbox): `https://preview-sandbox--6a225124042c1a7db62f27fb.base44.app` (`_preview_token` 필요, 임시)
- git_remote_source: `s3`
- API Base: `https://base44.app`
- MCP: `base44` (HTTP, https://app.base44.com/mcp) — ✓ Connected

## 런타임 호출 패턴 (런북 §부록 — 확정)
- 함수: `POST https://base44.app/api/apps/6a225124042c1a7db62f27fb/functions/{name}`
- 엔티티 조회: `GET .../api/apps/6a22…/entities/{Entity}[/{id}]`
- 엔티티 생성: `POST .../entities/{Entity}` · 수정: `PUT .../entities/{Entity}/{id}`
- 공통 헤더: `Authorization: Bearer <token>`, `X-App-Id: 6a225124042c1a7db62f27fb`

---

## 1. 데이터 모델 (Entities) — 실측 6종

`list_entity_schemas` 결과 총 6개 엔티티. 레코드 수는 `query_entities` 실측.

| 엔티티 | 레코드 | 핵심 필드(타입·enum) | AXOS 매핑(판단/실행 어디서 쓰나) |
|--------|:-----:|----------------------|----------------------------------|
| **AIAgent** | 6 | name, type(inventory·purchasing·sales·quality·hr·finance), status(active·inactive·training·error), model, capabilities[], usage_count, accuracy | **STEP6 6 Agent의 경험-레이어 레지스트리**. type enum = 브리지 `DecisionEnvelope.agent` 도메인과 1:1. usage_count/accuracy → STEP10 대시보드 KPI |
| **DataSource** | 0 | name, type(ERP·MES·CRM·SCM·Groupware·Database·FileStorage·API), status(active·inactive·error·syncing), host, port, database_name, last_sync, sync_interval, record_count | **STEP3 Enterprise Data Fabric 연결 카탈로그**. type enum = Fabric 수집원. Databricks Bronze 적재 소스 정의(메타데이터) |
| **DatabricksConfig** | 0 | name, config_type(api_endpoint·workspace·token·unity_catalog·vector_search), value, workspace_url, status, last_verified | **STEP2 Databricks 연결 설정**. live 전환 시 workspace_url/token/UC/Vector 엔드포인트 보관소. 현재 비어있음 → live 미연결과 일치 |
| **WorkflowRequest** | 5 | title, type(approval·request·notification·automation), status(pending·approved·rejected·in_progress·completed), priority, department, requester_name, assignee_name, due_date, comments[] | **브리지 승인 게이트(HITL) ↔ Base44 승인 카드 접점**. type=approval·status=pending → 브리지 `/pending`·`/approve`와 연동 대상. STEP7 승인 자동화 |
| **Document** | 5 | title, type(report·contract·manual·memo·policy·…), status(draft·review·approved·archived), department, content, summary, file_url, tags[], author_name | **STEP9 문서 기억(document_memory) 원천**. content→n8n `01 document-ingest`→Vector. summary 필드는 AI 요약 슬롯(`07 llm-route`) |
| **User** | 1 | role(admin·manager·employee·executive), department, position, phone, avatar_url | **거버넌스 주체**. role → 브리지 승인 권한(approvers)·STEP6 거버넌스(docs/06) 매핑 |

### 시드 데이터 실측 (현황 파악용)
- **AIAgent(6)**: 재고(inventory, GPT-4o, acc94), 구매(purchasing, Claude3.5, acc91), 영업(sales, GPT-4o, acc88), 품질(quality, Databricks ML, acc96), 인사(hr, Claude3.5, training, acc85), 재무(finance, GPT-4o, acc92). → **STEP6의 6 Agent가 경험 레이어에 이미 정의됨.**
- **WorkflowRequest(5)**: 구매 발주 승인(원자재 A103 2,000개 ₩2,400만, approval/pending), 월간보고 검토(approval/pending), 출장경비(approved), 신규 생산라인(in_progress), IT 인프라(request/pending). → 발주 승인 건이 **STEP2/3 SCM 수직슬라이스와 직접 대응**.
- **Document(5)**: Q2 매출보고서, 공급업체 계약(삼성전자), 생산라인 매뉴얼 v3.2, 인사정책 개정안, 하반기 사업계획. type/status 다양 → 문서 기억 시드.
- **DataSource(0)·DatabricksConfig(0)**: 비어있음. → Fabric/Databricks 연결은 아직 메타데이터 미등록(설계·mock 단계와 일치).

---

## 2. 함수 (Functions) — 스캔 결과

- Base44 MCP에는 함수 목록 조회 도구가 **노출되지 않음**(제공 도구: app/entity 관리·쿼리 한정). 따라서 커스텀 백엔드 함수는 MCP로 직접 열람 불가.
- 런타임 함수 호출 규약(`POST .../functions/{name}`)은 확정(위 §런타임). AXOS가 브리지/n8n과 통신하는 접점은 **엔티티 쓰기(WorkflowRequest 상태 변경)** + 외부 호출(`N8N_BASE_URL`)로 설계 — docs/04 브리지 계약 참조.
- **AXOS 연계 접점**(설계상): ① Copilot 질의 → `InsightRequest(source:"base44")` ② 승인 카드 버튼 → 브리지 `/approve` 콜백 ③ ActionResult → WorkflowRequest.status 갱신.
- (확인 필요) 에디터에서 커스텀 함수 존재 여부는 Preview/에디터 직접 확인 권장(MCP 한계).

---

## 3. 화면 (Pages/Screens) — 엔티티 기반 추론

> Base44 MCP에 페이지 목록 조회 도구 없음. 엔티티 구조·앱 목적으로 추론. **확정은 Preview URL 직접 확인 필요.**

| 추정 화면 | 근거 엔티티 | 역할 | AXOS 진입점 |
|------|------|------|-------------|
| 대시보드 | AIAgent.usage_count/accuracy | Agent 사용량·KPI 요약 | **STEP10 운영 대시보드** (브리지 감사로그 집계 렌더) |
| AI Agents | AIAgent | 6 Agent 상태·정확도·기능 관리 | **STEP6** Agent 레지스트리 |
| 승인/워크플로우 | WorkflowRequest | 승인·요청 목록, 승인 버튼 | **STEP7 승인 자동화** → 브리지 `/pending`·`/approve` |
| 문서 | Document | 문서 열람·AI 요약 | **STEP9 문서 기억** / STEP5 Copilot 소스 |
| 데이터 소스 | DataSource | Fabric 연결 상태 모니터 | **STEP3** Fabric 연결 현황 |
| Databricks 설정 | DatabricksConfig | 워크스페이스/UC/Vector 설정 | **STEP2** 연결 설정 |
| Copilot | (Document/전체) | 자연어 질의·리포트·요약 | **STEP5 Copilot** → `02 rag-chat`/`05 report`/`07 llm-route` |

---

## 4. 인증 방식 (실측 추론)
- 엔티티 API: `Authorization: Bearer <token>` + `X-App-Id`. (런북 확정)
- User 엔티티에 `role`(admin/manager/employee/executive) + `_app_role`/`collaborator_role` → **RBAC 기반**. 현재 사용자 1명(admin, PM).
- MCP 접근: OAuth 등록·인증 완료(세션 재사용, 추가 인증 불필요).

---

## 5. STEP1 → 후속 매핑 (이 문서 산출)
1. **엔티티 → Databricks 데이터모델 매핑**: 아래 `step1_databricks_mapping.md`로 분리·작성 (이번 세션 완료).
2. **화면 → 진입점**: 승인/워크플로우 화면 = 브리지 `/approve` 콜백 1순위 연동 대상(STEP3 TODO와 직결).
3. **함수 → 계약**: WorkflowRequest 상태 전이 = ActionResult 반영 지점. Copilot 질의 = InsightRequest source.

> **STEP1 마감 판정**: 데이터모델(✅실측 6종) · 화면(△추론, Preview 확인 권장) · API(✅런타임 규약 확정, 함수목록은 MCP 한계로 에디터 확인). → 데이터/구조 분석 목표 달성, 화면 실측만 보강 과제로 남김.
