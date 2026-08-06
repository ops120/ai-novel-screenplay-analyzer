import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
};

const { useStore } = await import('./store.js');
const initialState = useStore.getState();

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function silenceExpectedErrors() {
  console.error = () => {};
}

function resetStore(overrides = {}) {
  useStore.setState({
    ...initialState,
    currentProjectId: null,
    nodes: [],
    edges: [],
    isLoadingProject: false,
    projectError: '',
    ...overrides,
  }, true);
}

test('project error is initially empty before any test reset', () => {
  assert.equal(useStore.getState().projectError, '');
});

test('project error starts empty and selecting clears stale state while pending', async () => {
  resetStore({ nodes: [{ id: 'old' }], edges: [{ id: 'old-edge' }], projectError: 'old error' });
  const request = deferred();
  silenceExpectedErrors();
  globalThis.fetch = () => request.promise;

  const selection = useStore.getState().selectProject(7);

  assert.equal(useStore.getState().currentProjectId, 7);
  assert.deepEqual(useStore.getState().nodes, []);
  assert.deepEqual(useStore.getState().edges, []);
  assert.equal(useStore.getState().isLoadingProject, true);
  assert.equal(useStore.getState().projectError, '');

  request.reject(new Error('test cleanup'));
  await selection;
});

test('successful project load keeps error empty and installs graph data', async () => {
  resetStore({ projectError: 'old error' });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ nodes: [{ id: 'n1' }], edges: [{ id: 'e1' }] }),
  });

  await useStore.getState().selectProject(8);

  assert.deepEqual(useStore.getState().nodes, [{ id: 'n1' }]);
  assert.deepEqual(useStore.getState().edges, [{ id: 'e1' }]);
  assert.equal(useStore.getState().isLoadingProject, false);
  assert.equal(useStore.getState().projectError, '');
});

test('rejected project load exposes a readable error instead of ordinary empty state', async () => {
  resetStore();
  silenceExpectedErrors();
  globalThis.fetch = async () => { throw new Error('network unavailable'); };

  await useStore.getState().selectProject(9);

  assert.deepEqual(useStore.getState().nodes, []);
  assert.deepEqual(useStore.getState().edges, []);
  assert.equal(useStore.getState().isLoadingProject, false);
  assert.match(useStore.getState().projectError, /network unavailable/i);
});

test('non-2xx project load is treated as an error even when JSON is valid', async () => {
  resetStore();
  silenceExpectedErrors();
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    json: async () => ({ nodes: [{ id: 'must-not-appear' }], edges: [] }),
  });

  await useStore.getState().selectProject(10);

  assert.deepEqual(useStore.getState().nodes, []);
  assert.deepEqual(useStore.getState().edges, []);
  assert.equal(useStore.getState().isLoadingProject, false);
  assert.match(useStore.getState().projectError, /503|service unavailable/i);
});

test('invalid JSON project response becomes a readable load error', async () => {
  resetStore();
  silenceExpectedErrors();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token'); },
  });

  await useStore.getState().selectProject(11);

  assert.equal(useStore.getState().isLoadingProject, false);
  assert.match(useStore.getState().projectError, /unexpected token/i);
});

test('deleting the current project clears its load error', async () => {
  resetStore({ currentProjectId: 12, projectError: 'load failed' });
  globalThis.fetch = async (url) => url.endsWith('/projects/12')
    ? { ok: true }
    : { ok: true, json: async () => [] };

  await useStore.getState().deleteProject(12);

  assert.equal(useStore.getState().currentProjectId, null);
  assert.equal(useStore.getState().projectError, '');
});

