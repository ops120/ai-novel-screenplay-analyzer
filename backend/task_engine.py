"""Backend analysis task engine.

Single-process design with a dedicated background asyncio loop so the worker
pool keeps running across HTTP request lifetimes (the request event loop used
by FastAPI / Starlette / TestClient is torn down when the request returns;
long-running tasks scheduled there get cancelled).

Public surface (called from main.py):
  - init_tasks_schema(conn)             # CREATE TABLE tasks
  - mark_stale_tasks_interrupted()      # boot hook
  - cancel_tasks_for_project(pid)       # delete-project hook
  - submit_run_task(...)                # schedule run_task on background loop
  - fetch_task_row / list_tasks_for_project / update_task_progress /
    update_task_status
  - pause_task / resume_task / cancel_task / set_task_concurrency
  - new_task_id / now_iso / remap_indexes

Concurrency contract:
  Effective concurrency = min(task_concurrency, global LLM gate).
  Three consecutive 429/503 -> degraded=True, effective=1 (permanent for that
  task). Recovery only on a fresh task.

This module never imports main at import time; it imports main lazily inside
functions so unit tests can monkeypatch main._analyze_with_llm.
"""

import asyncio
import json
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional


# -------- Constants --------

RATE_LIMIT_WINDOW = 3
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 8

STATUS_TERMINAL = {"completed", "failed", "cancelled"}
STATUS_ACTIVE = {"queued", "running", "paused"}


# -------- Background asyncio loop --------

class BackgroundLoop:
    """A dedicated asyncio loop running in its own daemon thread.

    Tasks scheduled here survive across HTTP requests; TestClient cancels
    pending tasks scheduled on the request loop when the response returns.
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(
            target=self._run, name="task-engine-loop", daemon=True,
        )
        self.thread.start()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        finally:
            self.loop.close()

    def submit(self, coro):
        """Schedule a coroutine on the background loop and return a Future."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop)


# Singleton background loop. Initialised on first import.
_BG_LOOP: Optional[BackgroundLoop] = None
_BG_LOCK = threading.Lock()


def get_background_loop() -> BackgroundLoop:
    global _BG_LOOP
    if _BG_LOOP is None:
        with _BG_LOCK:
            if _BG_LOOP is None:
                _BG_LOOP = BackgroundLoop()
    return _BG_LOOP


def shutdown_background_loop():
    """Stop the background loop (for tests / shutdown)."""
    global _BG_LOOP
    if _BG_LOOP is not None:
        _BG_LOOP.loop.call_soon_threadsafe(_BG_LOOP.loop.stop)
        _BG_LOOP = None


# -------- Runner state --------

@dataclass
class RunnerState:
    task_id: str
    project_id: str
    concurrency: int
    effective_concurrency: int
    degraded: bool = False
    rate_limit_count: int = 0
    pause_event: asyncio.Event = field(default=None)
    cancel_event: asyncio.Event = field(default=None)
    loop: Any = field(default=None)  # background asyncio loop for thread-safe ops
    active_workers: int = 0
    asyncio_task: Optional[Any] = None  # concurrent.futures.Future from bg loop

    def __post_init__(self):
        # Events must be created on the background loop.
        bg = get_background_loop()
        self.loop = bg.loop
        fut1 = asyncio.run_coroutine_threadsafe(_make_event(), bg.loop)
        fut2 = asyncio.run_coroutine_threadsafe(_make_event(), bg.loop)
        self.pause_event = fut1.result(timeout=5)
        self.cancel_event = fut2.result(timeout=5)
        self.pause_event.set()


async def _make_event() -> asyncio.Event:
    return asyncio.Event()


# task_id -> RunnerState
RUNNERS: dict = {}


def new_task_id() -> str:
    return "task_" + secrets.token_urlsafe(12)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


