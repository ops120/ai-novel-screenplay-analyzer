import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LAST_LLM_ID_KEY,
  LEGACY_LLM_CONFIG_KEY,
  clearLegacyLlmConfig,
  readSelectedLlmId,
  resolveSelectedLlmId,
  writeSelectedLlmId,
} from './llmSelection.js'

test('readSelectedLlmId reads a stored id and normalizes empty values', () => {
  assert.equal(readSelectedLlmId({ getItem: (key) => key === LAST_LLM_ID_KEY ? 'model-2' : null }), 'model-2')
  assert.equal(readSelectedLlmId({ getItem: () => '' }), null)
  assert.equal(readSelectedLlmId({ getItem: () => undefined }), null)
})

test('readSelectedLlmId silently returns null when storage throws', () => {
  assert.equal(readSelectedLlmId({ getItem: () => { throw new Error('private') } }), null)
})

test('writeSelectedLlmId stores an id and removes it for null', () => {
  const calls = []
  const storage = {
    setItem: (...args) => calls.push(['setItem', ...args]),
    removeItem: (...args) => calls.push(['removeItem', ...args]),
  }

  writeSelectedLlmId(storage, 7)
  writeSelectedLlmId(storage, null)

  assert.deepEqual(calls, [
    ['setItem', LAST_LLM_ID_KEY, '7'],
    ['removeItem', LAST_LLM_ID_KEY],
  ])
})

test('writeSelectedLlmId silently ignores storage errors', () => {
  assert.doesNotThrow(() => writeSelectedLlmId({ setItem: () => { throw new Error('private') } }, 'model-1'))
  assert.doesNotThrow(() => writeSelectedLlmId({ removeItem: () => { throw new Error('private') } }, null))
})

test('clearLegacyLlmConfig removes the legacy key and ignores storage errors', () => {
  let removedKey
  clearLegacyLlmConfig({ removeItem: (key) => { removedKey = key } })
  assert.equal(removedKey, LEGACY_LLM_CONFIG_KEY)
  assert.doesNotThrow(() => clearLegacyLlmConfig({ removeItem: () => { throw new Error('private') } }))
})

test('resolveSelectedLlmId prefers current id and returns the canonical id', () => {
  const models = [{ id: 1 }, { id: 2, is_default: true }, { id: 3 }]
  assert.equal(resolveSelectedLlmId(models, { currentId: '3', persistedId: '2' }), 3)
})

test('resolveSelectedLlmId falls back to persisted id', () => {
  const models = [{ id: 1 }, { id: 2, is_default: true }, { id: 3 }]
  assert.equal(resolveSelectedLlmId(models, { currentId: 'missing', persistedId: '3' }), 3)
})

test('resolveSelectedLlmId falls back to default and then first model', () => {
  assert.equal(resolveSelectedLlmId([{ id: 1 }, { id: 2, is_default: true }], {}), 2)
  assert.equal(resolveSelectedLlmId([{ id: 1 }, { id: 2 }], {}), 1)
})

test('resolveSelectedLlmId returns null for an empty model list', () => {
  assert.equal(resolveSelectedLlmId([], { currentId: '1', persistedId: '1' }), null)
})

test('resolveSelectedLlmId treats non-array model values as empty', () => {
  assert.equal(resolveSelectedLlmId(undefined, {}), null)
  assert.equal(resolveSelectedLlmId(null, {}), null)
  assert.equal(resolveSelectedLlmId({}, {}), null)
  assert.equal(resolveSelectedLlmId('model-1', {}), null)
})
