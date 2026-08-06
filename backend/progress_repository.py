"""SQLite persistence for resumable analysis progress."""

import time


def init_progress_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS analysis_progress (
        project_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 1,
        timestamp INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        last_completed INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        chunk_size INTEGER NOT NULL,
        concurrency INTEGER NOT NULL,
        llm_model_name TEXT NOT NULL DEFAULT '',
        chapter_from TEXT NOT NULL DEFAULT '',
        chapter_to TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )''')


def _row_to_dict(row, *, include_text):
    if row is None:
        return None
    result = {
        'projectId': row['project_id'],
        'active': bool(row['active']),
        'timestamp': row['timestamp'],
        'totalChunks': row['total_chunks'],
        'lastCompleted': row['last_completed'],
        'chunkSize': row['chunk_size'],
        'concurrency': row['concurrency'],
        'llmModelName': row['llm_model_name'],
        'chapterFrom': row['chapter_from'],
        'chapterTo': row['chapter_to'],
    }
    if include_text:
        result['text'] = row['text']
    return result


def upsert_progress(conn, project_id, payload):
    timestamp = int(time.time() * 1000)
    conn.execute('''
        INSERT INTO analysis_progress (
            project_id, active, timestamp, total_chunks, last_completed, text,
            chunk_size, concurrency, llm_model_name, chapter_from, chapter_to
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
            active=1,
            timestamp=excluded.timestamp,
            total_chunks=excluded.total_chunks,
            last_completed=excluded.last_completed,
            text=excluded.text,
            chunk_size=excluded.chunk_size,
            concurrency=excluded.concurrency,
            llm_model_name=excluded.llm_model_name,
            chapter_from=excluded.chapter_from,
            chapter_to=excluded.chapter_to
    ''', (
        project_id,
        timestamp,
        payload['total_chunks'],
        payload['last_completed'],
        payload['text'],
        payload['chunk_size'],
        payload['concurrency'],
        payload.get('llm_model_name', ''),
        payload.get('chapter_from', ''),
        payload.get('chapter_to', ''),
    ))


def get_progress(conn, project_id):
    row = conn.execute(
        'SELECT * FROM analysis_progress WHERE project_id=? AND active=1',
        (project_id,),
    ).fetchone()
    return _row_to_dict(row, include_text=True)


def list_progress(conn):
    rows = conn.execute(
        'SELECT * FROM analysis_progress WHERE active=1 ORDER BY timestamp DESC'
    ).fetchall()
    return [_row_to_dict(row, include_text=False) for row in rows]


def update_progress(conn, project_id, last_completed):
    timestamp = int(time.time() * 1000)
    cursor = conn.execute('''
        UPDATE analysis_progress
        SET last_completed=MAX(last_completed, ?), timestamp=?
        WHERE project_id=? AND active=1
    ''', (last_completed, timestamp, project_id))
    return cursor.rowcount > 0


def delete_progress(conn, project_id):
    conn.execute('DELETE FROM analysis_progress WHERE project_id=?', (project_id,))
