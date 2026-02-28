/**
 * Vercel Serverless Function — OpenF1 API Proxy
 *
 * Handles OAuth2 authentication and proxies requests to the OpenF1 REST API.
 * Credentials are stored in Vercel environment variables, never exposed to clients.
 *
 * Usage: GET /api/f1?endpoint=location&session_key=9947&driver_number=1
 */

const OPENF1_BASE = 'https://api.openf1.org/v1';
const OPENF1_TOKEN_URL = 'https://api.openf1.org/token';

const ALLOWED_ENDPOINTS = new Set([
  'sessions', 'drivers', 'laps', 'location', 'car_data',
  'position', 'stints', 'pit', 'race_control', 'weather',
]);

// Module-level token cache (persists across warm invocations)
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing OPENF1_USERNAME or OPENF1_PASSWORD environment variables');
  }

  const resp = await fetch(OPENF1_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  // Tokens expire after 1 hour; cache with 5-minute safety margin
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint, ...params } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing "endpoint" query parameter' });
  }

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: `Invalid endpoint: ${endpoint}` });
  }

  // Build query string for OpenF1 (forward all params except "endpoint")
  const qs = new URLSearchParams(params).toString();
  const url = `${OPENF1_BASE}/${endpoint}${qs ? '?' + qs : ''}`;

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getToken();
      const apiResp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (apiResp.status === 429) {
        // Rate limited — wait and retry
        const wait = (attempt + 1) * 5_000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (apiResp.status === 401) {
        // Token expired mid-request — force refresh and retry
        cachedToken = null;
        tokenExpiry = 0;
        continue;
      }

      if (!apiResp.ok) {
        const text = await apiResp.text();
        return res.status(apiResp.status).json({
          error: `OpenF1 API error (${apiResp.status})`,
          detail: text,
        });
      }

      const data = await apiResp.json();

      // Cache control: live data should not be cached, historical can be
      res.setHeader('Cache-Control', 'public, max-age=2, s-maxage=2');
      return res.status(200).json(data);
    } catch (err) {
      lastError = err;
    }
  }

  return res.status(502).json({
    error: 'Failed to fetch from OpenF1 after retries',
    detail: lastError?.message,
  });
}
