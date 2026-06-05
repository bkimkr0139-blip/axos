def test_workflows_list(client):
    r = client.get("/bridge/mxflow/workflows")
    assert r.status_code == 200
    b = r.json()
    assert "workflows" in b and b["source"] in ("mxflow", "offline", "mock")


def test_execute_kill_switch(client):
    # 킬 스위치가 걸린 대상은 실행 차단(423)
    client.post("/bridge/governance/kill", json={"target": "wf_test_kill", "actor": "ops"})
    r = client.post("/bridge/mxflow/workflows/wf_test_kill/execute",
                    json={"trigger_source": "manual", "payload": {}})
    assert r.status_code == 423
    client.post("/bridge/governance/unkill", json={"target": "wf_test_kill", "actor": "ops"})
