"""공통 의존성 — API Key 검증, 테넌트 컨텍스트."""
from __future__ import annotations
from fastapi import Header, HTTPException
from .config import get_settings


async def verify_api_key(
    x_axos_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    """AXOS_API_KEY 가 설정된 경우에만 검증(미설정=로컬 개방)."""
    s = get_settings()
    if not s.api_key:
        return
    token = x_axos_api_key
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    if token != s.api_key:
        raise HTTPException(status_code=401, detail="invalid or missing API key")


async def tenant_context(x_tenant_id: str | None = Header(default=None)) -> str:
    return x_tenant_id or "default"
