"""v26.3: GET/PUT/DELETE /api/projects/{pid}/failure 端到端覆盖。

覆盖：
- 不存在项目 → 404
- upsert + 读回 round-trip（含中文 chunks 字段）
- 第二次 PUT 覆盖旧记录
- 读无记录 → 404 failure_not_found
- DELETE 后再 GET → 404；DELETE 无记录 → 幂等 200
- chunks 列存为 JSON 字符串；列表项字段保持原样
"""

import os
import sys
import tempfile
import unittest


class ProjectFailureApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        cls._tmp_db = tmp.name
        tmp.close()
        os.environ["STORYMAP_DB"] = cls._tmp_db
        for mod in ("main", "progress_repository"):
            sys.modules.pop(mod, None)

    @classmethod
    def tearDownClass(cls):
        try:
            os.unlink(cls._tmp_db)
        except OSError:
            pass

    def setUp(self):
        from fastapi.testclient import TestClient
        import main
        self.client = TestClient(main.app)
        res = self.client.post("/api/projects", json={"name": f"fail-{id(self)}"})
        self.assertEqual(res.status_code, 200, res.text)
        self.pid = res.json()["id"]

    def tearDown(self):
        self.client.delete(f"/api/projects/{self.pid}")

    def _put(self, **overrides):
        body = {
            "chunkSize": 500,
            "totalChunks": 100,
            "chunks": [{"chunkIndex": 0, "message": "timeout"}, {"chunkIndex": 5, "message": "429"}],
            "chapterFrom": "1",
            "chapterTo": "10",
        }
        body.update(overrides)
        return self.client.put(f"/api/projects/{self.pid}/failure", json=body)

    def test_put_and_get_round_trip(self):
        res = self._put()
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["chunkSize"], 500)
        self.assertEqual(body["totalChunks"], 100)
        self.assertEqual(body["chapterFrom"], "1")
        self.assertEqual(body["chapterTo"], "10")
        self.assertEqual(len(body["chunks"]), 2)
        self.assertEqual(body["chunks"][0]["chunkIndex"], 0)
        self.assertEqual(body["chunks"][1]["chunkIndex"], 5)

        got = self.client.get(f"/api/projects/{self.pid}/failure")
        self.assertEqual(got.status_code, 200, got.text)
        g = got.json()
        self.assertEqual(g["chunkSize"], 500)
        self.assertEqual(g["chunks"][1]["message"], "429")

    def test_put_overwrites_existing_record(self):
        self._put(chunkSize=500)
        self._put(chunkSize=1000, totalChunks=50)
        got = self.client.get(f"/api/projects/{self.pid}/failure").json()
        self.assertEqual(got["chunkSize"], 1000)
        self.assertEqual(got["totalChunks"], 50)

    def test_get_without_prior_put_returns_404(self):
        res = self.client.get(f"/api/projects/{self.pid}/failure")
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.json()["detail"]["error"], "failure_not_found")

    def test_operations_on_missing_project_return_404(self):
        for method, verb in [(self.client.get, "GET"), (self.client.put, "PUT"), (self.client.delete, "DELETE")]:
            with self.subTest(verb=verb):
                url = "/api/projects/no-such-pid/failure"
                if verb == "PUT":
                    res = method(url, json={"chunkSize": 500, "chunks": []})
                else:
                    res = method(url)
                self.assertEqual(res.status_code, 404, f"{verb} missing project should 404: {res.text}")
                self.assertEqual(res.json()["detail"]["error"], "project_not_found")

    def test_delete_then_get_returns_404(self):
        self._put()
        res = self.client.delete(f"/api/projects/{self.pid}/failure")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "success")
        got = self.client.get(f"/api/projects/{self.pid}/failure")
        self.assertEqual(got.status_code, 404)

    def test_delete_is_idempotent_when_no_record(self):
        # 没记录也返回成功——幂等
        res = self.client.delete(f"/api/projects/{self.pid}/failure")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "success")

    def test_chunks_with_chinese_message_persisted_correctly(self):
        chunks = [{"chunkIndex": 3, "message": "上游限流：请稍后重试"}]
        self._put(chunks=chunks)
        got = self.client.get(f"/api/projects/{self.pid}/failure").json()
        self.assertEqual(got["chunks"][0]["message"], "上游限流：请稍后重试")

    def test_empty_chunks_round_trips_as_empty_array(self):
        res = self._put(chunks=[])
        self.assertEqual(res.status_code, 200, res.text)
        got = self.client.get(f"/api/projects/{self.pid}/failure").json()
        self.assertEqual(got["chunks"], [])

    def test_delete_project_cascades_failure_record(self):
        """删除项目时通过 FK CASCADE 同步清掉失败记录。"""
        self._put()
        # 直接查 DB：应有一行
        import main as _main
        conn = _main.get_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM project_failures WHERE project_id=?", (self.pid,)
            ).fetchone()
            self.assertIsNotNone(row, "应当能查到失败记录")
        finally:
            conn.close()
        self.client.delete(f"/api/projects/{self.pid}")
        conn = _main.get_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM project_failures WHERE project_id=?", (self.pid,)
            ).fetchone()
            self.assertIsNone(row, "项目删除后失败记录应被 CASCADE 清掉")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
