"""Regression tests for project-library graph counts."""

import os
import sqlite3
import tempfile
import unittest

from test_project_description import _bootstrap_app, _import_main_with_db


class ProjectCountsApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(prefix="storymap_counts_", suffix=".db", delete=False)
        self.tmp.close()
        self.main = _import_main_with_db(self.tmp.name)
        self.main.init_db()
        self.client = _bootstrap_app(self.main)

    def tearDown(self):
        self.client.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.tmp.name + suffix)
            except FileNotFoundError:
                pass

    def test_project_list_returns_node_and_valid_edge_counts(self):
        conn = sqlite3.connect(self.tmp.name)
        try:
            conn.execute("INSERT INTO projects (id, name) VALUES (?, ?)", ("p1", "有数据"))
            conn.execute("INSERT INTO projects (id, name) VALUES (?, ?)", ("p2", "空项目"))
            conn.executemany(
                "INSERT INTO nodes (id, label, sect, project_id) VALUES (?, ?, ?, ?)",
                [("n1", "甲", "", "p1"), ("n2", "乙", "", "p1")],
            )
            conn.executemany(
                "INSERT INTO edges (id, source, target, label, project_id) VALUES (?, ?, ?, ?, ?)",
                [
                    ("e1", "n1", "n2", "朋友", "p1"),
                    ("orphan", "n1", "missing", "孤立", "p1"),
                ],
            )
            conn.commit()
        finally:
            conn.close()

        rows = {row["id"]: row for row in self.client.get("/api/projects").json()}
        self.assertEqual((rows["p1"]["nodeCount"], rows["p1"]["edgeCount"]), (2, 1))
        self.assertEqual((rows["p2"]["nodeCount"], rows["p2"]["edgeCount"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
