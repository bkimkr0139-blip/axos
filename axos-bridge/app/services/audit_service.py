"""Audit Log 저장 — PoC 기본 SQLite(stdlib). 운영 시 Postgres/Delta 로 교체."""
from __future__ import annotations
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from ..config import get_settings


def _db_path() -> str:
    url = get_settings().audit_db_url
    if url.startswith("sqlite:///"):
        p = url[len("sqlite:///"):]
        # 상대경로는 axos-bridge/ 기준
        if not Path(p).is_absolute():
            p = str(Path(__file__).resolve().parent.parent.parent / p)
        return p
    return str(Path(__file__).resolve().parent.parent.parent / "axos_audit.db")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_db_path())
    c.execute(
        """CREATE TABLE IF NOT EXISTS audit (
            event_id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, event_type TEXT,
            intent TEXT, input TEXT, output TEXT, evidence_refs TEXT,
            workflow_id TEXT, execution_id TEXT, approval_id TEXT,
            status TEXT, created_at TEXT)"""
    )
    return c


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record(event_type: str, *, tenant_id: str = "default", user_id: str = "system",
           intent: str | None = None, input: Any = None, output: Any = None,
           evidence_refs: list | None = None, workflow_id: str | None = None,
           execution_id: str | None = None, approval_id: str | None = None,
           status: str = "success") -> str:
    event_id = "evt-" + uuid.uuid4().hex[:12]
    row = (event_id, tenant_id, user_id, event_type, intent,
           json.dumps(input, ensure_ascii=False) if input is not None else None,
           json.dumps(output, ensure_ascii=False) if output is not None else None,
           json.dumps(evidence_refs or [], ensure_ascii=False),
           workflow_id, execution_id, approval_id, status, _now())
    c = _conn()
    with c:
        c.execute("INSERT INTO audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
    c.close()
    return event_id


def recent(limit: int = 50, tenant_id: str | None = None) -> list[dict]:
    c = _conn()
    q = "SELECT event_id,tenant_id,user_id,event_type,intent,workflow_id,execution_id,approval_id,status,created_at FROM audit"
    args: tuple = ()
    if tenant_id:
        q += " WHERE tenant_id=?"
        args = (tenant_id,)
    q += " ORDER BY created_at DESC LIMIT ?"
    args = args + (limit,)
    rows = c.execute(q, args).fetchall()
    c.close()
    cols = ["event_id", "tenant_id", "user_id", "event_type", "intent",
            "workflow_id", "execution_id", "approval_id", "status", "created_at"]
    return [dict(zip(cols, r)) for r in rows]
