# STEP1→STEP2 · Base44 엔티티 → Databricks 데이터모델 매핑 (AXOS)

> 입력: `step1_base44_inventory.md`(실측 6 엔티티). 출력: Unity Catalog/메달리온(Bronze→Silver→Gold)
> 테이블 매핑 + 브리지 3계약(docs/04) 연결. **상태: 설계 확정(mock 기준). live 전환 시 테이블만 실체화.**
> 원칙: 계약(DecisionEnvelope/ActionRequest/ActionResult)은 불변 — Base44는 경험·HITL, Databricks는 판단·기억.

## 0. 카탈로그/스키마 (Unity Catalog 설계)
```
catalog: axos
  ├─ bronze   (원본 적재 — DataSource 9종 + Base44 미러)
  ├─ silver   (정제·조인 — 판단 입력)
  ├─ gold     (집계·KPI — STEP10 대시보드)
  ├─ ops      (운영 — 감사·결정봉투·멱등)
  └─ memory   (Vector Search 4종 — STEP9)
```

## 1. 엔티티별 매핑표

| Base44 엔티티 | 방향 | Databricks 위치 | 키/조인 | 브리지 계약 접점 | 비고 |
|---------------|:----:|-----------------|---------|------------------|------|
| **AIAgent** | Base44→ops | `axos.ops.agent_registry` (Silver-grade 차원) | `type`(=agent 도메인) | `DecisionEnvelope.agent` enum 소스 | type 6종=판단 도메인. usage_count/accuracy는 gold KPI로 역집계 |
| **DataSource** | Base44→bronze 메타 | `axos.ops.source_registry` + Bronze 적재 트리거 | `type`(ERP/MES/…) | — (수집 메타) | DataSource.record_count/last_sync ← Bronze 적재 결과 역기록 |
| **DatabricksConfig** | Base44→설정 | (테이블 아님) UC/Serving/Vector **엔드포인트 설정 보관** | `config_type` | 전 계약의 실행 환경 | live 전환 시 workspace_url/token/uc/vector 값 주입원 |
| **WorkflowRequest** | 양방향 | `axos.ops.decision_envelope` ↔ `axos.ops.audit` | `decision_id`↔request id | **DecisionEnvelope·ActionResult 핵심** | approval/pending = 승인 게이트. 상태전이=감사 이벤트(decided→approved→executed) |
| **Document** | Base44→memory | `axos.memory.document_memory`(Vector) + `axos.silver.documents` | doc id, tags | InsightRequest(rag) 근거 | content→n8n `01 ingest`→임베딩. summary←`07 llm-route` |
| **User** | Base44→ops | `axos.ops.actors` (거버넌스 차원) | role | `approval_policy.approvers` | role→승인 권한·HITL 레벨(docs/06) |

## 2. 메달리온 흐름 (수집원 → 판단 → 실행 → 경험)

```
[DataSource(메타)] ─정의─▶ Bronze(axos.bronze.*)  ◀── ERP/MES/CRM/SCM/HR/Mail/File/DB/IoT 적재
                                  │ 정제·조인 (STEP4 파이프라인)
                                  ▼
                              Silver(axos.silver.*)  ── 판단 입력(예측 STEP8)
                                  │ Agent 판단 (STEP6, type=AIAgent.type)
                                  ▼
                    DecisionEnvelope(axos.ops.decision_envelope)
                                  │ 브리지: 검증·거버넌스·승인게이트·멱등
                       ┌──────────┼───────────┐
              approval_required           auto(L4)
                       │                       │
            [Base44 WorkflowRequest 카드]   ActionRequest→n8n 실행
                       │ /approve 콜백          │
                       └──────────┬────────────┘
                                  ▼
                       ActionResult ─▶ axos.ops.audit(append) ─▶ Gold KPI(STEP10)
                                  └─▶ axos.memory.task_memory (업무 기억, STEP9)
```

## 3. 핵심 매핑 디테일

### 3.1 AIAgent.type ↔ 판단 도메인 (1:1, 검증됨)
| AIAgent.type | DecisionEnvelope.agent | 대표 decision | 실행 n8n |
|--------------|------------------------|---------------|----------|
| inventory | scm | create_po / send_alert | ERP어댑터+08 |
| purchasing | procurement | create_po | ERP어댑터+08 |
| sales | sales | generate_report / send_alert | 05,08 |
| quality | quality | send_alert / index_document | 04,08 |
| hr | hr | generate_report | 05 |
| finance | finance | send_alert / generate_report | 05,08 |

> 주의: Base44는 `inventory`/`purchasing`로 분리, 브리지/docs는 `scm`/`procurement`로 명명. **매핑 테이블(`axos.ops.agent_registry`)에 alias 컬럼으로 흡수** — 계약 변경 없이 정합.

### 3.2 WorkflowRequest ↔ HITL 승인 루프 (STEP3에서 검증된 mock과 연결)
- `type="approval"` + `status="pending"` 레코드 = 브리지 `GET /pending` 대상.
- Base44 승인 카드 버튼 → 브리지 `POST /approve {decision_id, approver}` → `ActionRequest` 발행 → 실행 후 `WorkflowRequest.status="completed/approved"` 갱신.
- 실측 시드의 "구매 발주 승인 - 원자재 A103 2,000개 ₩2,400만" = STEP2 SCM 수직슬라이스(item A 발주)와 **동일 시나리오** → 다음 단계 연동 1순위.

### 3.3 Document ↔ 문서 기억 (실행부 기존 자산 재사용)
- `Document.content` → n8n `01 document-ingest` → `axos.memory.document_memory`(Vector Search).
- `Document.summary`(현재 null) → `07 llm-route` 요약 채움. `09 vector-reindex`로 재색인.

### 3.4 감사·멱등 (ops 스키마)
- `axos.ops.decision_envelope`: decision_id PK(멱등키). mock=jsonl/인메모리 → live=Delta.
- `axos.ops.audit`: append-only. 이벤트(decided/approved/rejected/executed/failed/compensated). STEP10 대시보드·STEP9 업무기억 원천.

## 4. live 전환 시 변경점 (계약 불변, 어댑터만)
| 구성 | mock(현재) | live(Databricks) |
|------|-----------|------------------|
| 판단 | `agents/*.cjs` 룰 | Mosaic AI Model Serving / Workflows |
| 결정 저장 | jsonl/메모리 | `axos.ops.decision_envelope` (Delta) |
| 감사 | jsonl | `axos.ops.audit` (Delta append) |
| 기억 | (없음) | `axos.memory.*` (Vector Search 4종) |
| 설정원 | env 폴백 | `DatabricksConfig` 엔티티 값 주입 |

## 5. STEP1 마감 → 다음 작업 연결
- ✅ 데이터모델 매핑 확정 → **STEP2(Unity Catalog/Delta 스키마 IaC)** 입력으로 이어짐.
- ▶ 다음 1순위: **WorkflowRequest 승인 카드 ↔ 브리지 `/approve` 콜백 연동**(실측 발주 시드 = STEP2 슬라이스와 동일, RESUME §4 TODO).
- ▶ alias 매핑(inventory→scm, purchasing→procurement)을 `agent_registry` 설계에 반영.
