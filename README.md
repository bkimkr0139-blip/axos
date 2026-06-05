# AXOS — Enterprise AX Operating System

> **AI 직원이 실제 업무를 수행하는 엔터프라이즈 AX 운영체제.**
> Base44(경험) · Databricks(판단) · n8n(실행)을 하나로 묶어
> "분석형 AI"가 아니라 **"실행형 AX 솔루션"** 을 만든다.

---

## 핵심 명제 (The Thesis)

| 레이어 | 역할 | 한 문장 | 구현 스택 |
|--------|------|---------|-----------|
| **경험 (Experience)** | 사람과 대화·지시·확인 | "사람이 AI에게 일을 시키고, 결과를 본다" | **Base44** (App ID `6a225124042c1a7db62f27fb`) |
| **판단 (Judgment)** | 데이터를 이해하고 결정 | "무엇을, 왜, 어떻게 해야 하는가" | **Databricks** (Unity Catalog / Delta / Vector Search / Mosaic AI) |
| **실행 (Action)** | 결정을 실제 업무로 수행 | "결정된 일을 진짜로 한다" | **n8n** (워크플로우 01~10 + 6 Agent + 자동화) |

**판단(Databricks)** 과 **실행(n8n)** 을 분리하되, 그 사이를 **실행 브리지(Decision Envelope)** 로 잇는 것이 AXOS의 설계 심장이다.
판단 레이어는 "이 발주를 승인해야 한다"는 *결정*만 내리고, 실행 레이어가 그 결정을 ERP 발주·메일·승인요청 등 *행동*으로 옮긴다.

```
[사람] ──지시──▶ Base44 (경험)
                   │ 질의/이벤트
                   ▼
              Databricks (판단)  ── Unity Catalog · Delta · Vector Search · Mosaic AI
                   │ Decision Envelope (판단 결과 + 근거 + 승인정책)
                   ▼
              ╔══ 실행 브리지 (Bridge) ══╗   ← 거버넌스/승인/감사 게이트
                   │ Action Request
                   ▼
                 n8n (실행)  ── 01~10 파이프라인 · 6 Agent · 승인/메일/ERP/보고
                   │ 결과/콜백
                   ▼
              Base44 (경험)  ──결과 표시──▶ [사람]
```

---

## 현재 상태 (2026-06-05 기준)

- ✅ **실행 레이어 토대 완료**: 로컬 n8n v2.57.1에 `[BC44·파이프라인] 01~10` 전부 active (mock 모드). → `../n8n-pipeline/`
- ⏳ **판단 레이어**: Databricks 워크스페이스 미확보 → **contract·mock 우선**으로 설계·스캐폴딩 (이 repo). 자격증명 확보 시 live 전환.
- ⏳ **경험 레이어**: Base44 앱 `6a22…` 존재. STEP1 분석은 Base44 MCP 연결 후 진행 (→ `docs/07_base44_mcp_setup.md`).
- ❌ GitHub MCP 미연결 — git/gh CLI로 신규 `axos` repo 백업 예정 (push는 사용자 승인 시).

---

## 문서 지도

| 문서 | 내용 |
|------|------|
| [docs/00_architecture_blueprint.md](docs/00_architecture_blueprint.md) | 마스터 아키텍처 청사진 — 3레이어 모델, 데이터 흐름, 배포 위상 |
| [docs/01_step_mapping.md](docs/01_step_mapping.md) | 지시서 STEP 1~10 → 컴포넌트 매핑 + 기존 n8n 01~10 연결 + 진척/의존성 |
| [docs/02_legacy_integration.md](docs/02_legacy_integration.md) | ERP/MES/CRM/SCM/HR/Mail/File/DB/IoT 레거시 연계·통합 전략 |
| [docs/03_ax_transformation_playbook.md](docs/03_ax_transformation_playbook.md) | AX전환을 "물 흐르듯·사내 저항 없이" — 단계별 변화관리 플레이북 |
| [docs/04_databricks_n8n_bridge.md](docs/04_databricks_n8n_bridge.md) | 판단→실행 브리지 설계 (Decision Envelope, 승인 게이트, 감사) |
| [docs/05_agents_spec.md](docs/05_agents_spec.md) | 6 Agent 사양 (Sales/SCM/Procurement/Finance/HR/Quality) + Memory |
| [docs/06_governance_security.md](docs/06_governance_security.md) | 거버넌스·보안·권한·감사·HITL(Human-in-the-loop) |
| [docs/07_base44_mcp_setup.md](docs/07_base44_mcp_setup.md) | Base44 MCP 연결 절차 → STEP1 앱 분석 착수 가이드 |

## 코드/계약

- `contracts/bridge/` — 판단·실행·봉투 JSON Schema (판단 레이어와 실행 레이어의 무계약 결합 방지)
- `contracts/agents/` — 6 Agent I/O 계약
- `mock/` — Databricks 판단 mock 어댑터 + 실행 브리지 서버 (Databricks 미연결 상태에서 end-to-end 검증)
- `scripts/` — 스모크 테스트

---

## 빠른 시작 (mock end-to-end)

```powershell
# 1. n8n 실행 레이어가 떠 있어야 함 (../n8n-pipeline/RESUME.md 참조)
curl http://localhost:5678/webhook/health

# 2. 판단→실행 브리지 mock 기동 (Databricks 흉내)
node C:\Users\User\works\base44\axos\mock\bridge_server.cjs   # 포트 4100

# 3. 스모크: 판단 요청 → Decision Envelope → n8n 실행 → 콜백
powershell -File C:\Users\User\works\base44\axos\scripts\smoke_bridge.ps1
```

자세한 재개 절차는 추후 `RESUME.md`로 정리한다 (n8n-pipeline와 동일 패턴).
