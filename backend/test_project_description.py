"""v26：项目简介（description）端到端覆盖。

覆盖：
- 旧库（projects 表无 description 列）迁移幂等；
- 新库 projects 表自带 description 列；
- ProjectIn 接受 description；
- add_proj 写入 description；
- rename_proj(name='', description=...) 仅改 description；name 仍由 rename 流程保留；
- rename_proj 重名检查保留；
- GET /projects 返回 description；
- export 路径携带 description，import 路径恢复 description；
- 老导入 payload 缺 description 时回落空串。

设计：在不启动 FastAPI server 的前提下，直接复刻 init_db / 项目路由的关键路径，
避免对全局 DB_FILE 造成影响。init_db 通过 monkey-patching DB_FILE 到临时 SQLite 文件实现。
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from unittest import mock


@contextmanager
def _temp_db_with_schema(schema_sql: str):
    """创建一个临时 SQLite，注入自定义 schema（模拟旧库或新库）。"""
    fd, path = tempfile.mkstemp(prefix='storymap_desc_test_', suffix='.db')
    os.close(fd)
    try:
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.executescript(schema_sql)
        conn.commit()
        conn.close()
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _import_main_with_db(db_path):
    """加载 main 模块并把 DB_FILE / _connect / get_db 切到临时 db。"""
    # 每个测试都重新 import，避免全局状态污染
    import importlib
    if 'main' in importlib.sys.modules:
        del importlib.sys.modules['main']
    import main  # noqa: WPS433 (测试中允许动态 import)
    main.DB_FILE = db_path

    def _patched_connect():
        conn = sqlite3.connect(
            db_path, isolation_level=None, timeout=main.DB_TIMEOUT
        )
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {int(main.DB_TIMEOUT * 1000)}")
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.OperationalError:
            pass
        return conn

    main._connect = _patched_connect
    main.get_db = lambda: _patched_connect()
    return main


def _bootstrap_app(main):
    """拿到 FastAPI app + TestClient。"""
    from fastapi.testclient import TestClient
    return TestClient(main.app)


def _cols_of(db_path: str, table: str):
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return [r['name'] for r in rows]
    finally:
        conn.close()


def _legacy_schema_sql() -> str:
    """v25 之前的 schema：projects 只有 id/name。"""
    return """
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    """


def _new_schema_sql() -> str:
    """v26 之后：projects 带 description。"""
    return """
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT NOT NULL DEFAULT '');
    """


class LegacyMigrationTest(unittest.TestCase):
    """旧库迁移：init_db 必须给 projects 表加 description 列，幂等。"""

    def test_init_db_adds_description_column_to_legacy_schema(self):
        with _temp_db_with_schema(_legacy_schema_sql()) as db_path:
            main = _import_main_with_db(db_path)
            main.init_db()
            cols = _cols_of(db_path, 'projects')
            self.assertIn('description', cols, '旧库迁移后 projects 应有 description 列')

    def test_init_db_idempotent_on_already_migrated_schema(self):
        with _temp_db_with_schema(_new_schema_sql()) as db_path:
            main = _import_main_with_db(db_path)
            # 多次调用不应抛错；幂等。
            main.init_db()
            main.init_db()
            cols = _cols_of(db_path, 'projects')
            # 新 schema 只该有 description 一列（不会重复加）
            self.assertEqual(cols.count('description'), 1)


class ProjectApiDescriptionTest(unittest.TestCase):
    """HTTP 层：add_proj / rename_proj / GET / import / export 全链路 description。"""

    def setUp(self):
        # 新 schema 起，避免 init_db 重入
        self._tmp = tempfile.NamedTemporaryFile(prefix='storymap_desc_api_', suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name
        # 起一个全新的临时 DB
        main = _import_main_with_db(self.db_path)
        main.init_db()
        # progress_repository 需要 llm_models / progress 表；init_db 已处理
        self.main = main
        self.client = _bootstrap_app(main)

    def tearDown(self):
        # 关闭可能残留的 TestClient 内部连接（FastAPI starlette）
        try:
            self.client.close()
        except Exception:
            pass
        # Windows 上 SQLite 文件可能还被 WAL 占用，重试几次
        for _ in range(5):
            try:
                os.unlink(self.db_path)
                break
            except PermissionError:
                import time
                time.sleep(0.05)
            except FileNotFoundError:
                break

    # -------- POST /projects --------

    def test_create_project_persists_description(self):
        res = self.client.post('/api/projects', json={
            'name': '卷宗A',
            'description': '首段简介：测试项目，验证 description 落库。',
        })
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body['name'], '卷宗A')

        list_res = self.client.get('/api/projects')
        self.assertEqual(list_res.status_code, 200)
        rows = list_res.json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['description'], '首段简介：测试项目，验证 description 落库。')

    def test_create_project_default_description_is_empty(self):
        res = self.client.post('/api/projects', json={'name': '默认卷宗'})
        self.assertEqual(res.status_code, 200)
        pid = res.json()['id']
        row = self.client.get('/api/projects').json()
        self.assertEqual(row[0]['description'], '')

    # -------- PUT /projects/{id} --------

    def test_update_description_only_keeps_existing_name(self):
        created = self.client.post('/api/projects', json={'name': '原名', 'description': '旧简介'}).json()
        pid = created['id']

        # description-only update: name 字段缺失 → Pydantic 默认值？ProjectIn 必须允许 description-only 写入。
        # 由约定：name 不可缺；但允许「name 不变 + description 更新」，
        # 即 PUT 调用方必须传同名（保持），同时可更新 description。
        # 我们约定 name 与 description 都可独立更新：name 为空时保持，description 传了就更新。
        res = self.client.put(f'/api/projects/{pid}', json={'name': '', 'description': '新简介'})
        self.assertEqual(res.status_code, 200, res.text)

        rows = self.client.get('/api/projects').json()
        proj = next(r for r in rows if r['id'] == pid)
        self.assertEqual(proj['name'], '原名', 'name 为空时必须保持原值')
        self.assertEqual(proj['description'], '新简介')

    def test_update_name_and_description_together(self):
        created = self.client.post('/api/projects', json={'name': '旧名', 'description': '旧简介'}).json()
        pid = created['id']

        res = self.client.put(f'/api/projects/{pid}', json={'name': '新名', 'description': '新简介'})
        self.assertEqual(res.status_code, 200)

        proj = self.client.get('/api/projects').json()[0]
        self.assertEqual(proj['name'], '新名')
        self.assertEqual(proj['description'], '新简介')

    def test_duplicate_name_still_returns_409_when_renaming(self):
        a = self.client.post('/api/projects', json={'name': 'A'}).json()
        b = self.client.post('/api/projects', json={'name': 'B'}).json()

        # 把 B 改名为 A → 409
        res = self.client.put(f'/api/projects/{b["id"]}', json={'name': 'A', 'description': ''})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()['detail']['error'], 'duplicate_name')

    # -------- export / import 端到端 --------

    def test_export_includes_description(self):
        created = self.client.post('/api/projects', json={
            'name': '导出卷宗',
            'description': '这是用于导出往返的简介。',
        }).json()
        pid = created['id']

        # 默认密文导出
        blob = self.client.get(f'/api/projects/{pid}/export').json()
        self.assertTrue(blob.get('encrypted'))
        # 解密应能看到 description
        decrypted = self.main._decrypt_blob(blob['data'])
        self.assertEqual(decrypted['project']['name'], '导出卷宗')
        self.assertEqual(decrypted['project']['description'], '这是用于导出往返的简介。')

    def test_plaintext_export_includes_description(self):
        created = self.client.post('/api/projects', json={
            'name': '明文导出',
            'description': '明文简介',
        }).json()
        pid = created['id']
        res = self.client.get(f'/api/projects/{pid}/export?format=plaintext').json()
        self.assertEqual(res['project']['name'], '明文导出')
        self.assertEqual(res['project']['description'], '明文简介')

    def test_import_round_trip_preserves_description(self):
        payload = {
            'project': {'name': '导入卷宗', 'description': '导入简介'},
            'nodes': [{'id': 'n1', 'label': '甲'}],
            'edges': [{'source': 'n1', 'target': 'n1', 'label': '自指'}],  # 自指会被去重；用正经对
        }
        payload['edges'] = [{'source': 'n1', 'target': 'n2', 'label': '相识'},
                            {'source': 'n2', 'target': 'n1', 'label': '相识'}]
        payload['nodes'].append({'id': 'n2', 'label': '乙'})
        res = self.client.post('/api/projects/import', json=payload)
        self.assertEqual(res.status_code, 200, res.text)

        rows = self.client.get('/api/projects').json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['description'], '导入简介')

    def test_import_legacy_payload_missing_description_falls_back_to_empty(self):
        payload = {
            'project': {'name': '老导出卷宗'},  # 故意没有 description
            'nodes': [{'id': 'n1', 'label': '甲'}],
            'edges': [],
        }
        res = self.client.post('/api/projects/import', json=payload)
        self.assertEqual(res.status_code, 200, res.text)
        rows = self.client.get('/api/projects').json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['description'], '')


if __name__ == '__main__':
    unittest.main()