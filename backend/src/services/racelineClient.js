const axios = require("axios");
const config = require("../config");

let cachedAccessToken = config.raceline.token || null;

function assertClientConfig() {
  if (!config.raceline.baseUrl) {
    throw new Error("Falta configurar RACELINE_API_BASE_URL.");
  }
}

async function loginRaceline() {
  assertClientConfig();

  if (!config.raceline.email || !config.raceline.password) {
    if (cachedAccessToken) return cachedAccessToken;
    throw new Error("Falta configurar RACELINE_API_EMAIL o RACELINE_API_PASSWORD.");
  }

  const { data } = await axios.post(
    `${config.raceline.baseUrl}/identity/api/v1/auth/login`,
    {
      email: config.raceline.email,
      password: config.raceline.password,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    }
  );

  const token = data?.access_token || data?.access || data?.token || data?.jwt;
  if (!token) throw new Error("Race Line no devolvio access_token.");
  cachedAccessToken = token;
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;
  return loginRaceline();
}

function requestHeaders(token, headers, data) {
  const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(!isFormData ? { "Content-Type": "application/json" } : {}),
    ...(headers || {}),
  };
}

async function apiRequest({ method = "GET", path, data, params, headers, responseType, retryOnAuth = true }) {
  assertClientConfig();
  const token = await getAccessToken();

  try {
    const response = await axios.request({
      baseURL: config.raceline.baseUrl,
      url: path,
      method,
      data,
      params,
      responseType,
      headers: requestHeaders(token, headers, data),
      timeout: 30000,
    });

    return response.data;
  } catch (error) {
    if (retryOnAuth && error.response?.status === 401) {
      cachedAccessToken = null;
      await loginRaceline();
      return apiRequest({ method, path, data, params, headers, responseType, retryOnAuth: false });
    }

    throw error;
  }
}

async function apiMultipartRequest({ method = "POST", path, fields = {}, files = {}, retryOnAuth = true }) {
  const formData = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  for (const [key, file] of Object.entries(files)) {
    if (!file?.buffer) continue;
    const blob = new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" });
    formData.append(key, blob, file.filename || `${key}.bin`);
  }

  try {
    return await apiRequest({ method, path, data: formData, retryOnAuth });
  } catch (error) {
    if (retryOnAuth && error.response?.status === 401) {
      cachedAccessToken = null;
      await loginRaceline();
      return apiMultipartRequest({ method, path, fields, files, retryOnAuth: false });
    }
    throw error;
  }
}

function resetCachedAccessToken() {
  cachedAccessToken = null;
}

module.exports = {
  apiMultipartRequest,
  apiRequest,
  loginRaceline,
  resetCachedAccessToken,
};
