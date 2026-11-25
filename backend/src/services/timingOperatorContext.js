const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const enabled = () => process.env.TIMING_OPERATOR_ENABLED === 'true';

function openAuthorization(envelope, { competitionId, userId, secret, now = Date.now() }) {
  try {
    if (typeof envelope !== 'string' || envelope.length > 24000 || !secret) throw new Error();
    if (envelope.split('.').length !== 4) throw new Error();
    const [version, iv, tag, body] = envelope.split('.');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error();
    const key = crypto.createHash('sha256').update(`timing-operator-v1:${secret}`).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${competitionId}:${userId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
    if (value.competitionId !== competitionId || value.userId !== userId || !Number.isSafeInteger(value.accountId)
      || value.accountId <= 0 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 600000
      || !/^Bearer [^\s]+$/.test(value.authorization)
      || (value.organizationId !== null && (!Number.isSafeInteger(value.organizationId) || value.organizationId <= 0))) throw new Error();
    return value;
  } catch {
    throw new Error('La autorización del operador venció o cambió. Envía de nuevo la solicitud desde Timing.');
  }
}

function withOperatorAuthorization(value, run) { return context.run(value, run); }
function currentOperator() { return context.getStore() || null; }
function requireOperator() {
  const value = currentOperator();
  if (!enabled() || !value || value.expiresAt <= Date.now()) throw new Error('Esta operación requiere una sesión vigente del operador en Timing.');
  return value;
}

module.exports = { enabled, openAuthorization, withOperatorAuthorization, currentOperator, requireOperator };
