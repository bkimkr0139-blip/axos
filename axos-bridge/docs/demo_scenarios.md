# AXOS 영업 데모 / PoC 시나리오 (Databricks + MX-Flow + MX-AI)

> 작업지시서 7단계. 각 시나리오는 "근거(Databricks) → 판단(AX Copilot) → 실행(MX-Flow) → 승인/거버넌스 → 감사" 루프를 보여준다.
> 데모는 FastAPI 브리지(:8000) 또는 외부화된 브리지로 동작. Databricks 미연결 구간은 mock 근거로 시연.

---

## 시나리오 1 — 제조 재고 결품 예측 → 구매 자동화

- **고객 Pain Point**: 결품으로 인한 생산 중단·긴급 발주 비용. 수요 변동 대응 지연.
- **연결 데이터**: ERP 재고/입출고, SCM 리드타임, 판매 추이 → `bronze.scm_leadtime` → `silver.items` → `gold.stock`.
- **Databricks 사용 기능**: 수요예측(Mosaic AI), Unity Catalog 계보, AI Search(재주문 정책 문서 근거).
- **MX-Flow workflow 단계**: `wf_inventory_purchase_request` → 발주 수량 산정 → 구매 요청서 생성 → 승인 라우팅 → ERP 발주 → 담당자 알림(08 notify).
- **MX-AI 화면 흐름**: AX Copilot 질의 → 근거 카드(결품확률·계보) → 시뮬레이션 → 결재 센터 → 실행 결과.
- **승인/거버넌스**: 발주금액 > 임계 → 승인 필수, > 1천만 → 이중승인. 외부 쓰기 → 결재 필수. 킬스위치/보상 가능.
- **기대 효과**: 결품 회피, 긴급 발주 비용↓, 발주 리드타임 단축(예: 6h 업무 절감/건).
- **데모 클릭 순서**:
  1. Copilot: "다음 달 결품 위험 품목 구매 요청 준비" → `intent=inventory_shortage_prevention`
  2. 근거 8건 + 결품확률 0.99 확인 → "시뮬레이션 보기"(절감액·단계)
  3. "결재 요청 확인" → 승인 센터에서 승인(RBAC·SoD)
  4. MX-Flow 실행 → execution_id → 실행 로그/알림 확인 → 감사 로그

## 시나리오 2 — 품질 불량 이상 감지 → 원인 분석 → 리포트

- **Pain Point**: 불량 원인 파악 지연, 라인/설비 상관 분석 수작업.
- **연결 데이터**: MES 검사/공정 이벤트, IoT 센서 → `bronze.mes_events` → `silver.mes_inspection`.
- **Databricks 기능**: 불량예측(Model Serving), 설비 상관 분석(SQL Warehouse), 과거 품질 이슈 검색(Vector Search).
- **MX-Flow**: `wf_quality_issue_report` → 원인 시뮬(04 evaluation-simulate) → 품질 리포트(05) → 담당자 알림(08).
- **MX-AI 흐름**: Copilot "라인3 불량 원인 분석" → 근거(설비 EQP-3B 상관 0.81) → 리포트 생성 → 알림.
- **승인/거버넌스**: 읽기·리포트 중심(중위험) → 승인 대기. 쓰기 없음.
- **기대 효과**: 원인 분석 시간↓(예: 8h/건), 재발 방지.
- **데모 클릭**: Copilot 질의 → 근거/상관 → 리포트 → 알림 → 감사.

## 시나리오 3 — 재무 예산 초과 감지 → 증빙 검색 → 결재 → ROI 보고

- **Pain Point**: 예산 초과 인지 지연, 증빙 수집/결재 지연, 경영 가시성 부족.
- **연결 데이터**: ERP 전표/비용, 예산 → `bronze.erp_orders` → `gold.cost_daily`.
- **Databricks 기능**: 비용 이상 탐지(SQL), 증빙 문서 검색(AI Search), 계보로 신뢰성 제시.
- **MX-Flow**: `wf_finance_alert` → 초과 항목 식별 → 증빙 검색 → 결재 요청 → 경영진 ROI 보고.
- **MX-AI 흐름**: Copilot "이번 달 예산 초과 항목과 증빙" → 근거(클라우드 118%) → 결재 → ROI Center Before/After.
- **승인/거버넌스**: 금액 임계 → 팀장/임원 승인. 보안 데이터 시 보안 승인.
- **기대 효과**: 예산 통제 적시성, 결재 리드타임↓, 경영 ROI 가시화.
- **데모 클릭**: Copilot 질의 → 초과/증빙 → 결재 → ROI Center 수치 → 감사.

---

## 공통 데모 메시지(브리지 호출 예시)
```bash
curl -X POST $BRIDGE/bridge/copilot/execute -H 'Content-Type: application/json' \
  --data-binary @msg.json   # msg.json: {"user_message":"...","user_role":"...","tenant_id":"customer-a"}
```
- 시나리오1: "다음 달 결품 위험 품목 구매 요청 준비"
- 시나리오2: "라인3 불량 원인 분석하고 품질 리포트 만들어줘"
- 시나리오3: "이번 달 예산 초과 항목과 증빙을 찾아 결재 요청해줘"

## 데모에서 강조할 3사 강점
- **Databricks**: 데이터 신뢰(계보/거버넌스), 예측/검색(Mosaic AI·Vector Search).
- **MX-Flow**: 실제 업무 자동화(워크플로우·webhook·실행로그).
- **MX-AI(Base44)**: 사용 편의·빠른 서비스화(자연어 Copilot·결재·대시보드).
- **거버넌스**: 자동화 리스크를 승인·이중승인·킬스위치·감사로 통제.
