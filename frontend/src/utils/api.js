const rawBase = import.meta.env.VITE_API_BASE || (import.meta.env.PROD ? "" : "http://localhost:4000");

export const API_BASE = rawBase.replace(/\/+$/, "");

export function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch(path, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;

  try {
    return await fetch(apiUrl(path), {
      ...fetchOptions,
      signal: fetchOptions.signal || controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
  } finally {
    window.clearTimeout(timeout);
  }
}
