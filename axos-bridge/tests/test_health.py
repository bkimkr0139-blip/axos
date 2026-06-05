def test_root(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.json()["service"] == "axos-bridge"


def test_health(client):
    r = client.get("/bridge/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["databricks"] in ("connected", "degraded", "offline")
    assert body["mxflow"] in ("connected", "degraded", "offline")
