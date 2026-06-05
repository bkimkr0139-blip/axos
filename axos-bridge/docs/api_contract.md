# AXOS Bridge ↔ Base44 API Contract

> Base44(MX-AI) 화면이 호출하는 FastAPI 브리지 계약. base URL = 브리지 외부 주소 + `/bridge`.
> (현재 외부화: `https://hardware-finalize-faceted.ngrok-free.dev/bridge` 는 Node 브리지(:4100).
>  FastAPI 브리지(:8000) 이전 시 프록시 라우팅 또는 별도 외부 경로를 둔다 — `axos/docs/09_externalization.md` 참고.)

공통: 요청에 `ngrok-skip-browser-warning: true`, (보안 활성 시) `x-axos-api-key`, 멀티테넌트 시 `x-tenant-id`.

## Health
`GET /bridge/health` → `{status, databricks, mxflow, timestamp, version}`

## Databricks
- `GET /bridge/databricks/status` → `{configured, mcp_available, sql_warehouse_available, vector_search_available, model_serving_available, mode}`
- `GET /bridge/databricks/catalog` → `{catalog, schemas:[{name, display_name, tables[]}], source}`
- `POST /bridge/databricks/search` `{query, filters, top_k}` → `{results:[{id,title,summary,score,source_table,lineage}], source}`
- `POST /bridge/databricks/sql` `{statement, limit}` → `{columns, rows, row_count, source}` (쓰기 차단 시 source=blocked)

## MX-Flow (사용자 노출 명칭 MX-Flow, 내부 n8n)
- `GET /bridge/mxflow/workflows` → `{workflows:[{id,name,active,tags,last_execution_status,updated_at}], source}`
- `GET /bridge/mxflow/workflows/{id}` → `{id,name,active,nodes:[{name,type,position}],edges:[{from,to}]}`
- `POST /bridge/mxflow/workflows/{id}/execute` `{usecase_id,trigger_source,payload}` → `{execution_id,status,message}`
- `GET /bridge/mxflow/workflows/{id}/executions` → `[{execution_id,workflow_id,status,started_at,stopped_at,error}]`

## AX Copilot
- `POST /bridge/copilot/execute` `{user_message,user_role,tenant_id,auto}` →
  `{intent, summary, evidence[], recommended_workflow_id, confidence, risk_level, approval_required, decision(auto_execute|approval_pending|blocked), approval_id, next_actions[], audit_event_id}`
- `POST /bridge/copilot/simulate` `{workflow_id,intent,payload}` → `{simulation_id,projected_outcome,estimated_value_krw,estimated_hours_saved,risk_level,steps[]}`

## 승인/거버넌스
- `GET /bridge/approvals/pending` → `[ApprovalItem]`
- `POST /bridge/approvals/{id}/approve` `{approver,reason}` → `{ok, approved|pending_more_approval, approvals[]}`
- `POST /bridge/approvals/{id}/reject` `{approver,reason}`
- `POST /bridge/governance/kill|unkill` `{target,actor}` · `POST /bridge/governance/compensate` `{decision_id,actor,reason}`
- `GET /bridge/governance/audit?limit=` → `{events:[...]}`

## Base44 Entity ↔ 브리지 필드 매핑
| Base44 필드 | 브리지 응답 |
|---|---|
| `workflow_id` | mxflow workflow `id` |
| `execution_id` | execute/executions `execution_id` |
| `approval_id` | copilot/approvals `approval_id` |
| `risk_level` | copilot `risk_level` |
| `data_trust_score` | databricks search `score` / catalog lineage(파생) |
| `databricks_asset_id` | catalog `schemas[].tables[].name` (catalog.schema.table) |
