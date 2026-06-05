# 01 · STEP 1~10 매핑 · 진척 · 의존성

> 지시서의 10개 STEP을 컴포넌트로 분해하고, 기존 n8n `01~10` 파이프라인과 연결하며,
> 각 항목의 **상태**(✅완료 / ⏳진행/설계 / ⬜대기)와 **선행 의존성**을 명시한다.
> 누락 방지를 위해 지시서 항목을 **빠짐없이** 나열한다.

범례: ✅ 완료 · ⏳ 설계/스캐폴딩 · ⬜ 대기(외부 의존)

---

## STEP 1 — Base44 앱 분석
| 항목 | 상태 | 비고 |
|------|------|------|
| 데이터 모델(Entities) 분석 | ⬜ | Base44 MCP 연결 후 (→ docs/07). 산출: 엔티티 인벤토리·ERD |
| 화면 분석 | ⬜ | 화면→Agent/Copilot 진입점 매핑 |
| API 분석 | ⬜ | Base44 내장 API·외부 호출(`N8N_BASE_URL`) 목록화 |
**선행**: Base44 MCP 연결. **산출물**: `docs/step1_base44_inventory.md`(예정).

---

## STEP 2 — Databricks 연결 (구성·생성)
| 항목 | 상태 | 비고 |
|------|------|------|
| Unity Catalog | ⏳ | 카탈로그/스키마 IaC 설계(mock). live: 자격증명 필요 |
| Delta Lake | ⏳ | 메달리온(Bronze/Silver/Gold) 스키마 설계 |
| Vector Search | ⏳ | 4종 기억 인덱스 설계(STEP9 연계) |
| Mosaic AI | ⏳ | 모델 서빙·평가 엔드포인트 계약(판단 출력=Decision Envelope) |
**선행**: Databricks 워크스페이스+PAT. 현재 **contract·mock 우선**.

---

## STEP 3 — Enterprise Data Fabric (수집 대상 9종)
| 소스 | 상태 | 수집 방식(설계) | 연계 n8n |
|------|------|-----------------|----------|
| ERP | ⏳ | CDC(주문/재고/회계) → Bronze | 어댑터(추후) |
| MES | ⏳ | 설비/공정 이벤트 스트리밍 → Bronze | 08 notify(이상시) |
| CRM | ⏳ | 배치(고객/상담) → Bronze | — |
| SCM | ⏳ | 배치+CDC(재고/리드타임) → Bronze | 06 wbs-delay-check |
| HR | ⏳ | 배치(인사/근태) → Bronze | — |
| Mail | ⏳ | API 수집(메일 본문/첨부) → Bronze+Vector | 01 document-ingest |
| File | ⏳ | 볼륨/오브젝트 스토리지 → Bronze+Vector | 01 document-ingest |
| Database | ⏳ | JDBC/CDC(레거시 DB) → Bronze | — |
| IoT | ⏳ | 스트리밍(센서) → Bronze | 08 notify(임계) |
**선행**: STEP2. 상세 연계 전략 → [02_legacy_integration.md](02_legacy_integration.md).

---

## STEP 4 — 데이터 파이프라인 (Databricks Workflows)
| 항목 | 상태 | 비고 |
|------|------|------|
| Streaming | ⏳ | MES/IoT 실시간(Structured Streaming/DLT) |
| Batch | ⏳ | CRM/HR 야간 배치 |
| CDC | ⏳ | ERP/DB 변경데이터 캡처 → Silver upsert |
| (연계) 벡터 재색인 | ✅ | 기존 n8n `09 vector-reindex` 가 실행부 담당 |
**선행**: STEP3.

---

## STEP 5 — AI Copilot
| 기능 | 상태 | 연계 n8n / 컴포넌트 |
|------|------|---------------------|
| 자연어 질의 | ✅(실행부) | `02 rag-chat` |
| 데이터 분석 | ⏳ | Databricks Genie/SQL + 판단 레이어 |
| 자동 SQL 생성 | ⏳ | Mosaic AI text2sql → UC 권한 내 실행 |
| 보고서 생성 | ✅(실행부) | `05 report-generate` |
| 차트 생성 | ⏳ | Base44 화면 렌더 + 데이터는 판단레이어 |
| 요약 생성 | ✅(실행부) | `07 llm-route` (요약 라우팅) |
**선행**: STEP2,3,4. Copilot 진입점은 Base44(경험).

---

