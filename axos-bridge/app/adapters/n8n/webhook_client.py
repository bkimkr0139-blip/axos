"""n8n webhook 실행 디스패처 (MX-Flow 이벤트 기반 실행)."""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings


class WebhookClient:
    def __init__(self) -> None:
        s = get_settings()
        self.base = s.mxflow_webhook_base
        self.secret = s.mxflow_webhook_secret
        self.timeout = 15.0

    async def trigger(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """webhook 경로 호출. 토큰은 Authorization Bearer 로 전달(n8n 파이프라인 규약)."""
        url = self.base + "/" + path.lstrip("/")
        headers = {"Content-Type": "application/json"}
        if self.secret:
            headers["Authorization"] = "Bearer " + self.secret
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(url, json=payload, headers=headers)
            body: Any
            try:
                body = r.json()
            except Exception:
                body = {"raw": r.text}
            return {"ok": r.status_code < 300, "status_code": r.status_code, "body": body}
