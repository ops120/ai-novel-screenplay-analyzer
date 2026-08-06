"""v25-fix：GET list / GET one / PUT / PATCH / DELETE /api/task-progress 端到端测试。

复用 FastAPI TestClient + 临时 SQLite 文件，避免污染 dev 库。
覆盖：5MB+ 文本 PUT/GET、PATCH 单调不回退、列表不带 text、404、project FK。
"""

import os
import sys
import tempfile
import unittest


class TaskProgressRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 临时库文件，env 变量在 main 导入前设
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        cls._tmp_db = tmp.name
        tmp.close()
        os.environ["STORYMAP_DB"] = cls._tmp_db
        # 防止 main 模块被前序测试缓存
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
        # 建一个项目供断点写入
        res = self.client.post("/api/projects", json={"name": f"route-{id(self)}"})
        self.assertEqual(res.status_code, 200, res.text)
        self.pid = res.json()["id"]

    def tearDown(self):
        # 清掉本测试创建的项目，避免干扰 list 接口
        self.client.delete(f"/api/projects/{self.pid}")

    def test_list_empty_initially(self):
        res = self.client.get("/api/task-progress")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), [])

    def test_put_get_patch_delete_round_trip_with_large_text(self):
        text = "修" * 5_100_000  # ~15MB UTF-8
        res = self.client.put(f"/api/task-progress/{self.pid}", json={
            "totalChunks": 10_200,
            "lastCompleted": 3,
            "text": text,
            "chunkSize": 500,
            "concurrency": 3,
            "llmModelName": "M",
            "chapterFrom": "",
            "chapterTo": "",
        })
        self.assertEqual(res.status_code, 200, res.text)

        # 列表：不含 text
        listed = self.client.get("/api/task-progress").json()
        self.assertEqual(len(listed), 1)
        self.assertNotIn("text", listed[0])
        self.assertEqual(listed[0]["lastCompleted"], 3)

        # 单条：含 text 且完全一致
        single = self.client.get(f"/api/task-progress/{self.pid}").json()
        self.assertEqual(single["text"], text)
        self.assertEqual(single["totalChunks"], 10_200)

        # PATCH：单调不回退
        self.client.patch(f"/api/task-progress/{self.pid}",
                          json={"lastCompleted": 100})
        self.assertEqual(
            self.client.get(f"/api/task-progress/{self.pid}").json()["lastCompleted"],
            100,
        )
        self.client.patch(f"/api/task-progress/{self.pid}",
                          json={"lastCompleted": 50})
        self.assertEqual(
            self.client.get(f"/api/task-progress/{self.pid}").json()["lastCompleted"],
            100,
            "PATCH 必须单调不回退",
        )

        # DELETE
        self.client.delete(f"/api/task-progress/{self.pid}")
        self.assertEqual(
            self.client.get(f"/api/task-progress/{self.pid}").status_code,
            404,
        )

    def test_put_to_missing_project_returns_404(self):
        res = self.client.put("/api/task-progress/no-such-pid", json={
            "totalChunks": 1,
            "lastCompleted": 0,
            "text": "abc",
            "chunkSize": 1,
            "concurrency": 1,
        })
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.json()["detail"]["error"], "project_not_found")

    def test_patch_to_missing_record_returns_404(self):
        res = self.client.patch("/api/task-progress/no-such-pid",
                                json={"lastCompleted": 1})
        self.assertEqual(res.status_code, 404)

    def test_file_origin_cors_allows_progress_patch(self):
        res = self.client.options(
            f"/api/task-progress/{self.pid}",
            headers={
                "Origin": "file://",
                "Access-Control-Request-Method": "PATCH",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertIn("PATCH", res.headers.get("access-control-allow-methods", ""))


if __name__ == "__main__":
    unittest.main()
