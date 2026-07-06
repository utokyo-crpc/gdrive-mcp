#!/usr/bin/env node
/**
 * Wrapper for @modelcontextprotocol/server-gdrive
 * 1. Auto-refreshes expired access tokens before starting the server.
 * 2. Injects `instructions` into the initialize response.
 * 3. Adds a `read_file` tool (search tool only returns names; this reads content).
 */
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

async function refreshTokenIfNeeded(force = false) {
  const credsPath = process.env.GDRIVE_CREDENTIALS_PATH;
  const oauthPath = process.env.GDRIVE_OAUTH_PATH;
  if (!credsPath || !oauthPath) return;

  let creds, oauth;
  try {
    creds = JSON.parse(readFileSync(credsPath, 'utf8'));
    oauth = JSON.parse(readFileSync(oauthPath, 'utf8'));
  } catch { return; }

  if (!force && (!creds.expiry_date || creds.expiry_date > Date.now() + 300_000)) return;

  const clientId = oauth.installed?.client_id || oauth.web?.client_id;
  const clientSecret = oauth.installed?.client_secret || oauth.web?.client_secret;
  if (!clientId || !clientSecret || !creds.refresh_token) return;

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.error) {
      process.stderr.write(`gdrive-wrapper: token refresh failed: ${data.error}\n`);
      return;
    }
    const newCreds = {
      access_token: data.access_token,
      refresh_token: creds.refresh_token,
      scope: data.scope || creds.scope,
      token_type: data.token_type || creds.token_type,
      expiry_date: Date.now() + data.expires_in * 1000,
    };
    writeFileSync(credsPath, JSON.stringify(newCreds, null, 2));
    process.stderr.write(`gdrive-wrapper: token refreshed, expires ${new Date(newCreds.expiry_date).toISOString()}\n`);
  } catch (e) {
    process.stderr.write(`gdrive-wrapper: token refresh error: ${e.message}\n`);
  }
}

await refreshTokenIfNeeded();

async function getValidCreds() {
  await refreshTokenIfNeeded();
  return JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
}

// --- Drive API helper ---
async function driveGet(path) {
  let creds = await getValidCreds();
  let res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    creds = JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
    res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
  }
  return res;
}

// --- Sheets API helper ---
async function sheetsGet(path) {
  let creds = await getValidCreds();
  let res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    creds = JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
    res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
  }
  return res;
}

// --- Forms API helper ---
async function formsGet(formId) {
  let creds = await getValidCreds();
  let res = await fetch(`https://forms.googleapis.com/v1/forms/${formId}`, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    creds = JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
    res = await fetch(`https://forms.googleapis.com/v1/forms/${formId}`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
  }
  return res;
}

// --- Sheets API write helpers ---
async function sheetsPost(path, body) {
  let creds = await getValidCreds();
  let res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    creds = JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
    res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return res;
}

async function sheetsPut(path, body) {
  let creds = await getValidCreds();
  let res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    creds = JSON.parse(readFileSync(process.env.GDRIVE_CREDENTIALS_PATH, 'utf8'));
    res = await fetch(`https://sheets.googleapis.com/v4${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return res;
}

async function handleReadForm(formId) {
  const res = await formsGet(formId);
  const data = await res.json();

  if (data.error) {
    const hint = data.error.status === 'PERMISSION_DENIED'
      ? '\n\nHint: The forms.body.readonly scope may be missing. Re-run the auth script to add it.'
      : '';
    return {
      content: [{ type: 'text', text: `Forms API error: ${JSON.stringify(data.error)}${hint}` }],
      isError: true,
    };
  }

  const title = data.info?.title || '(no title)';
  const description = data.info?.description ? `\n${data.info.description}\n` : '';
  const items = data.items || [];

  const itemTexts = items.map((item, i) => {
    const itemTitle = item.title || '(no title)';
    const itemDesc = item.description ? `\n  ${item.description}` : '';
    const q = item.questionItem?.question;
    let qDetail = '';
    if (q) {
      if (q.choiceQuestion) {
        const choices = q.choiceQuestion.options?.map(o => `  - ${o.value}`).join('\n') || '';
        qDetail = `\n  Type: ${q.choiceQuestion.type}\n${choices}`;
      } else if (q.scaleQuestion) {
        qDetail = `\n  Type: Scale (${q.scaleQuestion.low}–${q.scaleQuestion.high})`;
      } else if (q.textQuestion) {
        qDetail = `\n  Type: ${q.textQuestion.paragraph ? 'Paragraph text' : 'Short text'}`;
      } else if (q.dateQuestion) {
        qDetail = '\n  Type: Date';
      } else if (q.timeQuestion) {
        qDetail = '\n  Type: Time';
      } else if (q.rowQuestion) {
        qDetail = '\n  Type: Row (grid)';
      }
      if (q.required) qDetail += '\n  Required: yes';
    }
    return `### Q${i + 1}. ${itemTitle}${itemDesc}${qDetail}`;
  });

  const text = `# ${title}${description}\n${itemTexts.join('\n\n')}`;
  return { content: [{ type: 'text', text }], isError: false };
}

