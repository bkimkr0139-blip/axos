# 04 · 실행 브리지 — 판단(Databricks)→실행(n8n)

> AXOS가 "분석형"이 아니라 "실행형"이 되는 지점. 브리지는 판단 레이어의 *결정*을
> 실행 레이어의 *행동*으로 옮기는 **유일한 통로**이며, 동시에 거버넌스·승인·감사의 **단일 관문**이다.

---

## 1. 왜 브리지인가

Databricks가 n8n을 직접 호출하면 안 되는 이유:
- 판단 로직 안에 승인·권한·멱등·감사가 흩어진다 → 통제 불가.
- 판단과 실행이 강결합 → live/mock 전환·교체 불가.

그래서 **모든 판단 결과는 `Decision Envelope` 하나로 정규화**되고, 브리지만이 이를 받아 검증·승인·실행 변환한다.

```
Databricst 판단 ──(Decision Envelope)──▶ [Bridge] ──(Action Request)──▶ n8n 실행
                                            │
                                            ├─ 1. 계약 검증 (schema)
                                            ├─ 2. 거버넌스 (권한·한도·정책)
                                            ├─ 3. 승인 게이트 (HITL, L0~L4)
                                            ├─ 4. 멱등성 (decision_id 중복 차단)
                                            ├─ 5. 실행 라우팅 (어느 n8n 워크플로우/어댑터)
                                            ├─ 6. 감사 로그 (누가·언제·무엇·왜)
                                            └─ 7. 결과/보상 (실패 시 compensation)
```

---

## 2. 3대 계약 (contracts/bridge/)

### 2.1 `InsightRequest` — 경험/스케줄 → 판단
경험 레이어(Base44) 또는 스케줄러가 판단을 요청. (질의·이벤트)
```
{ request_id, source: "base44|schedule|agent", intent, query, context, requested_by, ts }
```

### 2.2 `DecisionEnvelope` — 판단 → 브리지  ⭐ 핵심 계약
판단 레이어의 **모든** 출력은 이 봉투. (→ `contracts/bridge/decision_envelope.schema.json`)
```
{
  decision_id,            // 멱등키. 이 결정의 고유 ID
  agent,                  // sales|scm|procurement|finance|hr|quality|copilot
  decision,               // create_po | send_alert | generate_report | ...
  summary,                // 사람이 읽는 한 줄 ("품목 A 500개 발주 권장")
  evidence: [ ... ],      // 근거(데이터/문서/예측). 신뢰의 핵심 — 비면 거부
  confidence,             // 0~1
  proposed_actions: [ { type, target_system, payload, dry_run_supported } ],
  approval_policy: {      // L0~L4 매핑
     level,               // auto | approval_required | dual_approval
     reason,              // 왜 이 정책인지(금액 초과 등)
     approvers            // 역할/사람
  },
  guardrails: { amount_limit, qty_limit, expires_at },
  ts
}
```

### 2.3 `ActionRequest` — 브리지 → n8n 실행
승인·검증을 통과한 결정이 실행 가능한 형태로 변환된 것. (→ `contracts/bridge/action.schema.json`)
```
{ action_id, decision_id, workflow: "08-notify|...", target_system, payload, dry_run, callback_url, token, ts }
```

### 2.4 `ActionResult` — n8n → 브리지 → 경험
```
{ action_id, decision_id, status: "succeeded|failed|compensated", result, error?, ts }
```

---

## 3. 승인 게이트 (HITL) — 자동화 성숙도 연결

브리지는 `DecisionEnvelope.approval_policy.level` 과 `guardrails` 로 다음을 판정:

| 조건 | 게이트 |
|------|--------|
| 읽기/조회/리포트 | 통과(auto) — L1~L2 |
| 외부 발송·내부 쓰기, 한도 내, confidence≥임계 | 승인 요청 → Base44 카드 — L3 |
| 한도 초과·민감·저신뢰 | 이중 승인 또는 거부 — L3/거부 |
| 검증된 시나리오·한도 내·플래그 on | 자동 실행 + 사후 감사 — L4 |

승인 요청은 `08 notify` 또는 Base44 승인 카드로 발송. 승인 응답이 브리지로 돌아오면 ActionRequest 발행.

---

## 4. 실행 라우팅 — 결정 → n8n 워크플로우 매핑

| decision | 실행 워크플로우(현행) | 비고 |
|----------|----------------------|------|
| `send_alert` | `08 notify` | 임계/이상 알림 |
| `generate_report` | `05 report-generate` | 근거 리포트 |
| `index_document` | `01 document-ingest` | 문서 기억 적재 |
| `reindex_vector` | `09 vector-reindex` | 재색인 |
| `rag_answer` | `02 rag-chat` | Copilot 응답 |
| `route_llm` | `07 llm-route` | 요약/라우팅 |
| `check_wbs_delay` | `06 wbs-delay-check` | 프로젝트 지연 |
| `simulate_eval` | `04 evaluation-simulate` | 예측/시뮬 |
| `create_po` | ERP 발주 어댑터(추후) + 08 | I3/I4, 승인 필수 |
| `send_email` | 이메일 발송 도구(기존) + 08 | 외부 발송 승인 |

---

## 5. 멱등성·보상·감사

- **멱등성**: `decision_id` 를 브리지 상태저장소(현 mock: 인메모리/파일, live: Delta 테이블)에 기록. 동일 ID 재유입 시 기존 결과 반환, 재실행 안 함.
- **보상(Compensation)**: `proposed_actions[].compensation` 에 취소 경로 정의. 실패/철회 시 실행.
- **감사 로그**: 모든 봉투·승인·실행을 `axos_audit`(live: Delta, mock: jsonl)에 적재 → STEP10 대시보드·STEP9 업무기억 원천.

감사 레코드:
```
{ audit_id, decision_id, action_id?, agent, actor(ai|user), event(decided|approved|rejected|executed|failed|compensated),
  summary, evidence_ref, confidence, value?, ts }
```

---

## 6. 구현 단계

| 단계 | 형태 | 상태 |
|------|------|------|
| mock | `mock/bridge_server.cjs` (포트 4100): 판단 mock + 브리지 + n8n 호출 | ⏳ 이번 세션 스캐폴딩 |
| live(경량) | 브리지를 독립 서비스로, 판단만 Databricks Model Serving/Jobs 호출 | ⬜ |
| live(통합) | Databricks Workflows가 봉투 생성, 브리지가 UC/Delta에 감사 적재 | ⬜ |

계약(§2)은 세 단계 모두 **불변**. 바뀌는 건 어댑터 구현뿐.

---

## 7. mock end-to-end (이번 세션 검증 대상)

```
[smoke_bridge.ps1]
  → POST bridge:4100/insight  { intent: "stock_risk" }
  → bridge가 mock 판단 생성: DecisionEnvelope{ decision: send_alert, confidence: 0.9, approval: auto }
  → bridge가 ActionRequest로 변환 → n8n 08 notify(webhook) 호출
  → n8n mock 응답 + mock_callback(4000)
  → bridge가 ActionResult 집계 + 감사 jsonl 기록
  → 콘솔에 end-to-end 추적 출력
```
이 흐름이 통과하면 "판단→브리지→실행→감사"의 골격이 실재로 동작함을 입증한다(Databricks 없이).
