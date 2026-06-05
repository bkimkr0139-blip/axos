"""거버넌스 — 킬 스위치 + 보상(compensation) 상태. (가이드 §10 Phase5)"""
from __future__ import annotations
from typing import Any

_killed = {"global": False, "targets": set()}


def kill(target: str | None) -> dict[str, Any]:
    if target:
        _killed["targets"].add(target)
    else:
        _killed["global"] = True
    return state()


def unkill(target: str | None) -> dict[str, Any]:
    if target:
        _killed["targets"].discard(target)
    else:
        _killed["global"] = False
    return state()


def is_killed(target: str | None = None) -> bool:
    if _killed["global"]:
        return True
    return bool(target and target in _killed["targets"])


def state() -> dict[str, Any]:
    return {"global": _killed["global"], "targets": sorted(_killed["targets"])}
