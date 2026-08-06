const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getPersistentDatabasePath,
  getLegacyDatabaseCandidates,
  migrateLegacyDatabase,
  buildBackendEnv,
  focusMainWindow
} = require('./databasePersistence');

function makeTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storymap-db-persistence-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

test('getPersistentDatabasePath stores the database under userData', () => {
  const userDataPath = path.join(os.tmpdir(), 'storymap-user-data');

  assert.equal(
    getPersistentDatabasePath(userDataPath),
    path.join(userDataPath, 'storymap.db')
  );
});

test('buildBackendEnv preserves the base environment and overrides STORYMAP_DB', () => {
  const baseEnv = { PATH: 'existing-path', STORYMAP_DB: 'legacy.db' };

  const result = buildBackendEnv(baseEnv, 'persistent.db');

  assert.deepEqual(result, { PATH: 'existing-path', STORYMAP_DB: 'persistent.db' });
  assert.deepEqual(baseEnv, { PATH: 'existing-path', STORYMAP_DB: 'legacy.db' });
});

test('migrateLegacyDatabase creates the target directory and reports fresh when no source exists', (t) => {
  const tempDir = makeTempDir(t);
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');

  const result = migrateLegacyDatabase({
    targetDb,
    legacyCandidates: [path.join(tempDir, 'missing.db')]
  });

  assert.deepEqual(result, { status: 'fresh', source: null, target: targetDb });
  assert.equal(fs.existsSync(path.dirname(targetDb)), true);
  assert.equal(fs.existsSync(targetDb), false);
});

test('migrateLegacyDatabase copies the main database and WAL without moving the legacy files', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy', 'storymap.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'main database');
  fs.writeFileSync(`${source}-wal`, 'pending transactions');
  fs.writeFileSync(`${source}-shm`, 'shared memory');

  const result = migrateLegacyDatabase({ targetDb, legacyCandidates: [source] });

  assert.deepEqual(result, { status: 'migrated', source, target: targetDb });
  assert.equal(fs.readFileSync(targetDb, 'utf8'), 'main database');
  assert.equal(fs.readFileSync(`${targetDb}-wal`, 'utf8'), 'pending transactions');
  assert.equal(fs.existsSync(`${targetDb}-shm`), false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'main database');
  assert.equal(fs.readFileSync(`${source}-wal`, 'utf8'), 'pending transactions');
});

test('migrateLegacyDatabase reports existing and never overwrites the target', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.mkdirSync(path.dirname(targetDb), { recursive: true });
  fs.writeFileSync(source, 'legacy database');
  fs.writeFileSync(targetDb, 'current database');

  const result = migrateLegacyDatabase({ targetDb, legacyCandidates: [source] });

  assert.deepEqual(result, { status: 'existing', source: null, target: targetDb });
  assert.equal(fs.readFileSync(targetDb, 'utf8'), 'current database');
  assert.equal(fs.readFileSync(source, 'utf8'), 'legacy database');
});

test('migrateLegacyDatabase uses the first existing legacy candidate', (t) => {
  const tempDir = makeTempDir(t);
  const first = path.join(tempDir, 'first.db');
  const second = path.join(tempDir, 'second.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.writeFileSync(first, 'first candidate');
  fs.writeFileSync(second, 'second candidate');

  const result = migrateLegacyDatabase({
    targetDb,
    legacyCandidates: [path.join(tempDir, 'missing.db'), first, second]
  });

  assert.deepEqual(result, { status: 'migrated', source: first, target: targetDb });
  assert.equal(fs.readFileSync(targetDb, 'utf8'), 'first candidate');
});

test('migrateLegacyDatabase removes newly created main and WAL files when copying fails', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.writeFileSync(source, 'main database');
  fs.writeFileSync(`${source}-wal`, 'pending transactions');

  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'copyFileSync') {
        return target[property];
      }

      return (from, to) => {
        if (from.endsWith('-wal')) {
          throw new Error('simulated WAL copy failure');
        }
        target.copyFileSync(from, to);
      };
    }
  });

  assert.throws(
    () => migrateLegacyDatabase({
      targetDb,
      legacyCandidates: [source],
      fsImpl: failingFs
    }),
    /simulated WAL copy failure/
  );
  assert.equal(fs.existsSync(targetDb), false);
  assert.equal(fs.existsSync(`${targetDb}-wal`), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(`${source}-wal`), true);
});

test('migrateLegacyDatabase preserves the original copy error when cleanup also fails', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.writeFileSync(source, 'main database');
  fs.writeFileSync(`${source}-wal`, 'pending transactions');

  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'copyFileSync') {
        return (from, to, flags) => {
          if (from.endsWith('-wal')) {
            throw new Error('original-copy-error');
          }
          target.copyFileSync(from, to, flags);
        };
      }

      if (property === 'unlinkSync') {
        return () => {
          throw new Error('cleanup-error');
        };
      }

      return target[property];
    }
  });

  let thrown;
  try {
    migrateLegacyDatabase({
      targetDb,
      legacyCandidates: [source],
      fsImpl: failingFs
    });
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown?.message, 'original-copy-error');
  assert.deepEqual(
    thrown?.cleanupErrors?.map((error) => error.message),
    ['cleanup-error']
  );
});

