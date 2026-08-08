export function resolveApiBase({ envBase } = {}) {
  if (typeof envBase === 'string' && envBase.trim()) {
    return envBase.trim();
  }
  return '/api';
}

