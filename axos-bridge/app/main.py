"""AXOS Bridge Server (FastAPI) 엔트리포인트.

MX-AI(Base44) ↔ Databricks ↔ MX-Flow(n8n) 연계 브리지.
기존 Node mock 브리지(axos/mock/bridge_server.cjs)와 별개 포트(기본 8000)로 운영.
"""
from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from . import __version__
from .config import get_settings
from .routers import health, databricks, mxflow, copilot, approvals, governance

settings = get_settings()
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO),
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("axos-bridge")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("AXOS Bridge %s up | env=%s | databricks=%s | mxflow=%s",
             __version__, settings.env,
             "configured" if settings.databricks_configured else "offline",
             "api" if settings.mxflow_api_configured else "webhook-only")
    yield


app = FastAPI(title="AXOS Bridge Server", version=__version__, lifespan=lifespan,
              description="MX-AI ↔ Databricks ↔ MX-Flow 연계 브리지 (FastAPI)")

# CORS — Base44 도메인(*.base44.app) + 명시 origin 허용. 커스텀 헤더 전부 허용.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=r"https://.*\.base44\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (health, databricks, mxflow, copilot, approvals, governance):
    app.include_router(r.router)


@app.get("/")
async def root() -> dict:
    return {"service": "axos-bridge", "version": __version__, "env": settings.env,
            "databricks_configured": settings.databricks_configured,
            "mxflow_api_configured": settings.mxflow_api_configured,
            "docs": "/docs"}
