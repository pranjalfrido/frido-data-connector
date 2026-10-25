import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { getUserProfile } from './users.js';

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;

const jwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 min
});

function getKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

export async function validateRequest(req) {
  // AUTH_ENABLED=true → enforce Azure AD token; anything else → open (testing mode)
  if (process.env.AUTH_ENABLED !== 'true') {
    return { ok: true, user: { email: 'dev@myfrido.com', role: 'founder', name: 'Dev Mode' } };
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return { ok: false, status: 401, message: 'Missing Authorization header.' };
  }

  // API key path — used by Claude.ai connector until Azure OAuth is configured
  const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY;
  if (CONNECTOR_API_KEY && authHeader === `Bearer ${CONNECTOR_API_KEY}`) {
    return { ok: true, user: { email: 'connector@myfrido.com', role: 'analyst', name: 'Connector Service' } };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'Missing or invalid Authorization header.' };
  }

  const token = authHeader.slice(7);

  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      jwt.verify(
        token,
        getKey,
        {
          audience: CLIENT_ID,
          issuer: [
            `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
            `https://sts.windows.net/${TENANT_ID}/`,
          ],
          algorithms: ['RS256'],
        },
        (err, payload) => (err ? reject(err) : resolve(payload))
      );
    });
  } catch (err) {
    return { ok: false, status: 401, message: `Token invalid: ${err.message}` };
  }

  const email = (decoded.preferred_username || decoded.upn || decoded.email || '').toLowerCase();
  if (!email.endsWith('@myfrido.com')) {
    return { ok: false, status: 403, message: 'Access restricted to @myfrido.com accounts.' };
  }

  // Allowlist + role check from DB
  const profile = await getUserProfile(email);
  if (!profile) {
    return {
      ok: false,
      status: 403,
      message: 'Access not granted. Request access from the Analytics team at accounts@myfrido.com.',
    };
  }
  if (!profile.is_active) {
    return { ok: false, status: 403, message: 'Your access has been deactivated. Contact accounts@myfrido.com.' };
  }

  return { ok: true, user: { email, role: profile.role, name: profile.full_name } };
}