function extractIdFromUrl(str) {
  if (!str) return null;
  const m = str.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  return m ? m[1] : null;
}

async function handleReadFile(query, args) {
  let file;
  const fileId = args?.file_id || extractIdFromUrl(query);

  if (fileId) {
    // Direct ID access — skip search (1 API call instead of 2+)
    const metaRes = await driveGet(`/files/${fileId}?fields=id,name,mimeType&supportsAllDrives=true`);
    const metaData = await metaRes.json();
    if (metaData.error) {
      return { content: [{ type: 'text', text: `Drive API error: ${JSON.stringify(metaData.error)}` }], isError: true };
    }
    file = metaData;
  } else if (query) {
    // Search by name
    const q = encodeURIComponent(`name contains '${query.replace(/'/g, "\\'")}' and trashed=false`);
    const searchRes = await driveGet(`/files?q=${q}&fields=files(id,name,mimeType)&pageSize=5&includeItemsFromAllDrives=true&supportsAllDrives=true`);
    const searchData = await searchRes.json();
    if (!searchData.files || searchData.files.length === 0) {
      return { content: [{ type: 'text', text: `No file found matching: ${query}` }], isError: false };
    }
    file = searchData.files[0];
  } else {
    return { content: [{ type: 'text', text: 'Error: provide either file_id or query' }], isError: true };
  }
  let text = '';

  if (file.mimeType === 'application/vnd.google-apps.document') {
    const r = await driveGet(`/files/${file.id}/export?mimeType=text/plain&supportsAllDrives=true`);
    text = await r.text();
  } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const sheetName = args?.sheet_name;
    const metaRes = await sheetsGet(`/spreadsheets/${file.id}?fields=sheets.properties`);
    const metaData = await metaRes.json();
    if (metaData.error) {
      text = `Sheets API error: ${JSON.stringify(metaData.error)}`;
    } else {
      const sheets = metaData.sheets.map(s => s.properties.title);
      const targets = sheetName ? sheets.filter(s => s === sheetName) : sheets;
      const parts = [];
      for (const sheet of targets) {
        const valRes = await sheetsGet(`/spreadsheets/${file.id}/values/${encodeURIComponent(sheet)}`);
        const valData = await valRes.json();
        const rows = (valData.values || []).map(row => row.join(',')).join('\n');
        parts.push(`## ${sheet}\n${rows}`);
      }
      text = parts.join('\n\n');
    }
  } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
    const r = await driveGet(`/files/${file.id}/export?mimeType=text/plain&supportsAllDrives=true`);
    text = await r.text();
  } else if (file.mimeType === 'application/vnd.google-apps.form') {
    return handleReadForm(file.id);
  } else if (file.mimeType.startsWith('text/') || file.mimeType === 'application/json') {
    const r = await driveGet(`/files/${file.id}?alt=media&supportsAllDrives=true`);
    text = await r.text();
  } else {
    text = `File found: ${file.name} (${file.mimeType})\nThis file type cannot be read as text.`;
  }

  return {
    content: [{ type: 'text', text: `# ${file.name}\n\n${text}` }],
    isError: false,
  };
}

