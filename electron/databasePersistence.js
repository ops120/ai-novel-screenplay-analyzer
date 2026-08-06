const fs = require('node:fs');
const path = require('node:path');

function getPersistentDatabasePath(userDataPath) {
  return path.join(userDataPath, 'storymap.db');
}

function getLegacyDatabaseCandidates({
  backendPath,
  isPackaged,
  developmentDatabasePath,
  legacyUserDataDatabasePath
}) {
  const candidates = [];

  if (backendPath) {
    candidates.push(path.join(path.dirname(backendPath), 'storymap.db'));
  }

  if (!isPackaged && developmentDatabasePath) {
    candidates.push(developmentDatabasePath);
  }

  if (legacyUserDataDatabasePath) {
    candidates.push(legacyUserDataDatabasePath);
  }

  return [...new Set(candidates.filter(Boolean).map((candidate) => path.normalize(candidate)))];
}

function migrateLegacyDatabase({ targetDb, legacyCandidates, fsImpl = fs }) {
  fsImpl.mkdirSync(path.dirname(targetDb), { recursive: true });

  if (fsImpl.existsSync(targetDb)) {
    return { status: 'existing', source: null, target: targetDb };
  }

  const source = (legacyCandidates || []).find((candidate) => (
    candidate && fsImpl.existsSync(candidate)
  ));

  if (!source) {
    return { status: 'fresh', source: null, target: targetDb };
  }

  const sourceWal = `${source}-wal`;
  const targetWal = `${targetDb}-wal`;
  const createdTargets = [];
  const copyFileExclusiveFlag = fsImpl.constants?.COPYFILE_EXCL
    ?? fs.constants.COPYFILE_EXCL;

  if (fsImpl.existsSync(targetWal)) {
    throw new Error(`Database migration aborted: target WAL already exists at ${targetWal}`);
  }

  try {
    fsImpl.copyFileSync(source, targetDb, copyFileExclusiveFlag);
    createdTargets.push(targetDb);

    if (fsImpl.existsSync(sourceWal)) {
      fsImpl.copyFileSync(sourceWal, targetWal, copyFileExclusiveFlag);
      createdTargets.push(targetWal);
    }
  } catch (error) {
    const cleanupErrors = [];

    for (const createdTarget of createdTargets.reverse()) {
      try {
        if (fsImpl.existsSync(createdTarget)) {
          fsImpl.unlinkSync(createdTarget);
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    if (cleanupErrors.length > 0) {
      error.cleanupErrors = cleanupErrors;
    }
    throw error;
  }

  return { status: 'migrated', source, target: targetDb };
}

function buildBackendEnv(baseEnv, databasePath) {
  return {
    ...baseEnv,
    STORYMAP_DB: databasePath
  };
}

function focusMainWindow(mainWindow) {
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

module.exports = {
  getPersistentDatabasePath,
  getLegacyDatabaseCandidates,
  migrateLegacyDatabase,
  buildBackendEnv,
  focusMainWindow
};