test('creating a project clears a stale load error and automatically selects it', async () => {
  resetStore({ projectError: 'old load error' });
  const projectData = deferred();
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/projects') && options.method === 'POST') {
      return { ok: true, json: async () => ({ id: 13 }) };
    }
    if (url.endsWith('/projects')) {
      return { ok: true, json: async () => [{ id: 13, name: 'New project' }] };
    }
    if (url.endsWith('/projects/13/data')) {
      return projectData.promise;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  let completed = false;
  const creation = useStore.getState().createProject('New project').then(() => { completed = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(completed, false);

  projectData.resolve({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
  await creation;

  assert.equal(useStore.getState().projectError, '');
  assert.equal(useStore.getState().currentProjectId, 13);
  assert.equal(useStore.getState().isLoadingProject, false);
});

test('createProject rejects non-2xx responses and never selects an undefined project', async () => {
  resetStore({ projectError: 'old load error' });
  silenceExpectedErrors();
  globalThis.fetch = async () => ({ ok: false, status: 422, statusText: 'Unprocessable Entity' });

  await assert.rejects(
    useStore.getState().createProject('Broken project'),
    /422|unprocessable entity/i,
  );

  assert.equal(useStore.getState().currentProjectId, null);
});

test('a late successful selection cannot overwrite the newer project state', async () => {
  resetStore();
  const requestA = deferred();
  const requestB = deferred();
  globalThis.fetch = url => url.endsWith('/projects/21/data') ? requestA.promise : requestB.promise;

  const selectionA = useStore.getState().selectProject(21);
  const selectionB = useStore.getState().selectProject(22);
  requestB.resolve({ ok: true, json: async () => ({ nodes: [{ id: 'B' }], edges: [] }) });
  await selectionB;
  requestA.resolve({ ok: true, json: async () => ({ nodes: [{ id: 'A' }], edges: [] }) });
  await selectionA;

  assert.equal(useStore.getState().currentProjectId, 22);
  assert.deepEqual(useStore.getState().nodes, [{ id: 'B' }]);
  assert.equal(useStore.getState().projectError, '');
  assert.equal(useStore.getState().isLoadingProject, false);
});

test('a late failed selection cannot overwrite the newer project state', async () => {
  resetStore();
  const requestA = deferred();
  const requestB = deferred();
  silenceExpectedErrors();
  globalThis.fetch = url => url.endsWith('/projects/23/data') ? requestA.promise : requestB.promise;

  const selectionA = useStore.getState().selectProject(23);
  const selectionB = useStore.getState().selectProject(24);
  requestB.resolve({ ok: true, json: async () => ({ nodes: [{ id: 'B' }], edges: [] }) });
  await selectionB;
  requestA.reject(new Error('late A failure'));
  await selectionA;

  assert.equal(useStore.getState().currentProjectId, 24);
  assert.deepEqual(useStore.getState().nodes, [{ id: 'B' }]);
  assert.equal(useStore.getState().projectError, '');
  assert.equal(useStore.getState().isLoadingProject, false);
});

test('deleting the current project invalidates its in-flight load', async () => {
  resetStore();
  const projectData = deferred();
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/projects/25/data')) return projectData.promise;
    if (url.endsWith('/projects/25') && options.method === 'DELETE') return { ok: true };
    if (url.endsWith('/projects')) return { ok: true, json: async () => [] };
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const selection = useStore.getState().selectProject(25);
  await useStore.getState().deleteProject(25);
  projectData.resolve({ ok: true, json: async () => ({ nodes: [{ id: 'late' }], edges: [] }) });
  await selection;

  assert.equal(useStore.getState().currentProjectId, null);
  assert.deepEqual(useStore.getState().nodes, []);
  assert.equal(useStore.getState().projectError, '');
  assert.equal(useStore.getState().isLoadingProject, false);
});

// v26：项目简介落库端到端（store.updateProjectDescription）
test('updateProjectDescription sends PUT with empty name + new description, refreshes projects', async () => {
  resetStore();
  let putBody = null;
  const fetched = [];
  globalThis.fetch = async (url, options = {}) => {
    fetched.push({ url, options });
    if (url.endsWith('/projects/99') && options.method === 'PUT') {
      putBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'success' }) };
    }
    if (url.endsWith('/projects')) {
      return { ok: true, json: async () => [{ id: 99, name: '原名', description: '新简介' }] };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await useStore.getState().updateProjectDescription(99, '新简介');
  assert.equal(result.ok, true);
  assert.deepEqual(putBody, { name: '', description: '新简介' });
  // 验证 projects 被刷新
  const proj = useStore.getState().projects.find((p) => p.id === 99);
  assert.equal(proj.description, '新简介');
});

test('updateProjectDescription rejects non-2xx responses and surfaces the error', async () => {
  resetStore();
  silenceExpectedErrors();
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error' });

  await assert.rejects(
    useStore.getState().updateProjectDescription(100, 'X'),
    /500|server error/i,
  );
});
