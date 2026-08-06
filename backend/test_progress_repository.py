import sqlite3
import unittest

from progress_repository import (
    delete_progress,
    get_progress,
    init_progress_schema,
    list_progress,
    update_progress,
    upsert_progress,
)


class ProgressRepositoryTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)')
        self.conn.execute('INSERT INTO projects (id, name) VALUES (?, ?)', ('project-999', '999'))
        init_progress_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_large_text_round_trips_through_sqlite(self):
        text = '修' * 5_100_000
        upsert_progress(self.conn, 'project-999', {
            'total_chunks': 10_200,
            'last_completed': 3,
            'text': text,
            'chunk_size': 500,
            'concurrency': 3,
            'llm_model_name': 'M',
            'chapter_from': '',
            'chapter_to': '',
        })

        stored = get_progress(self.conn, 'project-999')
        self.assertEqual(stored['text'], text)
        self.assertEqual(stored['lastCompleted'], 3)
        self.assertNotIn('text', list_progress(self.conn)[0])

        update_progress(self.conn, 'project-999', 4)
        self.assertEqual(get_progress(self.conn, 'project-999')['lastCompleted'], 4)
        delete_progress(self.conn, 'project-999')
        self.assertIsNone(get_progress(self.conn, 'project-999'))


if __name__ == '__main__':
    unittest.main()
