#!/usr/bin/env node
/**
 * Gmail MCP Server
 * Provides read-only access to Gmail via Google Gmail API.
 *
 * Tools:
 *   - list_emails: List recent emails (optionally filtered by query)
 *   - read_email:  Read a specific email by message ID
 *   - search_emails: Search emails using Gmail query syntax
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH;
const CREDS_PATH = process.env.GMAIL_CREDENTIALS_PATH;
const ACCOUNT_LABEL = process.env.GMAIL_ACCOUNT_LABEL || 'Gmail';

// --- Token refresh ---
async function refreshTokenIfNeeded(force = false) {
  if (!CREDS_PATH || !OAUTH_PATH) return;

  let creds, oauth;
  try {
    creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    oauth = JSON.parse(readFileSync(OAUTH_PATH, 'utf8'));
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
      process.stderr.write(`gmail-wrapper: token refresh failed: ${data.error}\n`);
      return;
    }
    const newCreds = {
      access_token: data.access_token,
      refresh_token: creds.refresh_token,
      scope: data.scope || creds.scope,
      token_type: data.token_type || creds.token_type,
      expiry_date: Date.now() + data.expires_in * 1000,
    };
    writeFileSync(CREDS_PATH, JSON.stringify(newCreds, null, 2));
    process.stderr.write(`gmail-wrapper: token refreshed\n`);
  } catch (e) {
    process.stderr.write(`gmail-wrapper: token refresh error: ${e.message}\n`);
  }
}

// --- Gmail API helper ---
function getAccessToken() {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  return creds.access_token;
}

async function gmailGet(path, params = {}) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  let res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
  }
  return res.json();
}

async function gmailPost(path, body) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    res = await doFetch();
  }
  return res.json();
}

// --- Decode base64url ---
function decodeBase64url(str) {
  if (!str) return '';
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// --- Decode base64url to raw bytes (for binary attachments) ---
function decodeBase64urlToBuffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

// --- Collect attachment parts (recursive walk of payload) ---
function collectAttachments(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body?.attachmentId) {
    acc.push({
      partId: payload.partId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
      attachmentId: payload.body.attachmentId,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) collectAttachments(part, acc);
  }
  return acc;
}

// --- Sanitize a filename for safe writing into dest_dir ---
function sanitizeFilename(name) {
  // strip any path components and disallow traversal
  const base = (name || 'attachment').split(/[/\\]/).pop();
  return base.replace(/[\x00-\x1f]/g, '').trim() || 'attachment';
}

// --- Extract email body ---
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }

  // Multipart: prefer text/plain, fallback to text/html
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64url(textPart.body.data);

    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = decodeBase64url(htmlPart.body.data);
      // Strip HTML tags for readability
      return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    // Nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

// --- Header helper ---
function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// --- MIME type detection by extension ---
function getMimeType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return ({
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    zip: 'application/zip',
    json: 'application/json',
  })[ext] || 'application/octet-stream';
}

// --- RFC 2047 encode a string for use in MIME headers ---
function encodeHeaderWord(str) {
  if (!str || !/[^\x00-\x7F]/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

// --- Encode display names in a comma-separated RFC 2822 address field ---
// Splits on top-level commas only (respects quoted strings and angle brackets),
// then RFC-2047-encodes any non-ASCII display name while leaving <email> intact.
function encodeAddressField(field) {
  if (!field || !/[^\x00-\x7F]/.test(field)) return field;
  const addrs = [];
  let cur = '', inQuote = false, inAngle = false;
  for (const ch of field) {
    if      (ch === '"') { inQuote = !inQuote; cur += ch; }
    else if (ch === '<') { inAngle = true;     cur += ch; }
    else if (ch === '>') { inAngle = false;    cur += ch; }
    else if (ch === ',' && !inQuote && !inAngle) { addrs.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  if (cur.trim()) addrs.push(cur.trim());
  return addrs.map(addr => {
    if (!/[^\x00-\x7F]/.test(addr)) return addr;
    // "Quoted Name" <email>
    const qm = addr.match(/^"([^"]+)"\s*(<[^>]+>)$/);
    if (qm) return `${encodeHeaderWord(qm[1])} ${qm[2]}`;
    // Unquoted Name <email>
    const um = addr.match(/^(.+?)\s*(<[^>]+>)$/);
    if (um) return `${encodeHeaderWord(um[1].trim())} ${um[2]}`;
    return encodeHeaderWord(addr);
  }).join(', ');
}

// --- Build RFC 2822 raw message (base64url-encoded) ---
function buildRawMessage({ to, cc, subject, body = '', inReplyTo, references, attachments = [] }) {
  const commonHeaders = [
    `To: ${encodeAddressField(to)}`,
    cc ? `Cc: ${encodeAddressField(cc)}` : null,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean);

  let raw;
  if (attachments.length === 0) {
    const headers = [...commonHeaders, 'Content-Type: text/plain; charset=UTF-8'].join('\r\n');
    raw = `${headers}\r\n\r\n${body}`;
  } else {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const headers = [...commonHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n');

    const parts = [];
    parts.push([
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n'));

    for (const att of attachments) {
      const name = att.filename || att.path.split('/').pop();
      const mimeType = att.mime_type || getMimeType(name);
      const fileData = readFileSync(att.path);
      const b64 = fileData.toString('base64').match(/.{1,76}/g).join('\r\n');
      parts.push([
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${name}"`,
        '',
        b64,
      ].join('\r\n'));
    }

    parts.push(`--${boundary}--`);
    raw = `${headers}\r\n\r\n${parts.join('\r\n')}`;
  }

  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Tool handlers ---
async function handleListEmails(args) {
  const { query, max_results = 20, label_ids } = args || {};
  const params = {
    maxResults: max_results,
    q: query || undefined,
  };
  // Scope rule:
  // - label_ids explicitly provided → use it
  // - query provided (search use case) → no label restriction (search across All Mail, matches Gmail web behavior)
  // - neither → default to INBOX (recent-emails browsing use case)
  if (label_ids !== undefined) {
    params.labelIds = label_ids;
  } else if (!query) {
    params.labelIds = 'INBOX';
  }

  const data = await gmailGet('/messages', params);

  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }

  if (!data.messages || data.messages.length === 0) {
    return { content: [{ type: 'text', text: 'No emails found.' }], isError: false };
  }

  // Fetch metadata for each message
  const details = await Promise.all(
    data.messages.slice(0, max_results).map(m =>
      gmailGet(`/messages/${m.id}`, { format: 'metadata', metadataHeaders: 'Subject,From,Date' })
    )
  );

  const lines = details.map(msg => {
    if (msg.error) return `[Error: ${msg.error.message}]`;
    const subject = getHeader(msg.payload?.headers, 'Subject') || '(no subject)';
    const from = getHeader(msg.payload?.headers, 'From') || '(unknown)';
    const date = getHeader(msg.payload?.headers, 'Date') || '';
    const snippet = msg.snippet ? ` — ${msg.snippet.slice(0, 80)}` : '';
    return `[${msg.id}] ${date}\n  From: ${from}\n  Subject: ${subject}${snippet}`;
  });

  return {
    content: [{ type: 'text', text: `Found ${data.messages.length} email(s) (showing ${details.length}):\n\n${lines.join('\n\n')}` }],
    isError: false,
  };
}

async function handleReadEmail(args) {
  const { message_id } = args || {};
  if (!message_id) {
    return { content: [{ type: 'text', text: 'message_id is required' }], isError: true };
  }

  const msg = await gmailGet(`/messages/${message_id}`, { format: 'full' });

  if (msg.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(msg.error)}` }], isError: true };
  }

  const subject = getHeader(msg.payload?.headers, 'Subject') || '(no subject)';
  const from = getHeader(msg.payload?.headers, 'From') || '(unknown)';
  const to = getHeader(msg.payload?.headers, 'To') || '';
  const date = getHeader(msg.payload?.headers, 'Date') || '';
  const body = extractBody(msg.payload);

  const text = [
    `Subject: ${subject}`,
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${date}`,
    '',
    body || '(no body)',
  ].join('\n');

  return {
    content: [{ type: 'text', text: text }],
    isError: false,
  };
}

async function handleSearchEmails(args) {
  const { query, max_results = 20 } = args || {};
  if (!query) {
    return { content: [{ type: 'text', text: 'query is required' }], isError: true };
  }

  return handleListEmails({ query, max_results });
}

async function handleListAttachments(args) {
  const { message_id } = args || {};
  if (!message_id) {
    return { content: [{ type: 'text', text: 'message_id is required' }], isError: true };
  }

  const msg = await gmailGet(`/messages/${message_id}`, { format: 'full' });
  if (msg.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(msg.error)}` }], isError: true };
  }

  const attachments = collectAttachments(msg.payload);
  if (attachments.length === 0) {
    return { content: [{ type: 'text', text: 'No attachments found.' }], isError: false };
  }

  const lines = attachments.map((a, i) => {
    const kb = a.size != null ? `${Math.round(a.size / 1024)} KB` : '?';
    return [
      `[${i + 1}] ${a.filename}`,
      `  mimeType: ${a.mimeType}`,
      `  size: ${kb} (${a.size} bytes)`,
      `  partId: ${a.partId}`,
      `  attachmentId: ${a.attachmentId}`,
    ].join('\n');
  });

  return {
    content: [{ type: 'text', text: `Found ${attachments.length} attachment(s):\n\n${lines.join('\n\n')}` }],
    isError: false,
  };
}

async function handleDownloadAttachment(args) {
  const { message_id, attachment_id, part_id, dest_dir = '/tmp', filename } = args || {};
  if (!message_id || (!attachment_id && part_id === undefined)) {
    return { content: [{ type: 'text', text: 'message_id and one of attachment_id / part_id are required' }], isError: true };
  }

  // Gmail attachmentIds are NOT stable across requests, so re-fetch the message to
  // resolve a fresh attachmentId + the original filename. partId IS stable and is the
  // preferred locator; attachment_id is best-effort (used directly if no part matches).
  const msg = await gmailGet(`/messages/${message_id}`, { format: 'full' });
  if (msg.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(msg.error)}` }], isError: true };
  }
  const attachments = collectAttachments(msg.payload);

  let target;
  if (part_id !== undefined) {
    target = attachments.find(a => String(a.partId) === String(part_id));
    if (!target) {
      return { content: [{ type: 'text', text: `No attachment with partId "${part_id}" found in this message.` }], isError: true };
    }
  } else {
    // attachment_id path: try exact match first (same-fetch), else single-attachment heuristic
    target = attachments.find(a => a.attachmentId === attachment_id);
    if (!target && attachments.length === 1) target = attachments[0];
  }

  // Prefer the freshly-resolved attachmentId; fall back to the caller-supplied one.
  const dlId = target?.attachmentId || attachment_id;
  if (!dlId) {
    return { content: [{ type: 'text', text: 'Could not resolve an attachmentId. Pass part_id (from list_attachments) for a stable lookup.' }], isError: true };
  }

  const att = await gmailGet(`/messages/${message_id}/attachments/${dlId}`);
  if (att.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(att.error)}` }], isError: true };
  }
  if (!att.data) {
    return { content: [{ type: 'text', text: 'Attachment has no data (empty body).' }], isError: true };
  }

  const outName = sanitizeFilename(filename || target?.filename || `${attachment_id || part_id || 'attachment'}.bin`);
  const buf = decodeBase64urlToBuffer(att.data);
  const outPath = join(dest_dir, outName);
  try {
    writeFileSync(outPath, buf);
  } catch (e) {
    return { content: [{ type: 'text', text: `Failed to write file: ${e.message}` }], isError: true };
  }

  return {
    content: [{ type: 'text', text: `Saved attachment to: ${outPath}\n  ${buf.length} bytes\n\nInspect with: Read (PDF/images) or pandoc (docx → markdown).` }],
    isError: false,
  };
}

async function handleCreateDraft(args) {
  const { to, cc, subject, body = '', reply_all_to, attachments = [] } = args || {};

  // Validate attachment paths before building the message
  for (const att of attachments) {
    try {
      readFileSync(att.path); // existence check
    } catch {
      return { content: [{ type: 'text', text: `Attachment not found: ${att.path}` }], isError: true };
    }
  }

  let messagePayload;
  let threadId;

  if (reply_all_to) {
    const orig = await gmailGet(`/messages/${reply_all_to}`, { format: 'full' });
    if (orig.error) {
      return { content: [{ type: 'text', text: `Error fetching original email: ${JSON.stringify(orig.error)}` }], isError: true };
    }

    const origFrom    = getHeader(orig.payload?.headers, 'From');
    const origTo      = getHeader(orig.payload?.headers, 'To');
    const origCc      = getHeader(orig.payload?.headers, 'Cc');
    const origSubject = getHeader(orig.payload?.headers, 'Subject');
    const origMsgId   = getHeader(orig.payload?.headers, 'Message-ID');
    const origRefs    = getHeader(orig.payload?.headers, 'References');
    threadId = orig.threadId;

    const replyTo      = origFrom;
    const replyCc      = [origTo, origCc].filter(Boolean).join(', ') || undefined;
    const replySubject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    const replyRefs    = [origRefs, origMsgId].filter(Boolean).join(' ');

    const raw = buildRawMessage({
      to: replyTo,
      cc: replyCc,
      subject: replySubject,
      body,
      inReplyTo: origMsgId,
      references: replyRefs,
      attachments,
    });
    messagePayload = threadId ? { raw, threadId } : { raw };
  } else {
    if (!to || !subject) {
      return { content: [{ type: 'text', text: 'to and subject are required when reply_all_to is not set' }], isError: true };
    }
    const raw = buildRawMessage({ to, cc, subject, body, attachments });
    messagePayload = { raw };
  }

  const result = await gmailPost('/drafts', { message: messagePayload });

  if (result.error) {
    return { content: [{ type: 'text', text: `Error creating draft: ${JSON.stringify(result.error)}` }], isError: true };
  }

  const info = [];
  if (reply_all_to) {
    info.push(`Subject: ${result.message?.payload ? getHeader(result.message.payload.headers, 'Subject') : '(see Gmail Drafts)'}`);
  }
  return {
    content: [{ type: 'text', text: `Draft created successfully.\nDraft ID: ${result.id}\n${info.join('\n')}\nOpen Gmail > Drafts to review and send.` }],
    isError: false,
  };
}

// --- MCP tool definitions ---
const TOOLS = [
  {
    name: 'list_emails',
    description: 'List recent emails from Gmail inbox. Optionally filter by Gmail search query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "from:foo@example.com", "subject:meeting", "is:unread"). Optional.' },
        max_results: { type: 'number', description: 'Maximum number of emails to return (default: 20, max: 50)' },
        label_ids: { type: 'string', description: 'Label to filter by (default: INBOX). E.g. INBOX, SENT, UNREAD.' },
      },
    },
  },
  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its message ID.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (obtained from list_emails or search_emails)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails using Gmail query syntax. Returns matching emails with metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query. Supports: from:, to:, subject:, is:unread, after:2024/1/1, etc.' },
        max_results: { type: 'number', description: 'Maximum number of results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_attachments',
    description: 'List attachments of a specific email by message ID. Returns filename, mimeType, size, and attachmentId for each attachment (use download_attachment with the attachmentId to save it).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (obtained from list_emails or search_emails)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'create_draft',
    description: 'Create a Gmail draft, optionally with file attachments. Use reply_all_to to create a Reply All draft (To/CC/Subject/threading headers are auto-populated). Otherwise specify to and subject manually.',
    inputSchema: {
      type: 'object',
      properties: {
        reply_all_to: { type: 'string', description: 'Message ID of the email to Reply All to. When set, To/CC/Subject/In-Reply-To/References are auto-set from the original email.' },
        body: { type: 'string', description: 'Plain text body of the draft.' },
        to: { type: 'string', description: 'Recipient(s), comma-separated. Ignored when reply_all_to is set.' },
        cc: { type: 'string', description: 'CC recipient(s), comma-separated. Optional; ignored when reply_all_to is set (CC comes from original email).' },
        subject: { type: 'string', description: 'Email subject. Ignored when reply_all_to is set (auto-set from original).' },
        attachments: {
          type: 'array',
          description: 'Local files to attach. Each item must have a path (absolute path to the file). filename and mime_type are optional overrides.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute path to the file to attach.' },
              filename: { type: 'string', description: 'Override the attachment filename shown in the email. Optional.' },
              mime_type: { type: 'string', description: 'Override MIME type. Optional; auto-detected from extension (pdf, docx, xlsx, pptx, png, jpg, zip, csv, etc.).' },
            },
            required: ['path'],
          },
        },
      },
    },
  },
  {
    name: 'download_attachment',
    description: 'Download an email attachment to a local file. Pass part_id (preferred) or attachment_id from list_attachments. After saving, inspect with Read (PDF/images) or pandoc (docx → markdown). Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
        part_id: { type: 'string', description: 'Part ID from list_attachments (preferred — stable across requests, unlike attachment_id).' },
        attachment_id: { type: 'string', description: 'Attachment ID from list_attachments. Note: Gmail attachment IDs are ephemeral; part_id is more reliable.' },
        dest_dir: { type: 'string', description: 'Destination directory (default: /tmp)' },
        filename: { type: 'string', description: 'Override the saved filename. Optional — defaults to the attachment\'s original filename.' },
      },
      required: ['message_id'],
    },
  },
];

// --- MCP protocol handler ---
await refreshTokenIfNeeded();

let inputBuffer = '';

process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString();
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(line);
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gmail-private', version: '1.0.0' },
        instructions: `This server provides read and draft-write access to the Gmail account: ${ACCOUNT_LABEL}. Use list_emails to browse inbox, search_emails to find specific emails, and read_email to read full content. Use list_attachments to enumerate an email's attachments and download_attachment to save one locally. Use create_draft to create a new draft or a Reply All draft (reply_all_to=<message_id>) — the draft is saved in Gmail Drafts for the user to review and send.`,
      },
    });
  } else if (msg.method === 'notifications/initialized') {
    // No response needed
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    });
  } else if (msg.method === 'tools/call') {
    let result;
    try {
      await refreshTokenIfNeeded();
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (name === 'list_emails') {
        result = await handleListEmails(args);
      } else if (name === 'read_email') {
        result = await handleReadEmail(args);
      } else if (name === 'search_emails') {
        result = await handleSearchEmails(args);
      } else if (name === 'list_attachments') {
        result = await handleListAttachments(args);
      } else if (name === 'download_attachment') {
        result = await handleDownloadAttachment(args);
      } else if (name === 'create_draft') {
        result = await handleCreateDraft(args);
      } else {
        result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (e) {
      result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
    send({ jsonrpc: '2.0', id: msg.id, result });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    // Unknown method
    if (msg.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  }
}