test('migrateLegacyDatabase rejects an orphan target WAL without overwriting or deleting it', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  const targetWal = `${targetDb}-wal`;
  fs.mkdirSync(path.dirname(targetDb), { recursive: true });
  fs.writeFileSync(source, 'main database');
  fs.writeFileSync(`${source}-wal`, 'pending transactions');
  fs.writeFileSync(targetWal, 'pre-existing target WAL');

  assert.throws(
    () => migrateLegacyDatabase({ targetDb, legacyCandidates: [source] }),
    /target WAL already exists/
  );
  assert.equal(fs.existsSync(targetDb), false);
  assert.equal(fs.readFileSync(targetWal, 'utf8'), 'pre-existing target WAL');
  assert.equal(fs.readFileSync(source, 'utf8'), 'main database');
  assert.equal(fs.readFileSync(`${source}-wal`, 'utf8'), 'pending transactions');
});

test('migrateLegacyDatabase preserves a target database created after the existence check', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  fs.writeFileSync(source, 'legacy database');

  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'copyFileSync') {
        return target[property];
      }

      return (from, to, flags) => {
        fs.writeFileSync(targetDb, 'competing database');
        target.copyFileSync(from, to, flags);
      };
    }
  });

  assert.throws(
    () => migrateLegacyDatabase({
      targetDb,
      legacyCandidates: [source],
      fsImpl: racingFs
    }),
    (error) => error.code === 'EEXIST'
  );
  assert.equal(fs.readFileSync(targetDb, 'utf8'), 'competing database');
});

test('migrateLegacyDatabase preserves a target WAL created after the existence check', (t) => {
  const tempDir = makeTempDir(t);
  const source = path.join(tempDir, 'legacy.db');
  const targetDb = path.join(tempDir, 'user-data', 'storymap.db');
  const targetWal = `${targetDb}-wal`;
  fs.writeFileSync(source, 'legacy database');
  fs.writeFileSync(`${source}-wal`, 'legacy WAL');

  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'copyFileSync') {
        return target[property];
      }

      return (from, to, flags) => {
        if (to === targetWal) {
          fs.writeFileSync(targetWal, 'competing WAL');
        }
        target.copyFileSync(from, to, flags);
      };
    }
  });

  assert.throws(
    () => migrateLegacyDatabase({
      targetDb,
      legacyCandidates: [source],
      fsImpl: racingFs
    }),
    (error) => error.code === 'EEXIST'
  );
  assert.equal(fs.existsSync(targetDb), false);
  assert.equal(fs.readFileSync(targetWal, 'utf8'), 'competing WAL');
});

test('getLegacyDatabaseCandidates limits packaged lookup to the backend executable directory', (t) => {
  const tempDir = makeTempDir(t);
  const backendPath = path.join(tempDir, 'resources', 'backend', 'storymap-backend.exe');
  const developmentDatabasePath = path.join(tempDir, 'project', 'storymap.db');

  assert.deepEqual(
    getLegacyDatabaseCandidates({
      backendPath,
      isPackaged: true,
      developmentDatabasePath
    }),
    [path.join(path.dirname(backendPath), 'storymap.db')]
  );
});

test('getLegacyDatabaseCandidates appends an explicit development database only when unpackaged', (t) => {
  const tempDir = makeTempDir(t);
  const backendPath = path.join(tempDir, 'electron', 'backend', 'storymap-backend.exe');
  const developmentDatabasePath = path.join(tempDir, 'storymap.db');

  assert.deepEqual(
    getLegacyDatabaseCandidates({
      backendPath,
      isPackaged: false,
      developmentDatabasePath
    }),
    [path.join(path.dirname(backendPath), 'storymap.db'), developmentDatabasePath]
  );
});

test('getLegacyDatabaseCandidates includes the old product userData database', (t) => {
  const tempDir = makeTempDir(t);
  const backendPath = path.join(tempDir, 'resources', 'backend', 'storymap-backend.exe');
  const developmentDatabasePath = path.join(tempDir, 'project', 'storymap.db');
  const legacyUserDataDatabasePath = path.join(tempDir, 'old-user-data', 'storymap.db');

  assert.deepEqual(
    getLegacyDatabaseCandidates({
      backendPath,
      isPackaged: false,
      developmentDatabasePath,
      legacyUserDataDatabasePath
    }),
    [
      path.join(path.dirname(backendPath), 'storymap.db'),
      developmentDatabasePath,
      legacyUserDataDatabasePath
    ]
  );
});

test('getLegacyDatabaseCandidates filters empty values and removes duplicate paths', (t) => {
  const tempDir = makeTempDir(t);
  const backendPath = path.join(tempDir, 'backend', 'storymap-backend.exe');
  const backendDatabase = path.join(path.dirname(backendPath), 'storymap.db');

  assert.deepEqual(
    getLegacyDatabaseCandidates({
      backendPath,
      isPackaged: false,
      developmentDatabasePath: backendDatabase
    }),
    [backendDatabase]
  );
  assert.deepEqual(
    getLegacyDatabaseCandidates({
      backendPath: '',
      isPackaged: false,
      developmentDatabasePath: null
    }),
    []
  );
});

test('focusMainWindow restores a minimized window before focusing it', () => {
  const calls = [];
  const window = {
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus')
  };

  focusMainWindow(window);

  assert.deepEqual(calls, ['restore', 'focus']);
});
