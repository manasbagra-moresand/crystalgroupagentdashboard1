// Server-to-Server OAuth token exchange (account_credentials grant).
// https://developers.zoom.us/docs/internal-apps/s2s-oauth/
//
// This never touches the browser: the access token lives only in this process's memory,
// refreshed a minute before it expires.
const config = require('../config');

// Overridable for local testing against a mock Zoom server; defaults to the real endpoint.
const TOKEN_URL = process.env.ZOOM_OAUTH_URL || 'https://zoom.us/oauth/token';

let cached = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const { accountId, clientId, clientSecret } = config.zoom;
  if (!accountId || !clientId || !clientSecret) {
    throw new Error(
      'Zoom S2S OAuth credentials are missing. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ' +
      'ZOOM_CLIENT_SECRET (see .env.example).'
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zoom OAuth token request failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  cached = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cached.accessToken;
}

module.exports = { getAccessToken };
