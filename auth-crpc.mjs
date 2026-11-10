#!/usr/bin/env node
/**
 * One-shot OAuth2 authenticator for CRPC members (single UTokyo account, READ-ONLY).
 * Cross-platform (macOS / Windows / Linux).
 *
 * Grants Drive + Calendar + Gmail read-only scopes in a single browser flow and
 * writes ONE token file shared by the gdrive / gcal / gmail MCP wrappers.
 *
 * Usage:  node auth-crpc.mjs
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';

const CONFIG_DIR = join(homedir(), '.config', 'gdrive-mcp');
const OAUTH_PATH = process.env.GDRIVE_OAUTH_PATH || join(CONFIG_DIR, 'credentials.json');
const CREDS_OUT = process.env.GOOGLE_CREDENTIALS_PATH || join(CONFIG_DIR, '.google-credentials-utokyo.json');
const REDIRECT_URI = 'http://localhost:4567';
const PORT = 4567;

// Drive/Calendar are read-only. Gmail is read-only PLUS compose so members can
// create drafts (the MCP server exposes create_draft but NO send tool, so mail
// cannot be sent through it — drafts only). Granted in one consent.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

let oauth;
try {
  oauth = JSON.parse(readFileSync(OAUTH_PATH, 'utf8'));
} catch {
  console.error(`Cannot read OAuth client from: ${OAUTH_PATH}`);
  console.error('管理者から配布された credentials.json をこのパスに置いてください。');
  process.exit(1);
}
const clientId = oauth.installed?.client_id || oauth.web?.client_id;
const clientSecret = oauth.installed?.client_secret || oauth.web?.client_secret;
if (!clientId || !clientSecret) {
  console.error(`client_id / client_secret を読み取れません: ${OAUTH_PATH}`);
  process.exit(1);
}

// Open the system browser (platform-specific; exec runs via cmd.exe on Windows so `start` works).
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log('ブラウザを自動で開けませんでした。上記 URL を手動で開いてください。');
  });
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n=== CRPC Google 認証 (Drive / Calendar / Gmail 読み取り専用) ===');
console.log('ブラウザが開きます。自分の @g.ecc.u-tokyo.ac.jp アカウントでログインしてください。\n');
console.log('URL:', authUrl.toString(), '\n');

openBrowser(authUrl.toString());

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>認証エラー: ${error}</h2>`);
    console.error('Auth error:', error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end('No code found.');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>認証完了！このタブを閉じてください。</h2>');
  server.close();

  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    console.error('Token exchange failed:', tokenData.error, tokenData.error_description || '');
    process.exit(1);
  }

  // Write exactly 5 fields; drop Workspace-only `refresh_token_expires_in`
  // (it triggers an `invalid_request` in the gdrive child server).
  const creds = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  };
  writeFileSync(CREDS_OUT, JSON.stringify(creds, null, 2));

  console.log('✅ 認証成功！トークンを保存しました:', CREDS_OUT);
  console.log('   Scopes:', creds.scope);
  console.log('   Expires:', new Date(creds.expiry_date).toISOString());
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`ローカルサーバー起動中 (port ${PORT})... ブラウザでの認証を待っています。`);
});