## STEP 6 — 6 Agent (전부 명시)
| Agent | 임무 | 상태 | 대표 시나리오 | 연계 |
|-------|------|------|---------------|------|
| **Sales Agent** | 영업 분석 | ⏳ | 파이프라인/실적 이상 → 알림·리포트 | 05,08 |
| **SCM Agent** | 재고 예측 | ⏳ | 결품 위험 → 발주 추천(승인) | 06,08, 브리지 |
| **Procurement Agent** | 발주 추천 | ⏳ | 추천→승인→ERP 발주 | 08, ERP 어댑터 |
| **Finance Agent** | 재무 분석 | ⏳ | 비용 임계/이상 → 경보·리포트 | 05,08 |
| **HR Agent** | 인사 분석 | ⏳ | 근태/이직위험/충원 인사이트 | 05 |
| **Quality Agent** | 품질 이상 탐지 | ⏳ | 불량 패턴 탐지 → 이슈 생성·대응 | 04,08 |
공통 사양·계약 → [05_agents_spec.md](05_agents_spec.md). **선행**: STEP2~5, 브리지.

---

## STEP 7 — n8n 자동화 (전부 명시)
| 자동화 | 상태 | 연계 n8n |
|--------|------|----------|
| 승인(Approval) | ⏳ | 브리지 승인 게이트 + Base44 카드 |
| 메일 | ✅(토대) | 기존 `[BC·서브] 이메일 발송 도구` + 08 |
| 메신저 | ✅(토대) | 기존 텔레그램 통합 비서/봇 |
| ERP 업데이트 | ⬜ | ERP 쓰기 어댑터(추후) |
| 보고서 발송 | ✅ | 05 report-generate + 08 notify |
| 이슈 대응 | ⏳ | Quality/SCM Agent → 이슈 워크플로우 |
| 자동화(일반) | ✅(토대) | 01~10 공통 런타임 |
**핵심**: STEP7은 실행 레이어 그 자체. 기존 자산 재사용 비중이 가장 높다.

---

## STEP 8 — 예측 AI (전부 명시)
| 예측 | 상태 | 비고 |
|------|------|------|
| 수요예측 | ⏳ | SCM Agent 입력. Mosaic AI 모델 |
| 매출예측 | ⏳ | Sales/Finance Agent 입력 |
| 납기예측 | ⏳ | SCM/WBS(06) 연계 |
| 불량예측 | ⏳ | Quality Agent 입력. MES 데이터 |
| 설비고장예측 | ⏳ | IoT 스트리밍 + 예지보전 |
**실행부**: `04 evaluation-simulate`(시뮬레이션). **선행**: STEP3,4.

---

## STEP 9 — Agent Memory (Databricks Vector Search, 4종 전부)
| 기억 | 상태 | 인덱스(설계) | 연계 n8n |
|------|------|---------------|----------|
| 대화 기억 | ⏳ | conversation_memory | 02 rag-chat |
| 문서 기억 | ✅(실행부) | document_memory | 01 ingest, 09 reindex |
| 업무 기억 | ⏳ | task_memory(행동·결과 적재) | 브리지 감사로그 → 적재 |
| 프로젝트 기억 | ⏳ | project_memory(WBS/이슈) | 06 wbs-delay-check |
**선행**: STEP2(Vector Search). 상세 → docs/05 Memory 절.

---

## STEP 10 — 운영 대시보드 (실시간, 지표 전부)
| 지표 | 상태 | 출처 |
|------|------|------|
| Agent 사용량 | ⏳ | 브리지 감사로그 집계 |
| ROI | ⏳ | (절감시간×인건비) − 운영비 |
| 자동화 효과 | ⏳ | 자동처리 건수/성공률 |
| 업무 절감시간 | ⏳ | 시나리오별 표준공수×건수 |
| KPI | ⏳ | 도메인 KPI(영업/재고/품질…) |
| 실시간 제공 | ✅(토대) | 10 health + 08 notify, Base44 렌더 |
**선행**: 브리지 감사로그 스키마(→ docs/04, docs/06).

---

## 의존성 그래프 (요약)

```
STEP1(Base44분석) ──┐
STEP2(Databricks) ──┼─▶ STEP3(Fabric) ─▶ STEP4(파이프라인) ─┬─▶ STEP5(Copilot)
                    │                                        ├─▶ STEP8(예측)
                    └─▶ STEP9(Memory) ◀──────────────────────┘
                                                             │
STEP6(Agent) ◀── STEP4,5,8,9 + 브리지 ──▶ STEP7(n8n 자동화) ──▶ STEP10(대시보드)
```

**임계경로**: STEP2(또는 mock) → 브리지 → SCM Agent 수직슬라이스 → 나머지 Agent 수평 확장.
이번 세션은 **브리지 contract+mock**과 **6 Agent 계약**을 완결해 임계경로의 병목을 먼저 제거한다.
