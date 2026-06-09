const admin = require("firebase-admin");
const config = require("../config");

let firebaseApp = null;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  if (!config.firebase.projectId) return null;

  firebaseApp = admin.initializeApp({
    projectId: config.firebase.projectId,
  });
  return firebaseApp;
}

function extractBearer(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function requireFirebaseAuth(req, res, next) {
  const app = getFirebaseApp();
  if (!app) {
    if (config.env === "production") {
      return res.status(500).json({ error: "Firebase auth no configurado" });
    }
    req.user = { uid: "dev", email: "dev@local" };
    return next();
  }

  const token = extractBearer(req);
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    req.user = await admin.auth(app).verifyIdToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Token invalido" });
  }
}

function requireExotimerApiKey(req, res, next) {
  if (!config.security.exotimerApiKey) {
    if (config.env === "production") {
      return res.status(500).json({ error: "API key Exotimer no configurada" });
    }
    return next();
  }

  const token = req.headers["x-support-api-key"];
  if (token !== config.security.exotimerApiKey) {
    return res.status(401).json({ error: "API key invalida" });
  }

  return next();
}

module.exports = {
  requireExotimerApiKey,
  requireFirebaseAuth,
};
