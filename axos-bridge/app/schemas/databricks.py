"""Databricks 관련 스키마."""
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field


class DatabricksStatus(BaseModel):
    workspace: str
    catalog: str
    configured: bool
    mcp_available: bool = False
    sql_warehouse_available: bool = False
    vector_search_available: bool = False
    model_serving_available: bool = False
    mode: str = "offline"  # mcp | rest | sql | offline


class CatalogSchema(BaseModel):
    name: str
    display_name: str
    tables: list[dict[str, Any]] = Field(default_factory=list)


class CatalogResponse(BaseModel):
    catalog: str
    schemas: list[CatalogSchema]
    source: str = "mock"  # mcp | rest | sql | mock


class SearchRequest(BaseModel):
    query: str
    filters: dict[str, Any] = Field(default_factory=dict)
    top_k: int = 5


class SearchResultItem(BaseModel):
    id: str
    title: str
    summary: str
    score: float
    source_table: str
    lineage: list[str] = Field(default_factory=list)


class SearchResponse(BaseModel):
    results: list[SearchResultItem]
    source: str = "mock"


class SqlRequest(BaseModel):
    statement: str
    limit: int = 100


class SqlResponse(BaseModel):
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    row_count: int = 0
    source: str = "mock"
    note: str | None = None
