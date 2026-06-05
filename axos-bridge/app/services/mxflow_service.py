"""MX-Flow 서비스 — n8n REST/webhook 실연계. 사용자 노출 명칭은 'MX-Flow'."""
from __future__ import annotations
from typing import Any
from ..adapters.n8n.n8n_client import N8nClient
from ..adapters.n8n.webhook_client import WebhookClient
from ..schemas.mxflow import Workflow, WorkflowDetail, ExecutionLogItem


def _norm_status(ex: dict[str, Any]) -> str:
    st = (ex.get("status") or "").lower()
    if st in ("success", "error", "running", "waiting", "canceled", "crashed"):
        return {"error": "failed", "crashed": "failed", "canceled": "failed",
                "waiting": "running"}.get(st, st)
    if ex.get("finished") is True:
        return "success"
    if ex.get("stoppedAt") and ex.get("finished") is False:
        return "failed"
    return "running" if ex.get("startedAt") and not ex.get("stoppedAt") else "unknown"


class MxFlowService:
    def __init__(self) -> None:
        self.n8n = N8nClient()
        self.webhook = WebhookClient()

    async def status(self) -> str:
        return "connected" if await self.n8n.ping() else "offline"

    async def list_workflows(self) -> tuple[list[Workflow], str]:
        try:
            raw = await self.n8n.list_workflows()
        except Exception:
            return [], "offline"
        # 최근 실행 상태 매핑(1회 조회)
        last: dict[str, str] = {}
        try:
            for ex in await self.n8n.list_executions(limit=50):
                wid = str(ex.get("workflowId") or "")
                if wid and wid not in last:
                    last[wid] = _norm_status(ex)
        except Exception:
            pass
        items = [Workflow(
            id=str(w.get("id")), name=w.get("name", ""), active=bool(w.get("active")),
            tags=[t.get("name", "") for t in (w.get("tags") or []) if isinstance(t, dict)],
            last_execution_status=last.get(str(w.get("id")), "unknown"),
            updated_at=w.get("updatedAt"),
        ) for w in raw]
        return items, "mxflow"

    async def get_detail(self, workflow_id: str) -> WorkflowDetail:
        w = await self.n8n.get_workflow(workflow_id)
        nodes = [{"name": n.get("name"),
                  "type": str(n.get("type", "")).replace("n8n-nodes-base.", ""),
                  "position": n.get("position", [0, 0])} for n in w.get("nodes", [])]
        edges: list[dict[str, str]] = []
        for frm, conn in (w.get("connections") or {}).items():
            for arr in (conn.get("main") or []):
                for c in (arr or []):
                    if c and c.get("node"):
                        edges.append({"from": frm, "to": c["node"]})
        return WorkflowDetail(id=str(w.get("id")), name=w.get("name", ""),
                              active=bool(w.get("active")), nodes=nodes, edges=edges)

    def _webhook_path(self, workflow: dict[str, Any]) -> str | None:
        for n in workflow.get("nodes", []):
            if str(n.get("type", "")).endswith("webhook"):
                p = (n.get("parameters") or {}).get("path")
                if p:
                    return p
        return None

    async def execute(self, workflow_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """webhook 트리거로 실행. workflow의 webhook 노드 path를 찾아 호출."""
        try:
            w = await self.n8n.get_workflow(workflow_id)
        except Exception as e:
            return {"execution_id": "", "status": "failed", "message": f"workflow_lookup_failed: {e}"}
        path = self._webhook_path(w)
        if not path:
            return {"execution_id": "", "status": "failed",
                    "message": "no_webhook_trigger (REST 직접 실행 불가, webhook 노드 필요)"}
        res = await self.webhook.trigger(path, payload)
        body = res.get("body") or {}
        exec_id = str(body.get("n8n_execution_id") or body.get("execution_id") or "")
        return {"execution_id": exec_id,
                "status": "success" if res.get("ok") else "failed",
                "message": "executed via MX-Flow webhook" if res.get("ok") else f"http {res.get('status_code')}",
                "result": body}

    async def execution_logs(self, workflow_id: str | None = None, limit: int = 20) -> list[ExecutionLogItem]:
        try:
            raw = await self.n8n.list_executions(workflow_id, limit)
        except Exception:
            return []
        return [ExecutionLogItem(
            execution_id=str(ex.get("id")), workflow_id=str(ex.get("workflowId") or ""),
            status=_norm_status(ex), started_at=ex.get("startedAt"),
            stopped_at=ex.get("stoppedAt"),
            error=(ex.get("data", {}) or {}).get("resultData", {}).get("error", {}).get("message")
            if isinstance(ex.get("data"), dict) else None,
        ) for ex in raw]
