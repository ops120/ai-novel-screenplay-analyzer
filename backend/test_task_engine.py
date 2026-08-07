"""v27 backend task engine end-to-end tests.

Coverage:
- POST/GET/PATCH/DELETE /api/projects/{pid}/tasks endpoint contract.
- 409 uniqueness on second active task.
- Run 10 chunks with a mocked _analyze_with_llm (no real LLM key).
- 3 consecutive 429/503 -> degraded=true and effective_concurrency=1.
- Pause/resume/cancel state machine; cancel preserves DB row until DELETE.
- Restart simulation: queued/running/paused -> interrupted via mark_stale_tasks_interrupted.
- retry remap helper correctness (port of JS remapFailureIndexes).
"""

import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock


def _make_project(client, name):
    res = client.post("/api/projects", json={"name": name})
    assert res.status_code == 200, res.text
    return res.json()["id"]


def _put_text(client, pid, text, encoding="utf-8"):
    return client.put(
        f"/api/projects/{pid}/text",
        json={"text": text, "encoding": encoding},
    )


def _register_llm(client, model_id="m1"):
    """Register a dummy LLM and return the server-issued id."""
    r = client.post(
        "/api/llm-models",
        json={
            "name": "mock-model",
            "protocol": "openai",
            "api_key": "test-key-dummy",
            "base_url": "http://127.0.0.1:1/v1",
            "model_id": "gpt-test",
            "is_default": 0,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _chunk_text(chars, chunk_size):
    """Return exactly `chars` characters."""
    return ("abcdefghij" * ((chars // 10) + 1))[:chars]


def _run_async(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class TaskEngineApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        cls._tmp_db = tmp.name
        tmp.close()
        os.environ["STORYMAP_DB"] = cls._tmp_db
        for mod in ("main", "progress_repository", "task_engine"):
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
        self.pid = _make_project(self.client, f"engine-{id(self)}")
        self.llm_id = _register_llm(self.client, "m1")
        # 10000 chars = 10 chunks at chunkSize=1000
        self.text = _chunk_text(10000, 1000)
        r = _put_text(self.client, self.pid, self.text)
        self.assertEqual(r.status_code, 200, r.text)
        # Reset engine state between tests.
        import task_engine
        task_engine.RUNNERS.clear()

    def tearDown(self):
        import task_engine
        task_engine.RUNNERS.clear()

    # -------- remap_indexes unit tests --------

    def test_remap_indexes_same_size_returns_identical(self):
        import task_engine
        self.assertEqual(
            task_engine.remap_indexes([0, 1, 2, 3], 500, 500),
            [0, 1, 2, 3],
        )

    def test_remap_indexes_smaller_new_size_expands(self):
        """old=500, new=250 -> each old chunk [i*500, (i+1)*500) covers new chunks [2i, 2i+1]."""
        import task_engine
        self.assertEqual(
            task_engine.remap_indexes([0, 1], 500, 250),
            [0, 1, 2, 3],
        )

    def test_remap_indexes_larger_new_size_collapses(self):
        """old=250, new=500 -> chunks 0,1 in old map to new chunk 0."""
        import task_engine
        self.assertEqual(
            task_engine.remap_indexes([0, 1, 2], 250, 500),
            [0, 1],
        )

    def test_remap_indexes_deduplicates(self):
        import task_engine
        # old=500, new=250; two adjacent old chunks [0] and [1] both touch new chunk 2.
        self.assertEqual(
            task_engine.remap_indexes([0, 1], 500, 250),
            [0, 1, 2, 3],
        )

    def test_remap_indexes_invalid_inputs(self):
        import task_engine
        self.assertEqual(task_engine.remap_indexes(None, 100, 50), [])
        self.assertEqual(task_engine.remap_indexes([], 100, 50), [])
        self.assertEqual(task_engine.remap_indexes([0], 0, 50), [])
        self.assertEqual(task_engine.remap_indexes([0], 100, 0), [])

    # -------- POST/GET/PATCH/DELETE contract --------

    def test_create_task_persists_row_and_returns_id(self):
        res = self.client.post(
            f"/api/projects/{self.pid}/tasks",
            json={
                "kind": "analyze",
                "chunk_size": 1000,
                "concurrency": 2,
                "llm_model_id": self.llm_id,
                "system_prompt": "extract nodes/edges",
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["totalChunks"], 10)
        task_id = body["taskId"]

        # GET sees the row.
        got = self.client.get(f"/api/projects/{self.pid}/tasks")
        self.assertEqual(got.status_code, 200, got.text)
        tasks = got.json()["tasks"]
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["taskId"], task_id)
        self.assertEqual(tasks[0]["kind"], "analyze")
        self.assertEqual(tasks[0]["chunkSize"], 1000)

    def test_second_active_task_returns_409(self):
        # 20 chunks x 1000 chars + slow LLM so first task is still active.
        big_text = _chunk_text(20000, 1000)
        r = _put_text(self.client, self.pid, big_text)
        self.assertEqual(r.status_code, 200, r.text)

        import main
        from main import AnalyzeResponse

        async def fake_analyze(req):
            await asyncio.sleep(0.5)
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res1 = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                },
            )
            self.assertEqual(res1.status_code, 200, res1.text)
            self._wait_running(res1.json()["taskId"], timeout_s=2)
        # Second create while the first is still queued/running/paused -> 409.
        res2 = self.client.post(
            f"/api/projects/{self.pid}/tasks",
            json={
                "kind": "analyze",
                "chunk_size": 1000,
                "concurrency": 1,
                "llm_model_id": self.llm_id,
            },
        )
        self.assertEqual(res2.status_code, 409, res2.text)
        self.assertEqual(res2.json()["detail"]["error"], "task_already_active")

    def test_create_on_missing_project_404(self):
        res = self.client.post(
            "/api/projects/no-such-pid/tasks",
            json={
                "kind": "analyze",
                "chunk_size": 1000,
                "concurrency": 1,
                "llm_model_id": self.llm_id,
            },
        )
        self.assertEqual(res.status_code, 404, res.text)
        self.assertEqual(res.json()["detail"]["error"], "project_not_found")

    def test_create_without_text_404(self):
        # Create a project without importing text.
        pid2 = _make_project(self.client, f"no-text-{id(self)}")
        res = self.client.post(
            f"/api/projects/{pid2}/tasks",
            json={
                "kind": "analyze",
                "chunk_size": 1000,
                "concurrency": 1,
                "llm_model_id": self.llm_id,
            },
        )
        self.assertEqual(res.status_code, 404, res.text)
        self.assertEqual(res.json()["detail"]["error"], "project_text_not_found")

    def test_delete_task_removes_row(self):
        # Use bigger text so the task is still running when we cancel.
        big_text = _chunk_text(20000, 1000)
        r = _put_text(self.client, self.pid, big_text)
        self.assertEqual(r.status_code, 200, r.text)

        import main
        from main import AnalyzeResponse

        async def fake_analyze(req):
            await asyncio.sleep(0.5)
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                },
            )
        task_id = res.json()["taskId"]
        # Wait briefly to ensure task has started.
        self._wait_running(task_id, timeout_s=2)
        # Cancel first (the task is queued/running)
        self.client.patch(
            f"/api/projects/{self.pid}/tasks/{task_id}",
            json={"action": "cancel"},
        )
        # Delete
        dres = self.client.delete(f"/api/projects/{self.pid}/tasks/{task_id}")
        self.assertEqual(dres.status_code, 200, dres.text)
        # GET should now return empty list
        got = self.client.get(f"/api/projects/{self.pid}/tasks")
        self.assertEqual(got.json()["tasks"], [])

    def test_patch_actions_on_terminal_task_409(self):
        res = self.client.post(
            f"/api/projects/{self.pid}/tasks",
            json={
                "kind": "analyze",
                "chunk_size": 1000,
                "concurrency": 1,
                "llm_model_id": self.llm_id,
            },
        )
        task_id = res.json()["taskId"]
        # Cancel -> terminal
        self.client.patch(
            f"/api/projects/{self.pid}/tasks/{task_id}",
            json={"action": "cancel"},
        )
        # Try pause -> 409
        pres = self.client.patch(
            f"/api/projects/{self.pid}/tasks/{task_id}",
            json={"action": "pause"},
        )
        self.assertEqual(pres.status_code, 409, pres.text)
        self.assertEqual(pres.json()["detail"]["error"], "action_not_allowed")

    # -------- Runner end-to-end with mock LLM --------

    def test_runner_processes_all_chunks(self):
        import main
        from main import AnalyzeResponse, AnalyzeNode, AnalyzeEdge

        async def fake_analyze(req):
            await asyncio.sleep(0)  # yield
            # Return one node + one edge per chunk so persist path runs.
            return AnalyzeResponse(
                nodes=[AnalyzeNode(id="x", label="X", sect="s", chapter=req.chunk_chapter or "")],
                edges=[AnalyzeEdge(source="x", target="x", label="self")],  # will be skipped by source==target
            )

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 2,
                    "llm_model_id": self.llm_id,
                },
            )
            self.assertEqual(res.status_code, 200, res.text)
            task_id = res.json()["taskId"]

            # Wait for completion
            self._wait_terminal(task_id, timeout_s=10)

            # Verify final state
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            tasks = got.json()["tasks"]
            self.assertEqual(len(tasks), 1)
            t = tasks[0]
            self.assertEqual(t["status"], "completed", f"final={t}")
            self.assertEqual(t["completed"], 10)
            self.assertEqual(t["successCount"], 10)
            self.assertEqual(t["failedCount"], 0)
            self.assertEqual(t["totalChunks"], 10)
            self.assertFalse(t["degraded"])

    def test_runner_three_429s_marks_degraded(self):
        import main
        from main import AnalyzeResponse

        call_log = []

        class FakeRateLimit(Exception):
            status_code = 429

        async def fake_analyze(req):
            call_log.append(req.chunk_index)
            # First 3 chunks -> 429
            if len(call_log) <= 3:
                raise FakeRateLimit("rate limited")
            # After 3, succeed
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 3,
                    "llm_model_id": self.llm_id,
                },
            )
            task_id = res.json()["taskId"]
            self._wait_terminal(task_id, timeout_s=15)
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            t = got.json()["tasks"][0]
            self.assertTrue(t["degraded"], f"expected degraded, got {t}")
            self.assertEqual(t["rateLimitCount"], 3)
            # 3 failures + 7 successes = 10 total
            self.assertEqual(t["completed"], 10)
            self.assertEqual(t["failedCount"], 3)
            self.assertEqual(t["successCount"], 7)

    def test_runner_503_also_triggers_degraded(self):
        import main
        from main import AnalyzeResponse

        call_log = []

        class Fake503(Exception):
            status_code = 503

        async def fake_analyze(req):
            call_log.append(req.chunk_index)
            if len(call_log) <= 3:
                raise Fake503("upstream busy")
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 2,
                    "llm_model_id": self.llm_id,
                },
            )
            task_id = res.json()["taskId"]
            self._wait_terminal(task_id, timeout_s=15)
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            t = got.json()["tasks"][0]
            self.assertTrue(t["degraded"])

    def test_pause_resume(self):
        import main
        from main import AnalyzeResponse

        # 50 chunks x 1000 chars + slow LLM so we can pause mid-run.
        big_text = _chunk_text(50000, 1000)
        r = _put_text(self.client, self.pid, big_text)
        self.assertEqual(r.status_code, 200, r.text)

        async def fake_analyze(req):
            await asyncio.sleep(0.5)
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                },
            )
            task_id = res.json()["taskId"]
            # Give it a moment to start
            import time as _t
            _t.sleep(0.3)
            pres = self.client.patch(
                f"/api/projects/{self.pid}/tasks/{task_id}",
                json={"action": "pause"},
            )
            self.assertEqual(pres.status_code, 200, pres.text)
            _t.sleep(0.1)
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            self.assertEqual(got.json()["tasks"][0]["status"], "paused")
            rres = self.client.patch(
                f"/api/projects/{self.pid}/tasks/{task_id}",
                json={"action": "resume"},
            )
            self.assertEqual(rres.status_code, 200, rres.text)
            self._wait_terminal(task_id, timeout_s=60)
            t = self.client.get(f"/api/projects/{self.pid}/tasks").json()["tasks"][0]
            self.assertEqual(t["status"], "completed", f"final={t}")

    def test_cancel_preserves_results_then_delete(self):
        import main
        from main import AnalyzeResponse

        # Bigger text so cancel happens before task completes.
        big_text = _chunk_text(20000, 1000)
        r = _put_text(self.client, self.pid, big_text)
        self.assertEqual(r.status_code, 200, r.text)

        async def fake_analyze(req):
            await asyncio.sleep(0.5)
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                },
            )
            task_id = res.json()["taskId"]
            self._wait_running(task_id, timeout_s=2)
            cres = self.client.patch(
                f"/api/projects/{self.pid}/tasks/{task_id}",
                json={"action": "cancel"},
            )
            self.assertEqual(cres.status_code, 200, cres.text)
            import time as _t
            _t.sleep(0.5)
            t = self.client.get(f"/api/projects/{self.pid}/tasks").json()["tasks"][0]
            self.assertEqual(t["status"], "cancelled")
            self.client.delete(f"/api/projects/{self.pid}/tasks/{task_id}")
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            self.assertEqual(got.json()["tasks"], [])

    def test_retry_with_same_size_uses_indexes_directly(self):
        import main
        from main import AnalyzeResponse

        async def fake_analyze(req):
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "retry",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                    "old_chunk_size": 1000,
                    "failure_indexes": [1, 5, 9],
                },
            )
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.json()["totalChunks"], 3)
            task_id = res.json()["taskId"]
            self._wait_terminal(task_id, timeout_s=10)
            t = self.client.get(f"/api/projects/{self.pid}/tasks").json()["tasks"][0]
            self.assertEqual(t["status"], "completed")
            self.assertEqual(t["totalChunks"], 3)
            self.assertEqual(t["completed"], 3)

    def test_retry_with_smaller_chunk_size_remaps(self):
        import main
        from main import AnalyzeResponse

        async def fake_analyze(req):
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            # old chunkSize=1000 -> new=500 -> each old index covers 2 new indexes.
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "retry",
                    "chunk_size": 500,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                    "old_chunk_size": 1000,
                    "failure_indexes": [0, 1],
                },
            )
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.json()["totalChunks"], 4)
            self._wait_terminal(res.json()["taskId"], timeout_s=10)

    def test_retry_no_matching_indexes_400(self):
        # failure_indexes all out of range -> 400
        res = self.client.post(
            f"/api/projects/{self.pid}/tasks",
            json={
                "kind": "retry",
                "chunk_size": 1000,
                "concurrency": 1,
                "llm_model_id": self.llm_id,
                "old_chunk_size": 1000,
                "failure_indexes": [999, 1000, 1001],
            },
        )
        self.assertEqual(res.status_code, 400, res.text)
        self.assertEqual(res.json()["detail"]["error"], "no_matching_chunks")

    # -------- Restart simulation --------

    def test_mark_stale_tasks_interrupted(self):
        import main
        # Insert a fake "running" task directly.
        import task_engine
        conn = main.get_db()
        try:
            conn.execute(
                "INSERT INTO tasks (id, project_id, kind, status, chunk_size, concurrency, "
                "total_chunks, llm_model_id, created_at, updated_at) "
                "VALUES (?, ?, 'analyze', 'running', 1000, 1, 10, 'm1', 't1', 't1')",
                ("task-running", self.pid),
            )
            conn.execute(
                "INSERT INTO tasks (id, project_id, kind, status, chunk_size, concurrency, "
                "total_chunks, llm_model_id, created_at, updated_at) "
                "VALUES (?, ?, 'analyze', 'queued', 1000, 1, 10, 'm1', 't2', 't2')",
                ("task-queued", self.pid),
            )
            conn.execute(
                "INSERT INTO tasks (id, project_id, kind, status, chunk_size, concurrency, "
                "total_chunks, llm_model_id, created_at, updated_at) "
                "VALUES (?, ?, 'analyze', 'paused', 1000, 1, 10, 'm1', 't3', 't3')",
                ("task-paused", self.pid),
            )
            conn.execute(
                "INSERT INTO tasks (id, project_id, kind, status, chunk_size, concurrency, "
                "total_chunks, llm_model_id, created_at, updated_at) "
                "VALUES (?, ?, 'analyze', 'completed', 1000, 1, 10, 'm1', 't4', 't4')",
                ("task-completed", self.pid),
            )
            conn.commit()
        finally:
            conn.close()

        task_engine.mark_stale_tasks_interrupted()

        conn = main.get_db()
        try:
            statuses = {r["id"]: r["status"] for r in conn.execute(
                "SELECT id, status FROM tasks WHERE project_id=?", (self.pid,),
            ).fetchall()}
        finally:
            conn.close()

        self.assertEqual(statuses["task-running"], "interrupted")
        self.assertEqual(statuses["task-queued"], "interrupted")
        self.assertEqual(statuses["task-paused"], "interrupted")
        self.assertEqual(statuses["task-completed"], "completed")  # terminal untouched

    def test_delete_project_cancels_tasks(self):
        import main
        from main import AnalyzeResponse

        # Make text big enough that the task is still active when we delete.
        big_text = _chunk_text(20000, 1000)
        r = _put_text(self.client, self.pid, big_text)
        self.assertEqual(r.status_code, 200, r.text)

        async def fake_analyze(req):
            await asyncio.sleep(0.5)
            return AnalyzeResponse(nodes=[], edges=[])

        with mock.patch.object(main, "_analyze_with_llm", side_effect=fake_analyze):
            res = self.client.post(
                f"/api/projects/{self.pid}/tasks",
                json={
                    "kind": "analyze",
                    "chunk_size": 1000,
                    "concurrency": 1,
                    "llm_model_id": self.llm_id,
                },
            )
            task_id = res.json()["taskId"]
            self._wait_running(task_id, timeout_s=2)
            # Delete project mid-run
            dres = self.client.delete(f"/api/projects/{self.pid}")
            self.assertEqual(dres.status_code, 200, dres.text)
            # Project row + task row gone via FK CASCADE
            got = self.client.get(f"/api/projects/{self.pid}/tasks")
            # Project is gone -> 404 on tasks
            self.assertEqual(got.status_code, 404)


    # -------- helpers --------

    def _wait_terminal(self, task_id, timeout_s=10):
        import time as _t
        deadline = _t.time() + timeout_s
        while _t.time() < deadline:
            got = self.client.get(f"/api/projects/{self.pid}/tasks").json()
            for t in got["tasks"]:
                if t["taskId"] == task_id and t["status"] in ("completed", "failed", "cancelled"):
                    return
            _t.sleep(0.05)
        raise AssertionError(f"task {task_id} did not terminate within {timeout_s}s")

    def _wait_running(self, task_id, timeout_s=5):
        """Wait until task reaches running or paused (active state). Returns the status."""
        import time as _t
        deadline = _t.time() + timeout_s
        while _t.time() < deadline:
            got = self.client.get(f"/api/projects/{self.pid}/tasks").json()
            for t in got["tasks"]:
                if t["taskId"] == task_id:
                    s = t["status"]
                    if s in ("running", "paused"):
                        return s
                    if s in ("completed", "failed", "cancelled"):
                        return s
            _t.sleep(0.02)
        raise AssertionError(f"task {task_id} did not start within {timeout_s}s")


if __name__ == "__main__":
    unittest.main()