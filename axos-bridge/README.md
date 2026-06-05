# AXOS Bridge Server (FastAPI)

MX-AI(Base44) ↔ **Databricks**(판단) ↔ **MX-Flow**(n8n, 실행) 연계 브리지.
`AXOS_ClaudeCode_Integration_Guide_2026-06-05.md`의 Phase 1~5 구현체.

> 기존 Node mock 브리지(`../mock/bridge_server.cjs`, :4100)와 **별개 포트(기본 8000)**로 운영한다.
> Base44 화면은 점진적으로 이 FastAPI 브리지로 이전 가능(엔드포인트 `/bridge/*` 호환).

## 빠른 시작

```powershell
cd C:\Users\User\works\base44\axos\axos-bridge
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env          # 필요 값 입력(없어도 로컬 기동 가능)
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
# 문서 UI: http://localhost:8000/docs
```

설정이 없으면:
- **MX-Flow(n8n)**: `MXFLOW_BASE_URL` 기본 `http://localhost:5678`, API 키는 상위 `../.env`의 `N8N_API_KEY` 자동 재사용 → **실연계 동작**.
- **Databricks**: 미설정 시 `status=offline`, catalog/search는 **mock**으로 응답(자격증명 주입 시 실연결).

## 테스트

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest -q
```

## 주요 엔드포인트 (전체는 `/docs`)

| Method | Path | 설명 |
|---|---|---|
| GET | `/bridge/health` | Databricks/MX-Flow 상태 |
| GET | `/bridge/databricks/status` | MCP/SQL/Vector/Model 가용성, mode |
| GET | `/bridge/databricks/catalog` | Unity Catalog 메달리온(미설정 시 mock) |
| POST | `/bridge/databricks/search` | AI/Vector Search(미설정 시 mock) |
| POST | `/bridge/databricks/sql` | SQL Warehouse 실행(read-only 기본) |
| GET | `/bridge/mxflow/workflows` | MX-Flow 워크플로우 목록(실 n8n) |
| GET | `/bridge/mxflow/workflows/{id}` | 워크플로우 상세(노드+엣지) |
| POST | `/bridge/mxflow/workflows/{id}/execute` | webhook 트리거 실행 |
| GET | `/bridge/mxflow/workflows/{id}/executions` | 실행 로그 |
| POST | `/bridge/copilot/execute` | AX Copilot 루프(intent→근거→정책→결재/실행) |
| POST | `/bridge/copilot/simulate` | 시뮬레이션 |
| GET | `/bridge/approvals/pending` | 승인 대기 |
| POST | `/bridge/approvals/{id}/approve` · `/reject` | 승인/거부(RBAC·SoD·이중승인) |
| POST | `/bridge/governance/kill` · `/unkill` · `/compensate` | 킬스위치·보상 |
| GET | `/bridge/governance/audit` | 감사 로그 |

## 보안/운영
- `AXOS_API_KEY` 설정 시 모든 `/bridge/*`(health 제외)에 `x-axos-api-key` 또는 `Bearer` 요구.
- 테넌트: `x-tenant-id` 헤더 또는 copilot 본문 `tenant_id`.
- Databricks 쓰기 SQL은 `DATABRICKS_ALLOW_WRITE=true` allowlist일 때만 허용.
- 자격증명(Databricks token, n8n key)은 `.env`로만 — 커밋 금지(.gitignore).

## 다음(운영 전)
- Databricks 고객 계정 `.env` 주입 → MCP/REST/SQL 실연결.
- audit를 Postgres/Delta로 승격. JWT 검증. workflow_id ↔ n8n id 매핑 영속화.
