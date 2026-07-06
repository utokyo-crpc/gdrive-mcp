#!/usr/bin/env node
/**
 * Google Calendar MCP Server (read-only)
 *
 * Tools:
 *   - list_events:   List upcoming or time-ranged events (compact one-line format)
 *   - read_event:    Read full details of a single event
 *   - search_events: Search events by free-text query
 *   - list_calendars: List the user's calendars (id + summary)
 */
import { readFileSync, writeFileSync } from 'fs';

const OAUTH_PATH = process.env.GCAL_OAUTH_PATH;
const CREDS_PATH = process.env.GCAL_CREDENTIALS_PATH;
const ACCOUNT_LABEL = process.env.GCAL_ACCOUNT_LABEL || 'Google Calendar';

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
      process.stderr.write(`gcalendar-wrapper: token refresh failed: ${data.error}\n`);
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
    process.stderr.write(`gcalendar-wrapper: token refreshed\n`);
  } catch (e) {
    process.stderr.write(`gcalendar-wrapper: token refresh error: ${e.message}\n`);
  }
}

function getAccessToken() {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  return creds.access_token;
}

async function calGet(path, params = {}) {
  const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
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

async function calPost(path, body) {
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  let res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return res.json();
}

async function calPatch(path, body) {
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  let res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return res.json();
}

async function calDelete(path) {
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  let res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  if (res.status === 401) {
    await refreshTokenIfNeeded(true);
    res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getAccessToken()}` },
    });
  }
  return res.status;
}

// --- Formatting helpers ---
function fmtTime(t) {
  // t is { dateTime: "...", date: "..." } from Calendar API
  if (!t) return '';
  if (t.dateTime) {
    // Format: 2026-05-26T14:00:00+09:00 → 2026-05-26 14:00 JST-ish
    const d = new Date(t.dateTime);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
  if (t.date) return `${t.date} (all-day)`;
  return '';
}

function formatEventLine(ev) {
  const start = fmtTime(ev.start);
  const summary = ev.summary || '(no title)';
  const loc = ev.location ? ` @ ${ev.location}` : '';
  return `[${ev.id}] ${start}  ${summary}${loc}`;
}

// --- Tool handlers ---
async function handleListEvents(args) {
  const {
    calendar_id = 'primary',
    time_min,
    time_max,
    max_results = 20,
    query,
  } = args || {};

  const now = new Date().toISOString();
  const params = {
    maxResults: Math.min(max_results, 50),
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: time_min || now,
    timeMax: time_max,
    q: query,
  };

  const data = await calGet(`/calendars/${encodeURIComponent(calendar_id)}/events`, params);

  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }

  const items = data.items || [];
  if (items.length === 0) {
    return { content: [{ type: 'text', text: 'No events found.' }], isError: false };
  }

  const lines = items.map(formatEventLine);
  return {
    content: [{ type: 'text', text: `Found ${items.length} event(s) in calendar "${calendar_id}":\n\n${lines.join('\n')}` }],
    isError: false,
  };
}

async function handleReadEvent(args) {
  const { event_id, calendar_id = 'primary' } = args || {};
  if (!event_id) {
    return { content: [{ type: 'text', text: 'event_id is required' }], isError: true };
  }

  const ev = await calGet(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`);
  if (ev.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(ev.error)}` }], isError: true };
  }

  const attendees = (ev.attendees || [])
    .map(a => `  - ${a.displayName || a.email}${a.responseStatus ? ` (${a.responseStatus})` : ''}`)
    .join('\n');

  const lines = [
    `Title: ${ev.summary || '(no title)'}`,
    `Start: ${fmtTime(ev.start)}`,
    `End: ${fmtTime(ev.end)}`,
    ev.location ? `Location: ${ev.location}` : null,
    ev.organizer ? `Organizer: ${ev.organizer.displayName || ev.organizer.email}` : null,
    ev.hangoutLink ? `Meet: ${ev.hangoutLink}` : null,
    ev.status ? `Status: ${ev.status}` : null,
    attendees ? `Attendees:\n${attendees}` : null,
    '',
    ev.description ? `Description:\n${ev.description}` : '(no description)',
  ].filter(Boolean);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: false,
  };
}

async function handleSearchEvents(args) {
  const { query, max_results = 20, calendar_id = 'primary', time_min, time_max } = args || {};
  if (!query) {
    return { content: [{ type: 'text', text: 'query is required' }], isError: true };
  }
  return handleListEvents({ query, max_results, calendar_id, time_min, time_max });
}

async function handleCreateEvent(args) {
  const { calendar_id = 'primary', summary, start, end, description, location, attendees, timezone } = args || {};
  if (!summary || !start || !end) {
    return { content: [{ type: 'text', text: 'summary, start, and end are required' }], isError: true };
  }

  const tz = timezone || 'Asia/Tokyo';
  const body = {
    summary,
    ...(description && { description }),
    ...(location && { location }),
    start: start.includes('T') ? { dateTime: start, timeZone: tz } : { date: start },
    end: end.includes('T') ? { dateTime: end, timeZone: tz } : { date: end },
    ...(attendees && { attendees: attendees.map(email => ({ email })) }),
  };

  const ev = await calPost(`/calendars/${encodeURIComponent(calendar_id)}/events`, body);
  if (ev.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(ev.error)}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Created: [${ev.id}] ${fmtTime(ev.start)}  ${ev.summary}` }],
    isError: false,
  };
}

