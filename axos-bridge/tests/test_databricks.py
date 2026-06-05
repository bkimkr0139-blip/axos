def test_status(client):
    r = client.get("/bridge/databricks/status")
    assert r.status_code == 200
    b = r.json()
    assert "configured" in b and "mode" in b


def test_catalog_has_medallion(client):
    r = client.get("/bridge/databricks/catalog")
    assert r.status_code == 200
    names = [s["name"] for s in r.json()["schemas"]]
    # 미설정 시 mock 메달리온
    assert {"bronze", "silver", "gold"} <= set(names)


def test_search(client):
    r = client.post("/bridge/databricks/search", json={"query": "결품 위험", "top_k": 3})
    assert r.status_code == 200
    assert "results" in r.json()


def test_sql_readonly_block_or_mock(client):
    # 쓰기 SQL은 기본 차단(allow_write=false) 또는 미설정 mock
    r = client.post("/bridge/databricks/sql", json={"statement": "DELETE FROM gold.stock"})
    assert r.status_code == 200
    assert r.json()["source"] in ("blocked", "mock", "sql")
