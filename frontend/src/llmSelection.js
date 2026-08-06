export const LAST_LLM_ID_KEY = 'storymap_last_llm_id'
export const LEGACY_LLM_CONFIG_KEY = 'llm_config'

export function readSelectedLlmId(storage) {
  try {
    return storage.getItem(LAST_LLM_ID_KEY) || null
  } catch {
    return null
  }
}

export function writeSelectedLlmId(storage, id) {
  try {
    if (id == null) {
      storage.removeItem(LAST_LLM_ID_KEY)
    } else {
      storage.setItem(LAST_LLM_ID_KEY, String(id))
    }
  } catch {
    // Storage can be unavailable; selection still works in memory.
  }
}

export function clearLegacyLlmConfig(storage) {
  try {
    storage.removeItem(LEGACY_LLM_CONFIG_KEY)
  } catch {
    // Legacy cleanup is best-effort.
  }
}

function findCanonicalId(models, candidate) {
  if (candidate == null) return null
  return models.find((model) => String(model.id) === String(candidate))?.id ?? null
}

export function resolveSelectedLlmId(models, { currentId, persistedId } = {}) {
  if (!Array.isArray(models) || models.length === 0) return null

  return findCanonicalId(models, currentId)
    ?? findCanonicalId(models, persistedId)
    ?? models.find((model) => model.is_default)?.id
    ?? models[0].id
}