async function handleUpdateEvent(args) {
  const { event_id, calendar_id = 'primary', summary, start, end, description, location, attendees, timezone } = args || {};
  if (!event_id) {
    return { content: [{ type: 'text', text: 'event_id is required' }], isError: true };
  }

  const tz = timezone || 'Asia/Tokyo';
  const body = {};
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;
  if (start !== undefined) body.start = start.includes('T') ? { dateTime: start, timeZone: tz } : { date: start };
  if (end !== undefined) body.end = end.includes('T') ? { dateTime: end, timeZone: tz } : { date: end };
  if (attendees !== undefined) body.attendees = attendees.map(email => ({ email }));

  const ev = await calPatch(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`, body);
  if (ev.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(ev.error)}` }], isError: true };
  }
  return {
    content: [{ type: 'text', text: `Updated: [${ev.id}] ${fmtTime(ev.start)}  ${ev.summary}` }],
    isError: false,
  };
}

async function handleDeleteEvent(args) {
  const { event_id, calendar_id = 'primary' } = args || {};
  if (!event_id) {
    return { content: [{ type: 'text', text: 'event_id is required' }], isError: true };
  }

  const status = await calDelete(`/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(event_id)}`);
  if (status === 204 || status === 200) {
    return { content: [{ type: 'text', text: `Deleted event: ${event_id}` }], isError: false };
  }
  return { content: [{ type: 'text', text: `Delete failed with HTTP ${status}` }], isError: true };
}

async function handleListCalendars() {
  const data = await calGet('/users/me/calendarList', { maxResults: 100 });
  if (data.error) {
    return { content: [{ type: 'text', text: `Error: ${JSON.stringify(data.error)}` }], isError: true };
  }
  const items = data.items || [];
  if (items.length === 0) {
    return { content: [{ type: 'text', text: 'No calendars found.' }], isError: false };
  }
  const lines = items.map(c => `[${c.id}] ${c.summary || ''}${c.primary ? ' (primary)' : ''}`);
  return {
    content: [{ type: 'text', text: `Found ${items.length} calendar(s):\n\n${lines.join('\n')}` }],
    isError: false,
  };
}

// --- MCP tool definitions ---
const TOOLS = [
  {
    name: 'list_events',
    description: 'List upcoming events from a Google Calendar (defaults to primary calendar, future events). Returns compact one-line entries.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary"). Use list_calendars to discover IDs.' },
        time_min: { type: 'string', description: 'RFC3339 start time (default: now). E.g. "2026-05-26T00:00:00+09:00".' },
        time_max: { type: 'string', description: 'RFC3339 end time. Optional.' },
        max_results: { type: 'number', description: 'Maximum events to return (default: 20, max: 50).' },
        query: { type: 'string', description: 'Free-text search filter. Optional.' },
      },
    },
  },
  {
    name: 'read_event',
    description: 'Read full details of a specific event including attendees, description, location.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event ID (from list_events output).' },
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary").' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'search_events',
    description: 'Search events by free-text query across summary, description, location, attendees.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        max_results: { type: 'number', description: 'Maximum results (default: 20).' },
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary").' },
        time_min: { type: 'string', description: 'RFC3339 start time. Optional.' },
        time_max: { type: 'string', description: 'RFC3339 end time. Optional.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_calendars',
    description: 'List all calendars the user has access to (with IDs needed for other tools).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_event',
    description: 'Create a new event in a Google Calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title (required).' },
        start: { type: 'string', description: 'Start time as RFC3339 (e.g. "2026-06-20T10:00:00+09:00") or date ("2026-06-20" for all-day).' },
        end: { type: 'string', description: 'End time as RFC3339 or date.' },
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary").' },
        description: { type: 'string', description: 'Event description/notes. Optional.' },
        location: { type: 'string', description: 'Location string. Optional.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses. Optional.' },
        timezone: { type: 'string', description: 'IANA timezone (default: "Asia/Tokyo").' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'update_event',
    description: 'Update fields of an existing calendar event (partial update — only specified fields are changed).',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event ID (from list_events / read_event output).' },
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary").' },
        summary: { type: 'string', description: 'New title. Optional.' },
        start: { type: 'string', description: 'New start time (RFC3339 or date). Optional.' },
        end: { type: 'string', description: 'New end time (RFC3339 or date). Optional.' },
        description: { type: 'string', description: 'New description. Optional.' },
        location: { type: 'string', description: 'New location. Optional.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'New attendee list (replaces existing). Optional.' },
        timezone: { type: 'string', description: 'IANA timezone for start/end (default: "Asia/Tokyo").' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete (cancel) a calendar event permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event ID to delete.' },
        calendar_id: { type: 'string', description: 'Calendar ID (default: "primary").' },
      },
      required: ['event_id'],
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
        serverInfo: { name: 'gcalendar', version: '1.0.0' },
        instructions: `This server provides read-write access to Google Calendar for: ${ACCOUNT_LABEL}. Use list_events for upcoming items, search_events to find specific entries, read_event for full details, list_calendars to discover non-primary calendar IDs, create_event to add new events, update_event to modify existing events, and delete_event to remove events.`,
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
      if (name === 'list_events') {
        result = await handleListEvents(args);
      } else if (name === 'read_event') {
        result = await handleReadEvent(args);
      } else if (name === 'search_events') {
        result = await handleSearchEvents(args);
      } else if (name === 'list_calendars') {
        result = await handleListCalendars();
      } else if (name === 'create_event') {
        result = await handleCreateEvent(args);
      } else if (name === 'update_event') {
        result = await handleUpdateEvent(args);
      } else if (name === 'delete_event') {
        result = await handleDeleteEvent(args);
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
    if (msg.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  }
}