def remap_indexes(old_indexes, old_size, new_size):
    """Python port of JS remapFailureIndexes."""
    if not isinstance(old_indexes, (list, tuple)):
        return []
    if not isinstance(old_size, (int, float)) or old_size <= 0:
        return []
    if not isinstance(new_size, (int, float)) or new_size <= 0:
        return []
    out = set()
    for raw in old_indexes:
        if not isinstance(raw, (int, float)) or raw < 0:
            continue
        i = int(raw)
        f = int(i * old_size // new_size)
        t = int(((i + 1) * old_size - 1) // new_size)
        if t < f:
            t = f
        for j in range(f, t + 1):
            out.add(j)
    return sorted(out)


def init_tasks_schema(conn):
    """Create tasks table + index. Called from init_db()."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            chunk_size INTEGER NOT NULL,
            concurrency INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            failed_indexes TEXT NOT NULL DEFAULT '[]',
            last_completed INTEGER NOT NULL DEFAULT 0,
            chapter_from TEXT NOT NULL DEFAULT '',
            chapter_to TEXT NOT NULL DEFAULT '',
            llm_model_id TEXT NOT NULL,
            system_prompt TEXT NOT NULL DEFAULT '',
            model_name TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            rate_limit_count INTEGER NOT NULL DEFAULT 0,
            degraded INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status)")


def mark_stale_tasks_interrupted():
    """Backend boot: queued/running/paused -> interrupted."""
    import main
    conn = main.get_db()
    try:
        conn.execute(
            "UPDATE tasks SET status='interrupted', updated_at=? "
            "WHERE status IN ('queued','running','paused')",
            (now_iso(),),
        )
        conn.commit()
    finally:
        conn.close()


# -------- DB helpers --------

def fetch_task_row(task_id):
    import main
    conn = main.get_db()
    try:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_task_progress(task_id, completed, success_count, failed_count,
                         failed_indexes, rate_limit_count=None, degraded=None):
    import main
    conn = main.get_db()
    try:
        sets = ["completed=?", "success_count=?", "failed_count=?",
                "failed_indexes=?", "last_completed=?", "updated_at=?"]
        params = [completed, success_count, failed_count,
                  json.dumps(list(failed_indexes), ensure_ascii=False),
                  completed, now_iso()]
        if rate_limit_count is not None:
            sets.append("rate_limit_count=?")
            params.append(rate_limit_count)
        if degraded is not None:
            sets.append("degraded=?")
            params.append(1 if degraded else 0)
        params.append(task_id)
        conn.execute(
            f"UPDATE tasks SET {', '.join(sets)} WHERE id=?",
            params,
        )
        conn.commit()
    finally:
        conn.close()


def update_task_status(task_id, status, started_at=None, finished_at=None, error=None):
    import main
    conn = main.get_db()
    try:
        sets = ["status=?", "updated_at=?"]
        params = [status, now_iso()]
        if started_at is not None:
            sets.append("started_at=?")
            params.append(started_at)
        if finished_at is not None:
            sets.append("finished_at=?")
            params.append(finished_at)
        if error is not None:
            sets.append("error=?")
            params.append(error[:500])
        params.append(task_id)
        conn.execute(
            f"UPDATE tasks SET {', '.join(sets)} WHERE id=?",
            params,
        )
        conn.commit()
    finally:
        conn.close()


def list_tasks_for_project(pid):
    """List all tasks for a project."""
    import main
    conn = main.get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC",
            (pid,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# -------- Worker pool (runs on background loop) --------

async def run_task(task_id, pid, kind, chunk_size, concurrency,
                   llm_model_id, system_prompt, model_name,
                   chapter_from, chapter_to,
                   total_chunks, chunk_indexes, project_text, ranges,
                   start_index=0, retry_remapped=None,
                   llm_request_timeout=None):
    """Drive a worker pool over chunk_indexes for the given task.

    Designed to run on the background loop so HTTP request lifecycle doesn't
    cancel us. Uses a single deque (no asyncio.Queue) guarded by a lock to
    avoid consumer races when concurrency is high.
    """
    import main
    AnalyzeRequest = main.AnalyzeRequest
    _analyze_with_llm = main._analyze_with_llm
    _get_chapter_for_chunk = main._get_chapter_for_chunk
    if llm_request_timeout is None:
        llm_request_timeout = main.LLM_REQUEST_TIMEOUT

    runner = RUNNERS.get(task_id)
    if not runner:
        return

    if kind == "retry" and isinstance(retry_remapped, (list, tuple)):
        targets = list(retry_remapped)
    else:
        targets = list(chunk_indexes[start_index:])

    update_task_status(task_id, "running", started_at=now_iso())

    completed_box = [start_index]
    success_box = [0]
    fail_box = [0]
    failed_indexes: list = []
    persist_helper = _persist_result_helper()

    # Shared work queue: deque + lock (simpler & safer than asyncio.Queue
    # when the consumer is mid-await).
    from collections import deque
    work_lock = asyncio.Lock()
    work_deque = deque(targets)
    work_done = [False]  # set when deque empties

    async def acquire_slot():
        while not runner.cancel_event.is_set():
            if runner.active_workers < runner.effective_concurrency:
                runner.active_workers += 1
                return True
            try:
                await asyncio.wait_for(runner.cancel_event.wait(), timeout=0.05)
            except asyncio.TimeoutError:
                pass
        return False

    async def release_slot():
        if runner.active_workers > 0:
            runner.active_workers -= 1

    async def worker(worker_id):
        try:
            while True:
                if runner.cancel_event.is_set():
                    return
                await runner.pause_event.wait()
                if not await acquire_slot():
                    return
                idx = None
                try:
                    async with work_lock:
                        if work_deque:
                            idx = work_deque.popleft()
                    if idx is None:
                        return
                    try:
                        chunk_text = project_text[idx * chunk_size : (idx + 1) * chunk_size]
                        chapter = _get_chapter_for_chunk(idx, chunk_size, ranges) or ""
                        result = await _process_chunk(
                            AnalyzeRequest,
                            _analyze_with_llm,
                            idx, chunk_size, chunk_text, chapter,
                            llm_model_id, system_prompt,
                            llm_request_timeout,
                        )
                        if result["ok"]:
                            try:
                                persist_helper(pid, result["response"], chapter)
                                success_box[0] += 1
                            except Exception as e:
                                failed_indexes.append(idx)
                                fail_box[0] += 1
                                print(f"warn: task {task_id} persist failed for chunk {idx}: {e}", flush=True)
                        else:
                            failed_indexes.append(idx)
                            fail_box[0] += 1
                            sc = result["status_code"] or 0
                            if sc in (429, 503):
                                runner.rate_limit_count += 1
                                if runner.rate_limit_count >= RATE_LIMIT_WINDOW and not runner.degraded:
                                    runner.degraded = True
                                    runner.effective_concurrency = MIN_CONCURRENCY
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        failed_indexes.append(idx)
                        fail_box[0] += 1
                        print(f"warn: task {task_id} chunk {idx} error: {e!r}", flush=True)
                    finally:
                        completed_box[0] += 1
                        update_task_progress(
                            task_id,
                            completed_box[0],
                            success_box[0],
                            fail_box[0],
                            failed_indexes,
                            rate_limit_count=runner.rate_limit_count,
                            degraded=runner.degraded,
                        )
                finally:
                    await release_slot()
        except asyncio.CancelledError:
            # External cancellation (e.g. cancel_task); let it bubble.
            raise

    initial_workers = min(max(concurrency, 1), max(len(targets), 1)) if targets else 0
    if initial_workers == 0:
        _finalize(task_id, runner, fail_box[0])
        return

    runner.active_workers = 0
    worker_tasks = [asyncio.create_task(worker(i)) for i in range(initial_workers)]
    try:
        await asyncio.gather(*worker_tasks, return_exceptions=True)
    finally:
        _finalize(task_id, runner, fail_box[0])


def _finalize(task_id, runner, failed_count):
    if runner is None:
        return
    if runner.cancel_event.is_set():
        status = "cancelled"
    elif failed_count > 0:
        status = "failed"
    else:
        status = "completed"
    update_task_status(task_id, status, finished_at=now_iso())
    RUNNERS.pop(task_id, None)


async def _process_chunk(AnalyzeRequestCls, _analyze_with_llm,
                         idx, chunk_size, chunk_text, chapter,
                         llm_model_id, system_prompt, llm_request_timeout):
    """Slice text, call _analyze_with_llm. Return {ok, response, status_code}."""
    if not chunk_text:
        return {"ok": True, "response": None, "status_code": 200}
    prefix = f"[current chapter:{chapter}]" if chapter else "[current chapter:unknown]"
    sliced = f"{prefix}\n{chunk_text}"
    req = AnalyzeRequestCls(
        model_id=llm_model_id,
        system_prompt=system_prompt,
        text=sliced,
        chunk_index=idx,
        chunk_size=chunk_size,
        chunk_chapter=chapter,
    )
    try:
        resp = await asyncio.wait_for(_analyze_with_llm(req), timeout=llm_request_timeout)
        return {"ok": True, "response": resp, "status_code": 200}
    except asyncio.TimeoutError:
        return {"ok": False, "response": None, "status_code": 504, "message": "timeout"}
    except Exception as e:
        sc = getattr(e, "status_code", None)
        code = int(sc) if isinstance(sc, int) else 0
        if not code:
            name = type(e).__name__
            if name == "RateLimitError":
                code = 429
            elif name in ("InternalServerError", "APIConnectionError"):
                code = 503
        msg = ""
        try:
            detail = getattr(e, "detail", None)
            if isinstance(detail, dict):
                msg = str(detail.get("message") or detail.get("error") or "")[:300]
            else:
                msg = str(detail)[:300]
        except Exception:
            msg = str(e)[:300]
        return {"ok": False, "response": None, "status_code": code or 500, "message": msg}


def _persist_result_helper():
    """Closure that writes nodes/edges into the DB."""
    import main

    def _persist(pid, data, fallback_chapter):
        if data is None:
            return
        nodes = getattr(data, "nodes", None) or []
        edges = getattr(data, "edges", None) or []
        if not nodes and not edges:
            return
        conn = main.get_db()
        try:
            node_id_map = {}
            label_of = {}
            for n in nodes:
                node_id = n.id.strip()
                label = n.label.strip()
                sect = (n.sect or "unknown").strip()
                chapter = (n.chapter or "").strip() or fallback_chapter
                existing = conn.execute(
                    "SELECT id, sect, chapter FROM nodes WHERE project_id=? AND label=?",
                    (pid, label),
                ).fetchone()
                if existing:
                    final_id = existing["id"]
                    node_id_map[node_id] = final_id
                    if sect and sect != "unknown" and (not existing["sect"] or existing["sect"] == "unknown"):
                        conn.execute(
                            "UPDATE nodes SET sect=? WHERE id=? AND project_id=?",
                            (sect, final_id, pid),
                        )
                    if chapter and not existing["chapter"]:
                        conn.execute(
                            "UPDATE nodes SET chapter=? WHERE id=? AND project_id=?",
                            (chapter, final_id, pid),
                        )
                else:
                    final_id = node_id
                    node_id_map[node_id] = final_id
                    conn.execute(
                        "INSERT OR IGNORE INTO nodes (id, label, sect, project_id, chapter) VALUES (?,?,?,?,?)",
                        (final_id, label, sect, pid, chapter),
                    )
                label_of[final_id] = label
            for e in edges:
                source = node_id_map.get(e.source.strip(), e.source.strip())
                target = node_id_map.get(e.target.strip(), e.target.strip())
                label = (e.label or "related").strip()
                edge_chapter = (e.chapter or "").strip() or fallback_chapter
                if source == target:
                    continue
                for nid in (source, target):
                    if nid not in label_of:
                        row = conn.execute(
                            "SELECT label FROM nodes WHERE project_id=? AND id=?", (pid, nid),
                        ).fetchone()
                        if row:
                            label_of[nid] = row["label"]
                existing = conn.execute(
                    "SELECT id, label, chapter FROM edges "
                    "WHERE project_id=? AND ((source=? AND target=?) OR (source=? AND target=?)) "
                    "ORDER BY rowid LIMIT 1",
                    (pid, source, target, target, source),
                ).fetchone()
                if existing:
                    updates = ["occurrence = occurrence + 1"]
                    params = []
                    if edge_chapter and not existing["chapter"]:
                        updates.append("chapter = ?")
                        params.append(edge_chapter)
                    existing_labels = [x.strip() for x in existing["label"].split(" -> ")]
                    if label not in existing_labels:
                        new_label = existing["label"] + " -> " + label
                        updates.append("label = ?")
                        params.append(new_label)
                    params.append(existing["id"])
                    conn.execute(
                        f"UPDATE edges SET {', '.join(updates)} WHERE id=?",
                        params,
                    )
                else:
                    src, tgt = main._canonical_direction(source, target, label_of)
                    eid = f"edge_{secrets.token_hex(8)}"
                    conn.execute(
                        "INSERT INTO edges (id, source, target, label, project_id, chapter, occurrence) VALUES (?,?,?,?,?,?,?)",
                        (eid, src, tgt, label, pid, edge_chapter, 1),
                    )
            conn.commit()
        finally:
            conn.close()

    return _persist


# -------- Action helpers (called from sync HTTP handlers) --------

def _set_event_threadsafe(loop, event: asyncio.Event):
    """Set an asyncio.Event from any thread, safely."""
    if loop is None or event is None:
        return
    loop.call_soon_threadsafe(event.set)


def _clear_event_threadsafe(loop, event: asyncio.Event):
    if loop is None or event is None:
        return
    loop.call_soon_threadsafe(event.clear)


def submit_run_task(**kwargs):
    """Schedule run_task on the background loop; returns the Future."""
    bg = get_background_loop()
    coro = run_task(**kwargs)
    return bg.submit(coro)


def pause_task(task_id):
    runner = RUNNERS.get(task_id)
    row = fetch_task_row(task_id)
    if not row:
        return False
    if row["status"] not in STATUS_ACTIVE:
        return False
    if runner:
        _clear_event_threadsafe(runner.loop, runner.pause_event)
    update_task_status(task_id, "paused")
    return True


def resume_task(task_id):
    runner = RUNNERS.get(task_id)
    row = fetch_task_row(task_id)
    if not row:
        return False
    if row["status"] != "paused":
        return False
    if runner:
        _set_event_threadsafe(runner.loop, runner.pause_event)
    update_task_status(task_id, "running")
    return True


def cancel_task(task_id):
    runner = RUNNERS.get(task_id)
    row = fetch_task_row(task_id)
    if not row:
        return False
    if row["status"] in STATUS_TERMINAL:
        return False
    if runner:
        _set_event_threadsafe(runner.loop, runner.pause_event)
        _set_event_threadsafe(runner.loop, runner.cancel_event)
    update_task_status(task_id, "cancelled", finished_at=now_iso())
    RUNNERS.pop(task_id, None)
    return True


def set_task_concurrency(task_id, new_concurrency):
    runner = RUNNERS.get(task_id)
    row = fetch_task_row(task_id)
    if not row:
        return False
    if row["status"] not in STATUS_ACTIVE:
        return False
    try:
        n = int(new_concurrency)
    except (TypeError, ValueError):
        return False
    if n < MIN_CONCURRENCY:
        n = MIN_CONCURRENCY
    if n > MAX_CONCURRENCY:
        n = MAX_CONCURRENCY
    if runner:
        if runner.degraded:
            return False
        runner.concurrency = n
        runner.effective_concurrency = n
    import main
    conn = main.get_db()
    try:
        conn.execute(
            "UPDATE tasks SET concurrency=?, updated_at=? WHERE id=?",
            (n, now_iso(), task_id),
        )
        conn.commit()
    finally:
        conn.close()
    return True


def cancel_tasks_for_project(pid):
    """Called from delete_proj before FK CASCADE removes rows."""
    count = 0
    for tid, runner in list(RUNNERS.items()):
        if runner.project_id != pid:
            continue
        _set_event_threadsafe(runner.loop, runner.pause_event)
        _set_event_threadsafe(runner.loop, runner.cancel_event)
        RUNNERS.pop(tid, None)
        count += 1
    import main
    conn = main.get_db()
    try:
        cur = conn.execute(
            "UPDATE tasks SET status='cancelled', finished_at=?, updated_at=? "
            "WHERE project_id=? AND status IN ('queued','running','paused','interrupted')",
            (now_iso(), now_iso(), pid),
        )
        conn.commit()
        count += cur.rowcount
    finally:
        conn.close()
    return count