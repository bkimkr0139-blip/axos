# 08 · Databricks live 전환 가이드

> 현재 판단 레이어는 mock(`agents/scm_agent.cjs`). 워크스페이스 확보 시 아래 순서로 live 전환한다.
> **계약(contracts/) 불변** — 바뀌는 건 어댑터 구현과 데이터 위치뿐.

## 0. 선결: 자격증명
- Databricks 워크스페이스(URL) + PAT(개인 액세스 토큰). Unity Catalog 활성.
- ⚠️ 토큰은 repo 커밋 금지(.gitignore의 .env). 환경변수로만:
```
DATABRICKS_HOST=adb-xxxx.xx.azuredatabricks.net
DATABRICKS_TOKEN=dapi....
DATABRICKS_SERVING_ENDPOINT=axos-judge
```

## 1. 데이터 기반 (STEP2/3)
1. `scripts/databricks/01_unity_catalog_setup.sql` 실행 → 카탈로그 `axos` + bronze/silver/gold/audit/memory.
2. 레거시 수집(docs/02): 첫 소스 1종(예: SCM 재고)을 Bronze에 적재 → Silver 정규화 → `axos.gold.stock`/`demand_features`/`supplier_perf` 채움.
3. 권한(docs/06): Agent 서비스주체에 gold 읽기 + audit 쓰기 GRANT. 민감(HR) 마스킹.

## 2. 판단 전환 (mock agent → Databricks)
- `adapters/databricks_judge.cjs` 가 드롭인. `handle(req)` 시그니처 동일(DecisionEnvelope 반환).
- `mock/bridge_server.cjs` 의 라우팅을 모드 분기로:
```js
const useLive = process.env.PIPELINE_MODE === 'live';
const dbx = require('../adapters/databricks_judge.cjs');
async function judgeRouted(req){
  if (useLive && dbx.isConfigured()) {
    try { return await dbx.handle(req); }      // Databricks Model Serving
    catch(e){ /* 폴백 */ }
  }
  return judge(req);                            // mock agent
}
```
- Model Serving 엔드포인트 `axos-judge` 는 입력 `{intent, context, query}` → 출력 **DecisionEnvelope JSON**.
  (Mosaic AI: 예측모델 + RAG(Vector Search) + 규칙을 묶은 체인. evidence·approval_policy 필수 — 없으면 브리지가 거부.)

## 3. 예측 모델 (STEP8)
- 수요/매출/납기/불량/설비고장 모델을 Mosaic AI에 서빙 → judge 체인이 호출.
- 평가: 기존 n8n `04 evaluation-simulate` + Mosaic AI 평가로 회귀 감지.

## 4. 감사·기억 전환 (STEP9, STEP10)
- 감사: `mock/audit.jsonl` → `axos.audit.decision_log` (append). 브리지 audit()를 Delta 적재로 교체.
- 업무기억: 실행 결과를 `axos.memory.task_memory` 적재 → Vector Search 인덱스 → 다음 judge가 회수(자가 향상).
- 대시보드(STEP10): `axos.audit.decision_log` 집계(사용량/ROI/절감시간/오류율) → Base44 렌더.

## 5. 실행 어댑터 live (쓰기)
- `adapters/erp_mock.cjs` → 실제 ERP API/BAPI 어댑터로 교체. 멱등키(decision_id)를 ERP 참조필드에 기록(docs/02 §5).
- 한도/드라이런/보상은 이미 계약·브리지에 존재 → 그대로 유지.

## 6. 전환 체크리스트
- [ ] UC 셋업 SQL 실행, gold 3테이블 채움
- [ ] 서비스주체 권한 GRANT
- [ ] `axos-judge` Model Serving 엔드포인트 배포(DecisionEnvelope 반환)
- [ ] bridge 라우팅에 live 분기 + 폴백
- [ ] audit → Delta, task_memory 적재 + Vector index
- [ ] ERP 어댑터 live(드라이런 먼저)
- [ ] 스모크 재실행(`scripts/smoke_bridge.ps1`) → mock과 동일 trace 확인
