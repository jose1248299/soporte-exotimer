const rawBase = import.meta.env.VITE_API_BASE || (import.meta.env.PROD ? "" : "http://localhost:4000");

export const API_BASE = rawBase.replace(/\/+$/, "");
let authTokenProvider = null;

export function setAuthTokenProvider(provider) {
  authTokenProvider = provider;
}

export function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch(path, options = {}) {
  const timeoutMs = options.timeoutMs || 8000;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const token = authTokenProvider ? await authTokenProvider() : null;

  try {
    return await fetch(apiUrl(path), {
      ...fetchOptions,
      signal: fetchOptions.signal || controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(fetchOptions.headers || {}),
      },
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function apiBlobUrl(path, options = {}) {
  const response = await apiFetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error("No se pudo cargar archivo");
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
