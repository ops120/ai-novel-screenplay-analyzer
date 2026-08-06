const DIRECT_BACKEND_API = 'http://127.0.0.1:28000/api';

export function resolveApiBase({ envBase, protocol } = {}) {
  if (typeof envBase === 'string' && envBase.trim()) {
    return envBase.trim();
  }
  return protocol === 'file:' ? DIRECT_BACKEND_API : '/api';
}

