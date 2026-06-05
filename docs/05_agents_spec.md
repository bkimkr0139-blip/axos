# 05 · 6 Agent 사양 + Agent Memory

> STEP6의 6개 Agent와 STEP9 Agent Memory. 모든 Agent는 **동일한 골격**을 따른다:
> 입력(트리거/질의) → 판단(Databricks: 데이터+예측+기억) → `DecisionEnvelope` 출력 → 브리지 → 실행.
> Agent는 "분석"에서 끝나지 않고 **항상 실행 가능한 결정**을 낸다(실행형의 핵심).

---

## 1. Agent 공통 골격

```
Trigger(스케줄|이벤트|사용자질의)
   │
   ▼
Retrieve  ── Delta(Gold 피처) + Vector Search(관련 기억/정책 문서) + 예측모델(STEP8)
   │
   ▼
Reason    ── Mosaic AI: 상황 진단 → 결정 + 근거 + 신뢰도
   │
   ▼
Decide    ── DecisionEnvelope 생성 (decision, evidence, confidence, approval_policy, guardrails)
   │
   ▼
[Bridge]  ── 검증·승인·실행 (docs/04)
   │
   ▼
Remember  ── 행동·결과를 업무기억(task_memory)에 적재 → 다음 판단 개선
```

공통 계약: `contracts/agents/agent_io.schema.json` (입력 `AgentTrigger`, 출력 `DecisionEnvelope`).

---

## 2. Agent별 사양

### 2.1 Sales Agent — 영업 분석
- **입력**: CRM(파이프라인/상담), ERP(수주/매출), 매출예측(STEP8).
- **판단 예**: "B고객 이탈징후(상담 급감+결제지연) → 영업 개입 권장", "이달 매출 목표 미달 위험 78%".
- **결정**: `send_alert`(영업담당), `generate_report`(주간 영업 브리핑).
- **연계**: 05, 08. **레벨 시작**: L1.

### 2.2 SCM Agent — 재고 예측  ⭐ 권장 첫 수직슬라이스
- **입력**: SCM/ERP(재고·리드타임·판매), 수요예측·납기예측(STEP8), 정책문서(Vector).
- **판단 예**: "품목 A 다음주 결품위험, 안전재고 미달+리드타임 7일+수요↑ → 500개 발주 권장".
- **결정**: `create_po`(승인 필수, ERP 어댑터), `send_alert`, `generate_report`(발주 근거).
- **연계**: 06, 08, ERP 어댑터. **레벨**: L1→L2→L3(승인형 발주)→L4(한도내 자동).

### 2.3 Procurement Agent — 발주 추천
- **입력**: SCM Agent 결정, 공급사 성과(납기/품질), 단가/계약(Vector).
- **판단 예**: "동일 품목 공급사 3사 중 B사 추천(납기 안정+단가 -3%)".
- **결정**: `create_po` 보강(공급사·단가·조건), 이중승인 정책(금액 임계).
- **연계**: ERP 어댑터, 08. **레벨**: L2→L3.

### 2.4 Finance Agent — 재무 분석
- **입력**: ERP(전표/비용), 예산, 매출예측.
- **판단 예**: "이번달 클라우드 비용 임계 초과 추세 → 경보", "부서 X 예산 90% 소진".
- **결정**: `send_alert`(재무/부서장), `generate_report`(비용 이상 리포트).
- **연계**: 기존 `비용 임계 알림(cost_alerts)` 재사용, 05, 08. **레벨**: L1→L2.

### 2.5 HR Agent — 인사 분석
- **입력**: HR(인사/근태/조직) — **민감, UC 마스킹·접근통제 필수(docs/06)**.
- **판단 예**: "팀 Y 초과근무 급증+이직위험 상승 → 충원/면담 권장", 근태 이상.
- **결정**: `generate_report`(인사 인사이트), `send_alert`(인사담당). **쓰기 없음**.
- **레벨**: L1(읽기·인사이트 중심). 자동 실행 지양.

### 2.6 Quality Agent — 품질 이상 탐지
- **입력**: MES(공정/검사), IoT(센서), 불량예측(STEP8).
- **판단 예**: "라인 3 불량률 패턴 이상(특정 설비 상관) → 이슈 생성·점검 권장".
- **결정**: `send_alert`(품질/생산), `simulate_eval`(원인 시뮬), 이슈 생성.
- **연계**: 04, 08. **레벨**: L1→L2→L3(이슈 자동생성).

---

## 3. Agent Memory (STEP9) — Databricks Vector Search

4종 기억을 각각 인덱스로. Agent의 `Retrieve` 단계가 회수, `Remember` 단계가 적재.

| 기억 | 인덱스 | 내용 | 적재 원천 | 회수 사용처 |
|------|--------|------|-----------|-------------|
| 대화 기억 | `conversation_memory` | Copilot/Agent 대화 이력 | 02 rag-chat | 맥락 유지·후속질의 |
| 문서 기억 | `document_memory` | 회의록·계약·메일·파일 | 01 ingest, 09 reindex | 근거 회수(evidence) |
| 업무 기억 | `task_memory` | 과거 결정·행동·결과(감사로그) | 브리지 감사 → 적재 | 유사상황 판단 개선 |
| 프로젝트 기억 | `project_memory` | WBS·이슈·일정 | 06 wbs-delay-check | 프로젝트 맥락 판단 |

- **임베딩**: Databricks Vector Search(자체 임베딩 또는 Mosaic AI). mock: 키워드/스텁.
- **거버넌스**: 기억도 UC 권한 대상. HR 등 민감 기억은 접근 제한.
- **자가 향상 루프**: 업무기억(task_memory)에 "이 결정→이 결과(좋음/나쁨)"가 쌓이며 다음 판단 신뢰도·근거 품질이 올라간다. → 실행형 AX의 학습 고리.

---

## 4. 구현 현황 (2026-06-05)

1. ✅ **SCM Agent 수직슬라이스**(L1→L3): 판단(mock)→봉투→브리지→ERP어댑터+08 notify→감사→업무기억. 대표 시나리오 검증.
2. ✅ **공통 골격 템플릿화 → 6 Agent 전체**: `agents/_base.cjs` + scm/procurement/sales/finance/hr/quality. 브리지 INTENT_ROUTE 12 인텐트, AGENT_REGISTRY alias(inventory→scm, purchasing→procurement). STEP8 예측은 각 reason()에 mock 내장.
3. ✅ **Agent Memory 4종(mock)**: `memory/memory_mock.cjs`(remember/retrieve, jsonl) + 계약 `memory/memory.schema.json`. 실행완료→task_memory 적재, judge가 retrieve 회수. live Databricks Vector Search 시 드롭인 교체.

### live 전환(잔여)
- 판단: `adapters/databricks_judge.cjs`로 6 agent handle 교체(PIPELINE_MODE=live, 자격증명 필요).
- 기억: jsonl→Vector Search 인덱스. 감사: jsonl→Delta append. **계약 불변**.
