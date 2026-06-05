# 00 · 마스터 아키텍처 청사진

> AXOS = **경험(Base44) · 판단(Databricks) · 실행(n8n)** 3레이어 + 이를 잇는 **실행 브리지**.
> 본 문서는 지시서의 STEP 1~10과 최종 목표를 단일 아키텍처로 통합한 청사진이다.

---

## 1. 설계 원칙 (Design Principles)

1. **판단과 실행의 분리.** Databricks는 "무엇을 해야 하는가"만 결정한다. n8n은 "그것을 실제로 한다". 두 책임을 한 시스템에 섞지 않는다 → 감사·롤백·권한이 명확해진다.
2. **모든 행동은 봉투(Decision Envelope)를 거친다.** 판단 결과는 자유 텍스트가 아니라 *구조화된 결정 봉투*로만 실행 레이어에 전달된다. 봉투에는 결정·근거·신뢰도·승인정책·만료시각이 들어간다. → `docs/04`.
3. **Contract-first, Mock-first.** 외부 시스템(Databricks/ERP/레거시)이 없어도 계약(JSON Schema)과 mock으로 end-to-end가 돌아간다. live 전환은 어댑터 교체뿐. (기존 n8n 01~10이 이미 이 패턴.)
4. **Human-in-the-loop는 기본값.** 되돌릴 수 없거나 외부로 나가는 행동(발주, 메일 발송, ERP 쓰기)은 기본적으로 사람 승인 게이트를 통과한다. 신뢰가 쌓인 시나리오만 단계적으로 자동화 레벨을 올린다 (→ `docs/03` 자동화 성숙도 L0~L4).
5. **레거시는 교체가 아니라 감싼다.** ERP/MES를 걷어내지 않는다. 읽기는 CDC/배치로 수집, 쓰기는 어댑터로 위임 → 기존 시스템·기존 담당자의 저항을 최소화 (→ `docs/02`, `docs/03`).
6. **단일 사실 원천(SSOT)은 Unity Catalog.** 모든 레거시 데이터는 Lakehouse로 흘러들어와 거버넌스·계보(lineage)·권한이 한곳에서 관리된다.

---

## 2. 레이어 모델

### 2.1 경험 레이어 — Base44
- **역할**: 사용자 인터페이스. AI Copilot 채팅, Agent 지시, 결과 확인, 승인 버튼, 운영 대시보드(STEP10).
- **보유**: 엔티티(데이터 모델), 화면, 내장 API. (STEP1에서 분석 — Base44 MCP 연결 후)
- **AXOS와의 접점**:
  - Base44 → (질의/이벤트/승인) → Databricks·n8n
  - Databricks·n8n → (결과/콜백/알림) → Base44 표시
- **연결 방식**: Base44는 외부 HTTP를 호출(`N8N_BASE_URL`, 향후 `JUDGMENT_BASE_URL`)하고, 콜백 URL로 결과를 수신. 현재 mock 콜백 서버(`../n8n-pipeline/mock`)가 Base44 미완 부분을 대신.

### 2.2 판단 레이어 — Databricks
- **Unity Catalog**: 전사 데이터·AI 자산의 거버넌스·권한·계보. 카탈로그/스키마/테이블/볼륨/모델/벡터인덱스 통합 관리. → SSOT.
- **Delta Lake**: 레거시(ERP/MES/CRM/SCM/HR/IoT)에서 수집된 데이터의 저장·버전·ACID. Bronze→Silver→Gold 메달리온.
- **Vector Search**: 문서/대화/업무/프로젝트 기억의 임베딩 검색 (STEP9 Agent Memory의 저장소).
- **Mosaic AI**: 모델 서빙·평가·에이전트 추론. LLM 라우팅(STEP5/7)의 판단 엔진.
- **산출물**: 판단 레이어의 모든 출력은 `Decision Envelope`(또는 `Insight`) 계약으로 정규화.

### 2.3 실행 레이어 — n8n
- **역할**: 판단 결과를 실제 업무 행동으로 변환·수행. 승인·메일·메신저·ERP 업데이트·보고서 발송·이슈 대응 (STEP7).
- **현황**: `[BC44·파이프라인] 01~10` 전부 active(mock). 이것이 실행 레이어의 공통 런타임.
- **확장**: 6개 Agent(STEP6) 실행부 + 자동화(STEP7) + 예측 트리거(STEP8) 워크플로우.

### 2.4 실행 브리지 — Bridge (AXOS의 심장)
- 판단 레이어와 실행 레이어 사이의 **유일한 통로**. 직접 호출 금지, 항상 브리지 경유.
- 책임: ① 계약 검증 ② 거버넌스/권한 체크 ③ 승인 게이트(HITL) ④ 멱등성/중복 방지 ⑤ 감사 로그 ⑥ 실패/보상(compensation).
- 현재 `mock/bridge_server.cjs`로 구현(포트 4100), 추후 Databricks Workflows/Jobs 또는 경량 서비스로 승격.

---

## 3. 엔드투엔드 데이터 흐름 (대표 시나리오: "재고 부족 → 자동 발주 추천")