async function handleSearch(query) {
  // fullText search with Shared Drives support
  const q = encodeURIComponent(`fullText contains '${query.replace(/'/g, "\\'")}' and trashed=false`);
  const searchRes = await driveGet(`/files?q=${q}&fields=files(id,name,mimeType,webViewLink,modifiedTime)&pageSize=10&includeItemsFromAllDrives=true&supportsAllDrives=true`);
  const searchData = await searchRes.json();

  if (searchData.error) {
    return { content: [{ type: 'text', text: `Search error: ${JSON.stringify(searchData.error)}` }], isError: true };
  }

  if (!searchData.files || searchData.files.length === 0) {
    return { content: [{ type: 'text', text: `No files found matching: ${query}` }], isError: false };
  }

  const list = searchData.files.map(f => {
    const modified = f.modifiedTime ? ` (modified: ${f.modifiedTime.slice(0, 10)})` : '';
    const link = f.webViewLink ? `\n  ${f.webViewLink}` : '';
    return `- ${f.name} [${f.mimeType}]${modified}${link}`;
  }).join('\n');

  return {
    content: [{ type: 'text', text: `Found ${searchData.files.length} file(s):\n${list}` }],
    isError: false,
  };
}

async function handleCreateSheet(spreadsheetId, sheetTitle) {
  const res = await sheetsPost(`/spreadsheets/${spreadsheetId}:batchUpdate`, {
    requests: [{
      addSheet: {
        properties: { title: sheetTitle },
      },
    }],
  });
  const data = await res.json();
  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }
  const added = data.replies?.[0]?.addSheet?.properties;
  return {
    content: [{ type: 'text', text: `Sheet created: "${added?.title}" (sheetId: ${added?.sheetId})` }],
    isError: false,
  };
}

