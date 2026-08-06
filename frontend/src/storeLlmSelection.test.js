import assert from 'node:assert/strict'
import test from 'node:test'

function createMemoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

const storage = createMemoryStorage({
  llm_config: JSON.stringify({ api_key: 'legacy-secret' }),
})
globalThis.localStorage = storage

const { useStore } = await import('./store.js')

const INITIAL_LLM_STATE = {
  llmModels: [],
  currentLlmId: null,
}

function resetStore(entries = {}) {
  globalThis.localStorage = createMemoryStorage(entries)
  useStore.setState(INITIAL_LLM_STATE)
  return globalThis.localStorage
}

function response(data, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return data
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('module load removes legacy config and exposes no legacy config state or setter', () => {
  assert.equal(storage.getItem('llm_config'), null)
  const state = useStore.getState()
  assert.equal('llmConfig' in state, false)
  assert.equal('setLlmConfig' in state, false)
})

test('fetch restores a persisted DOM string as the canonical numeric model id', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: '2' })
  globalThis.fetch = async () => response([
    { id: 1, is_default: true },
    { id: 2 },
  ])

  await useStore.getState().fetchLlmModels()

  assert.equal(useStore.getState().currentLlmId, 2)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '2')
})

test('fetch replaces an invalid saved id with the default model', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: 'missing' })
  globalThis.fetch = async () => response([
    { id: 1 },
    { id: 2, is_default: true },
  ])

  await useStore.getState().fetchLlmModels()

  assert.equal(useStore.getState().currentLlmId, 2)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '2')
})

test('fetch falls back to the first model when there is no default', async () => {
  const localStorage = resetStore()
  globalThis.fetch = async () => response([{ id: 'first' }, { id: 'second' }])

  await useStore.getState().fetchLlmModels()

  assert.equal(useStore.getState().currentLlmId, 'first')
  assert.equal(localStorage.getItem('storymap_last_llm_id'), 'first')
})

test('fetching an empty model list clears state and persisted selection', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: '2' })
  useStore.setState({ llmModels: [{ id: 2 }], currentLlmId: 2 })
  globalThis.fetch = async () => response([])

  await useStore.getState().fetchLlmModels()

  assert.deepEqual(useStore.getState().llmModels, [])
  assert.equal(useStore.getState().currentLlmId, null)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), null)
})

test('a late older model response cannot overwrite the latest models or preference', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: '2' })
  const olderRequest = deferred()
  const latestRequest = deferred()
  const requests = [olderRequest.promise, latestRequest.promise]
  globalThis.fetch = async () => requests.shift()

  const olderFetch = useStore.getState().fetchLlmModels()
  const latestFetch = useStore.getState().fetchLlmModels()
  latestRequest.resolve(response([{ id: 1, is_default: true }]))
  await latestFetch
  olderRequest.resolve(response([{ id: 2 }]))
  await olderFetch

  assert.deepEqual(useStore.getState().llmModels, [{ id: 1, is_default: true }])
  assert.equal(useStore.getState().currentLlmId, 1)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '1')
})

test('select accepts a DOM string and stores the canonical model id', () => {
  const localStorage = resetStore()
  useStore.setState({ llmModels: [{ id: 2 }] })

  useStore.getState().selectLlmModel('2')

  assert.equal(useStore.getState().currentLlmId, 2)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '2')
})

test('selecting an invalid model clears state and persisted selection', () => {
  const localStorage = resetStore({ storymap_last_llm_id: '2' })
  useStore.setState({ llmModels: [{ id: 2 }], currentLlmId: 2 })

  useStore.getState().selectLlmModel('missing')

  assert.equal(useStore.getState().currentLlmId, null)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), null)
})

test('deleting the current model lets fetch calibration fall back to the default', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: '2' })
  useStore.setState({ llmModels: [{ id: 1 }, { id: 2 }], currentLlmId: 2 })
  const replies = [
    response({ status: 'success' }),
    response([{ id: 1, is_default: true }]),
  ]
  globalThis.fetch = async () => replies.shift()

  const result = await useStore.getState().deleteLlmModel('2')

  assert.deepEqual(result, { success: true })
  assert.equal(useStore.getState().currentLlmId, 1)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '1')
})

test('deleting a non-current model preserves the current selection', async () => {
  const localStorage = resetStore({ storymap_last_llm_id: '1' })
  useStore.setState({ llmModels: [{ id: 1 }, { id: 2 }], currentLlmId: 1 })
  const replies = [
    response({ status: 'success' }),
    response([{ id: 1 }]),
  ]
  globalThis.fetch = async () => replies.shift()

  await useStore.getState().deleteLlmModel('2')

  assert.equal(useStore.getState().currentLlmId, 1)
  assert.equal(localStorage.getItem('storymap_last_llm_id'), '1')
})

for (const [name, fetchImpl] of [
  ['network failure', async () => { throw new Error('offline') }],
  ['non-2xx response', async () => response([{ id: 9 }], { ok: false })],
  ['invalid JSON', async () => ({ ok: true, async json() { throw new Error('bad json') } })],
  ['non-array JSON', async () => response({ id: 9 })],
]) {
  test(`fetch preserves models and preference after ${name}`, async () => {
    const localStorage = resetStore({ storymap_last_llm_id: '2' })
    const existingModels = [{ id: 2 }]
    useStore.setState({ llmModels: existingModels, currentLlmId: 2 })
    globalThis.fetch = fetchImpl
    const originalError = console.error
    console.error = () => {}
    try {
      await useStore.getState().fetchLlmModels()
    } finally {
      console.error = originalError
    }

    assert.strictEqual(useStore.getState().llmModels, existingModels)
    assert.equal(useStore.getState().currentLlmId, 2)
    assert.equal(localStorage.getItem('storymap_last_llm_id'), '2')
  })
}

test('storage errors do not prevent fetch, select, or delete', async () => {
  resetStore()
  globalThis.localStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  globalThis.fetch = async () => response([{ id: 1 }])
  await useStore.getState().fetchLlmModels()
  assert.equal(useStore.getState().currentLlmId, 1)

  useStore.setState({ llmModels: [{ id: 1 }, { id: 2 }] })
  useStore.getState().selectLlmModel('2')
  assert.equal(useStore.getState().currentLlmId, 2)

  const replies = [response({ status: 'success' }), response([{ id: 1 }])]
  globalThis.fetch = async () => replies.shift()
  assert.deepEqual(await useStore.getState().deleteLlmModel('2'), { success: true })
  assert.equal(useStore.getState().currentLlmId, 1)
})