```
1. [Base44]  사용자가 "다음 주 결품 위험 품목 알려줘" 또는 야간 배치 트리거
2. [Bridge]  질의를 Databricks 판단 잡으로 라우팅 (계약: InsightRequest)
3. [Databricks]
      - Delta(Silver/Gold)에서 판매·재고·리드타임 조회
      - 수요예측 모델(Mosaic AI, STEP8) 추론
      - Vector Search로 과거 유사 상황·정책 문서 회수 (STEP9)
      - 결정: "품목 A 500개 발주 권장, 근거: 안전재고 미달+리드타임 7일+수요↑"
      → Decision Envelope 생성 (decision=create_po, confidence=0.86, approval=required)
4. [Bridge]  봉투 계약검증 → 거버넌스(발주 한도/권한) → 승인 게이트:
      - confidence·금액이 임계 초과 → Base44로 승인요청 카드 발송
5. [사람]    Base44에서 승인 (또는 반려/수정)
6. [Bridge]  승인됨 → Action Request로 변환 → n8n 호출
7. [n8n]     08 notify(담당자 알림) + ERP 발주 API 호출(어댑터) + 05 report-generate(발주 근거 리포트)
8. [n8n→Base44] 콜백: "발주 PO-1234 생성 완료" → 대시보드/이력 갱신
9. [Databricks] 행동·결과를 업무 기억(STEP9)에 적재 → 다음 판단 품질 향상
```

핵심: **3은 판단, 7은 실행, 4·6은 브리지**. 어느 한 단계도 다른 레이어의 책임을 침범하지 않는다.

---

## 4. STEP 1~10 ↔ 레이어 ↔ 컴포넌트 (요약)

| STEP | 주제 | 주 레이어 | 핵심 컴포넌트 | 기존 n8n 01~10 연결 |
|------|------|-----------|---------------|---------------------|
| 1 | Base44 앱 분석 | 경험 | 엔티티/화면/API 인벤토리 | — (분석 산출물) |
| 2 | Databricks 연결 | 판단 | UC·Delta·VectorSearch·Mosaic | — |
| 3 | Enterprise Data Fabric | 판단 | 9종 소스 수집 → Bronze | 01 document-ingest, 03 web-crawl |
| 4 | 데이터 파이프라인 | 판단 | Workflows: Streaming/Batch/CDC | 09 vector-reindex |
| 5 | AI Copilot | 경험+판단 | NL질의·SQL생성·리포트·차트 | 02 rag-chat, 05 report-generate, 07 llm-route |
| 6 | 6 Agent | 판단+실행 | Sales/SCM/Proc/Fin/HR/Quality | 04 evaluation-simulate, 06 wbs-delay-check |
| 7 | n8n 자동화 | 실행 | 승인·메일·메신저·ERP·보고·이슈 | 08 notify + 전 파이프라인 |
| 8 | 예측 AI | 판단 | 수요/매출/납기/불량/설비고장 | 04 evaluation-simulate |
| 9 | Agent Memory | 판단 | Vector Search 4종 기억 | 01 ingest, 02 rag-chat, 09 reindex |
| 10 | 운영 대시보드 | 경험 | 사용량·ROI·절감시간·KPI | 10 health, 08 notify |

상세 매핑·진척·의존성은 → [01_step_mapping.md](01_step_mapping.md).

---

## 5. 배포 위상 (Deployment Topology)

```
┌─ 경험 ─────────────┐   ┌─ 판단 ──────────────────────┐   ┌─ 실행 ───────────┐
│ Base44 (SaaS)      │   │ Databricks (Cloud/Mock)      │   │ n8n (로컬 native)│
│  app 6a22…         │   │  Unity Catalog               │   │  v2.57.1         │
│                    │   │  Delta / Vector / Mosaic     │   │  01~10 + agents  │
└────────┬───────────┘   └──────────┬───────────────────┘   └────────┬─────────┘
         │ HTTPS                     │  (mock: bridge_server 4100)     │ webhook
         │  ┌────────────────────────┴─────────────────────────────────┘
         └─▶│  실행 브리지 (Bridge)  ── 계약검증·거버넌스·승인·감사       │
            └────────────────────────────────────────────────────────────┘
 외부 노출: ngrok 고정도메인 https://hardware-finalize-faceted.ngrok-free.dev → n8n:5678
 콜백:      mock_callback_server.cjs:4000 (Base44 콜백 수신부 미완 대체)
```

- **현재(mock 단계)**: Databricks 자리에 `mock/bridge_server.cjs`(판단+브리지 통합 mock). n8n은 실 구동.
- **live 단계**: bridge_server를 Databricks Jobs/Model Serving + 경량 브리지로 교체. 계약은 불변.

---

## 6. 보안·거버넌스 (요약)

- 모든 외부 행동은 토큰 인증(`N8N_WEBHOOK_TOKEN`/브리지 토큰)·승인 게이트·감사 로그를 통과.
- Unity Catalog가 데이터 권한의 단일 통제점. Agent별 최소권한.
- HITL 기본값, 자동화 성숙도(L0~L4) 단계적 상향.
- 상세 → [06_governance_security.md](06_governance_security.md).

---

## 7. 다음 작업 (이 청사진 이후)

1. **STEP1 실행**: Base44 MCP 연결(→`docs/07`) → 엔티티/화면/API 인벤토리 작성.
2. **브리지 mock end-to-end**: `mock/bridge_server.cjs` + n8n 01~10 연동 스모크 통과.
3. **Databricks 자격증명 확보 시**: UC 카탈로그/스키마 IaC, Bronze 수집 1종(예: 회의록 또는 ERP 샘플) live 전환.
4. **Agent 1종 수직 슬라이스**: SCM Agent(재고 예측→발주 추천)를 판단→브리지→실행까지 관통 구현 (대표 시나리오 §3).
