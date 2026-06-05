def test_copilot_inventory_intent(client):
    r = client.post("/bridge/copilot/execute", json={
        "user_message": "다음 달 결품 위험 품목 구매 요청 준비",
        "user_role": "purchasing_manager", "tenant_id": "t-test"})
    assert r.status_code == 200
    b = r.json()
    assert b["intent"] == "inventory_shortage_prevention"
    assert b["decision"] in ("auto_execute", "approval_pending", "blocked")
    assert b["recommended_workflow_id"] == "wf_inventory_purchase_request"
    assert b["audit_event_id"]


def test_copilot_then_approval_flow(client):
    r = client.post("/bridge/copilot/execute", json={
        "user_message": "결품 위험 품목 발주 준비", "user_role": "pm", "tenant_id": "t-flow"})
    aid = r.json().get("approval_id")
    if not aid:
        return  # auto_execute/blocked 인 경우 스킵
    pend = client.get("/bridge/approvals/pending", headers={"x-tenant-id": "t-flow"}).json()
    assert any(p["approval_id"] == aid for p in pend)
    # SoD: ai 승인 거부
    bad = client.post(f"/bridge/approvals/{aid}/approve", json={"approver": "ai"}).json()
    assert bad["ok"] is False
    ok = client.post(f"/bridge/approvals/{aid}/approve", json={"approver": "user:lead"}).json()
    assert ok["ok"] is True


def test_approval_policy_thresholds(client):
    from app.services.approval_service import evaluate
    assert evaluate(0.95, "low", amount=100).decision == "auto_execute"
    assert evaluate(0.6, "low").decision == "blocked"
    assert evaluate(0.85, "medium").decision == "approval_pending"
    assert evaluate(0.95, "low", amount=20_000_000).required_approvals == 2