async function handleWriteRows(spreadsheetId, range, values) {
  const res = await sheetsPut(
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { range, values }
  );
  const data = await res.json();
  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Written ${data.updatedRows} rows, ${data.updatedColumns} cols to ${data.updatedRange}` }],
    isError: false,
  };
}

async function handleClearSheet(spreadsheetId, range) {
  const res = await sheetsPost(
    `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    {}
  );
  const data = await res.json();
  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Cleared: ${data.clearedRange}` }],
    isError: false,
  };
}

const READ_FORM_TOOL = {
  name: 'read_form',
  description: 'Read a Google Form by its form ID. Returns the form title, description, and all questions with their types and options. The form ID can be found in the form URL: https://docs.google.com/forms/d/{formId}/edit',
  inputSchema: {
    type: 'object',
    properties: {
      form_id: { type: 'string', description: 'The Google Form ID (from the URL)' },
    },
    required: ['form_id'],
  },
};

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read the content of a file in Google Drive. Provide file_id for direct access (fastest, no search overhead), or query to search by name. Google Drive/Docs/Sheets URLs are also accepted as query. For spreadsheets, reads all sheets by default; use sheet_name to read a specific sheet.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'File name or partial name to search for, or a Google Drive URL (ID will be extracted automatically)' },
      file_id: { type: 'string', description: '(Optional) Google Drive file ID for direct access without search. Takes precedence over query.' },
      sheet_name: { type: 'string', description: '(Optional) Specific sheet name to read from a spreadsheet. If omitted, all sheets are returned.' },
    },
    required: [],
  },
};

const CREATE_SHEET_TOOL = {
  name: 'create_sheet',
  description: 'Add a new sheet (tab) to an existing Google Spreadsheet.',
  inputSchema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string', description: 'The spreadsheet ID' },
      sheet_title: { type: 'string', description: 'Title of the new sheet' },
    },
    required: ['spreadsheet_id', 'sheet_title'],
  },
};

const WRITE_ROWS_TOOL = {
  name: 'write_rows',
  description: 'Write data to a range in a Google Spreadsheet. Formulas (starting with =) are evaluated. Existing data in the range is overwritten.',
  inputSchema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string', description: 'The spreadsheet ID' },
      range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1" or "メンバー!A2:H10"' },
      values: {
        type: 'array',
        description: '2D array of values. Each inner array is a row.',
        items: { type: 'array', items: {} },
      },
    },
    required: ['spreadsheet_id', 'range', 'values'],
  },
};

const CLEAR_SHEET_TOOL = {
  name: 'clear_sheet',
  description: 'Clear all data in a range of a Google Spreadsheet. Does NOT delete the sheet itself.',
  inputSchema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string', description: 'The spreadsheet ID' },
      range: { type: 'string', description: 'A1 notation range, e.g. "旧データ!A:Z"' },
    },
    required: ['spreadsheet_id', 'range'],
  },
};

// --- Spawn child ---
const child = spawn(
  'npx',
  ['-y', '@modelcontextprotocol/server-gdrive'],
  // shell:true on Windows so the `npx.cmd` shim resolves (spawn can't run it directly → ENOENT)
  { env: process.env, stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' }
);

// --- stdin: intercept read_file tool calls ---
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString();
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) { child.stdin.write('\n'); continue; }
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'tools/call' && msg.params?.name === 'read_file') {
        const query = msg.params.arguments?.query || '';
        const args = msg.params.arguments || {};
        handleReadFile(query, args)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else if (msg.method === 'tools/call' && msg.params?.name === 'create_sheet') {
        const { spreadsheet_id, sheet_title } = msg.params.arguments || {};
        handleCreateSheet(spreadsheet_id, sheet_title)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else if (msg.method === 'tools/call' && msg.params?.name === 'write_rows') {
        const { spreadsheet_id, range, values } = msg.params.arguments || {};
        handleWriteRows(spreadsheet_id, range, values)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else if (msg.method === 'tools/call' && msg.params?.name === 'clear_sheet') {
        const { spreadsheet_id, range } = msg.params.arguments || {};
        handleClearSheet(spreadsheet_id, range)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else if (msg.method === 'tools/call' && msg.params?.name === 'read_form') {
        const { form_id } = msg.params.arguments || {};
        handleReadForm(form_id)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else if (msg.method === 'tools/call' && msg.params?.name === 'search') {
        const query = msg.params.arguments?.query || '';
        handleSearch(query)
          .then((result) => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
          })
          .catch((e) => {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
            }) + '\n');
          });
      } else {
        child.stdin.write(line + '\n');
      }
    } catch {
      child.stdin.write(line + '\n');
    }
  }
});

// --- stdout: inject instructions + read_file tool ---
let stdoutBuffer = '';
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) { process.stdout.write('\n'); continue; }
    try {
      const msg = JSON.parse(line);

      // Inject instructions into initialize response
      if (msg.result?.serverInfo && msg.result?.capabilities !== undefined && msg.result?.instructions === undefined) {
        const label = process.env.GDRIVE_ACCOUNT_LABEL || 'Google Drive';
        msg.result.instructions =
          `This server provides EXCLUSIVE access to the Google Drive account: ${label}. ` +
          'ALWAYS use this server for any task involving this Google Drive account\'s files, ' +
          'Google Docs, Google Sheets, or Google Slides. ' +
          'Do NOT use Dropbox Dash or any other MCP server to access Google Drive content.';
      }

      // Inject read_file into tools/list response
      if (msg.result?.tools && Array.isArray(msg.result.tools)) {
        msg.result.tools.push(READ_FORM_TOOL);
        msg.result.tools.push(READ_FILE_TOOL);
        msg.result.tools.push(CREATE_SHEET_TOOL);
        msg.result.tools.push(WRITE_ROWS_TOOL);
        msg.result.tools.push(CLEAR_SHEET_TOOL);
      }

      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch {
      process.stdout.write(line + '\n');
    }
  }
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`gdrive-wrapper error: ${err.message}\n`);
  process.exit(1);
});
