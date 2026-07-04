/**
 * Frontend Letta client. All requests go through the Familiar bridge worker
 * so the browser never hits api.letta.com directly (CORS + future auth).
 *
 * The user's Letta API key is sent verbatim as the Authorization header.
 * The bridge forwards it upstream and adds CORS.
 */

import type { LettaAgent, LettaMessage, LettaContentPart, LettaMessageContent } from "../types";

export interface CallOptions {
  bridgeUrl: string;
  lettaKey: string;
  signal?: AbortSignal;
}

async function lettaCall(
  opts: CallOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${opts.bridgeUrl.replace(/\/$/, "")}/letta${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${opts.lettaKey}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers, signal: opts.signal });
  return res;
}

export async function listAgents(opts: CallOptions): Promise<LettaAgent[]> {
  const res = await lettaCall(opts, "/v1/agents/?limit=100&order=desc");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`listAgents failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // Letta sometimes returns { agents: [...] }, sometimes a bare array. Handle both.
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.agents)) return data.agents;
  return [];
}

export async function getMessages(
  opts: CallOptions,
  agentId: string,
  params: { limit?: number; before?: string; conversationId?: string } = {},
): Promise<LettaMessage[]> {
  // Pull newest-first so we always grab the most recent slice (Letta's default
  // returns the *first* N from history if ordering is ambiguous, which is
  // never what we want). We then sort client-side by timestamp to be
  // independent of whatever the API actually does with `order`.
  // When conversationId is set, results are scoped to that conversation only —
  // a 1:1 thread and the same agent's group thread won't bleed into each other.
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit ?? 100));
  qs.set("order", "desc");
  qs.set("order_by", "created_at");
  if (params.before) qs.set("before", params.before);
  // Use the conversation-scoped read endpoint when we have a conv id — it's
  // the canonical scoped surface and pairs symmetrically with the POST route
  // we use for writes. The agent endpoint with `?conversation_id=` also
  // filters reads correctly, but the symmetry avoids future surprises.
  const path = params.conversationId
    ? `/v1/conversations/${params.conversationId}/messages?${qs}`
    : `/v1/agents/${agentId}/messages?${qs}`;
  const res = await lettaCall(opts, path);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`getMessages failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const list: LettaMessage[] = Array.isArray(data)
    ? data
    : data && Array.isArray(data.messages)
      ? data.messages
      : [];
  // Sort ascending by created_at so oldest is at the top, newest at the bottom.
  return [...list].sort((a, b) => {
    const aTime = parseTime(a);
    const bTime = parseTime(b);
    return aTime - bTime;
  });
}

function parseTime(m: LettaMessage): number {
  const raw = m.date ?? m.created_at;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

export interface SendMessageOptions {
  text: string;
  imageDataUrls?: string[]; // optional images to attach as multimodal content
  // Group rooms: when fanning one agent's turn into another agent's history,
  // we tag the input message so it reads (in the recipient's context and in the
  // ADE) as coming from that other participant, not from the human. `name` is
  // the human-readable display name; `senderId` is the source agent's id; `otid`
  // is a stable per-room-message id so re-sends to the same recipient dedupe.
  name?: string;
  senderId?: string;
  otid?: string;
  // Letta conversation id: scopes the message into a specific conversation
  // within the agent. Omit for legacy (single-thread) behaviour.
  conversationId?: string;
  // A short id baked into the user message text as a `[#xxxxxx] ` prefix so
  // the agent can quote it back to us (e.g. via the react_to_message tool).
  // Letta doesn't surface message ids to the model in any other way — they're
  // metadata, not rendered into the context. We strip the prefix from the
  // display side so the user never sees it.
  shortId?: string;
  // Suppress short-id injection for system-style messages — [reaction] notes,
  // [room_turn] decide-prompts, fanned `[Name] …` lines. The agent shouldn't
  // be reacting to those, so they don't need addressable ids.
  skipShortId?: boolean;
}

// Generate a short, agent-legible message id. 6 chars base36 = ~2.1B values,
// astronomical collision odds within a chat window. Kept short so the prefix
// doesn't bloat the agent's context.
export function newShortMessageId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// Regex used both for injection (skip if already prefixed) and extraction.
// `^\[#xxxxxx\]\s` — six base36 chars, followed by a space.
const SHORT_ID_RE = /^\[#([a-z0-9]{4,10})\]\s/;

// Strip the short-id prefix from a string. Returns the unprefixed text and
// the extracted id (if any).
export function extractShortId(text: string): { id: string | null; text: string } {
  const m = text.match(SHORT_ID_RE);
  if (!m) return { id: null, text };
  return { id: m[1], text: text.slice(m[0].length) };
}

// Assemble the per-message object Letta expects, attaching the optional
// participant-tagging fields only when present (so 1:1 sends are unchanged).
function buildMessageObject(content: LettaMessageContent, opts: SendMessageOptions): Record<string, unknown> {
  const m: Record<string, unknown> = { role: "user", content };
  if (opts.name) m.name = opts.name;
  if (opts.senderId) m.sender_id = opts.senderId;
  if (opts.otid) m.otid = opts.otid;
  return m;
}

// Parse a `data:image/jpeg;base64,XXX` URL into its parts. Returns null if
// the input isn't a data URL.
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = url.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/);
  if (!m) return null;
  return { mediaType: m[1] || "image/jpeg", data: m[2] };
}

function buildMessageContent(opts: SendMessageOptions): LettaMessageContent {
  // Inject the short-id prefix into the user-facing text so the agent can see
  // it. Skipped for system-style messages (room_turn, reaction notes, etc.)
  // and any caller that's already pre-prefixed (e.g. fanned `[Name] …` lines).
  const shouldPrefix =
    !opts.skipShortId && opts.shortId && opts.text && !SHORT_ID_RE.test(opts.text);
  const text = shouldPrefix ? `[#${opts.shortId}] ${opts.text}` : opts.text;
  const images = opts.imageDataUrls ?? [];
  if (images.length === 0) return text;
  const parts: LettaContentPart[] = [];
  for (const url of images) {
    const parsed = parseDataUrl(url);
    if (parsed) {
      // Inline (base64) image — sourced from a file upload or camera.
      parts.push({
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
      });
    } else {
      // Public HTTPS URL — sourced from a GIF picker, etc. Letta fetches it.
      parts.push({ type: "image", source: { type: "url", url } });
    }
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

export async function sendMessage(
  opts: CallOptions,
  agentId: string,
  payload: string | SendMessageOptions,
): Promise<LettaMessage[]> {
  const sendOpts: SendMessageOptions =
    typeof payload === "string" ? { text: payload } : payload;
  const content = buildMessageContent(sendOpts);
  const body: Record<string, unknown> = {
    messages: [buildMessageObject(content, sendOpts)],
    // Cap tool iterations per turn so a confused agent can't infinite-loop
    // itself into a 524 timeout. 8 is enough for legitimate multi-tool work
    // (status check → memory lookup → reply) but bails before edge timeout.
    max_steps: 8,
  };
  // IMPORTANT: to actually SCOPE a write to a conversation, POST must go to
  // `/v1/conversations/{convId}/messages`. The agent endpoint accepts
  // `conversation_id` in the body/query but silently writes to the default
  // thread — that's a Letta surprise we hit during isolation testing.
  const path = sendOpts.conversationId
    ? `/v1/conversations/${sendOpts.conversationId}/messages`
    : `/v1/agents/${agentId}/messages`;
  const res = await lettaCall(opts, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data && Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Stream a message turn from Letta. Yields each LettaMessage as it arrives
 * (tool_call_message, tool_return_message, reasoning_message, assistant_message,
 * usage_statistics, etc.). The connection stays alive between events so we
 * never trip Cloudflare's 100s edge timeout — even on tool-heavy turns.
 *
 * The bridge proxies the SSE stream end-to-end without buffering.
 */
export async function* streamMessage(
  opts: CallOptions,
  agentId: string,
  payload: string | SendMessageOptions,
): AsyncGenerator<LettaMessage, void, void> {
  const sendOpts: SendMessageOptions =
    typeof payload === "string" ? { text: payload } : payload;
  const content = buildMessageContent(sendOpts);
  // Route via the conversation endpoint when scoped — agent endpoint silently
  // writes to the default thread regardless of conversation_id field. See note
  // in sendMessage above.
  const path = sendOpts.conversationId
    ? `/letta/v1/conversations/${sendOpts.conversationId}/messages`
    : `/letta/v1/agents/${agentId}/messages`;
  const url = `${opts.bridgeUrl.replace(/\/$/, "")}${path}`;
  const body: Record<string, unknown> = {
    messages: [buildMessageObject(content, sendOpts)],
    streaming: true,
    max_steps: 8,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.lettaKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  yield* readTurnResponse(res, "streamMessage");
}

/**
 * Send a pre-built array of messages to an agent in a single turn and stream
 * the response. Used for group rooms: we hand an agent the new room messages
 * (each `name`-tagged with who said it) plus a `[room_turn]` decide-prompt all
 * in one POST, so they land cleanly in the agent's history and the agent runs
 * exactly once. Reads `tool_call_message` events too, so the caller can pull the
 * `room_turn` arguments off the stream.
 */
export async function* streamTurn(
  opts: CallOptions,
  agentId: string,
  messages: Array<Record<string, unknown>>,
  extra?: { conversationId?: string },
): AsyncGenerator<LettaMessage, void, void> {
  // Same routing rule as streamMessage — conversation endpoint when scoped,
  // agent endpoint when not. The agent endpoint silently un-scopes writes.
  const path = extra?.conversationId
    ? `/letta/v1/conversations/${extra.conversationId}/messages`
    : `/letta/v1/agents/${agentId}/messages`;
  const url = `${opts.bridgeUrl.replace(/\/$/, "")}${path}`;
  const body: Record<string, unknown> = { messages, streaming: true, max_steps: 8 };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.lettaKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`streamTurn failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  yield* readTurnResponse(res, "streamTurn");
}

// Parse a Letta turn response — SSE if the server honoured `streaming:true`,
// otherwise a plain JSON array (fallback). Yields each LettaMessage as it lands.
async function* readTurnResponse(res: Response, label: string): AsyncGenerator<LettaMessage, void, void> {
  const ct = res.headers.get("Content-Type") ?? "";
  if (!ct.includes("text/event-stream")) {
    if (!res.body) throw new Error(`${label}: empty response body`);
    const data = await res.json();
    const list: LettaMessage[] =
      data && Array.isArray(data.messages) ? data.messages : Array.isArray(data) ? data : [];
    for (const m of list) yield m;
    return;
  }
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      // SSE events are separated by blank lines (\n\n).
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        // Each event may have multiple `data:` lines; concatenate them.
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        if (dataStr === "[DONE]") return;
        try {
          const parsed = JSON.parse(dataStr) as LettaMessage;
          yield parsed;
        } catch {
          // Skip malformed events (keep-alives etc.).
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }
}

// Pull the parsed arguments out of a tool_call_message. Letta hands `arguments`
// as either an object or a JSON string — normalise to an object (or {} on junk).
export function toolCallArgs(m: LettaMessage): Record<string, unknown> {
  const raw = m.tool_call?.arguments;
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── MCP server registration (used during agent setup) ────────────────────────

export interface LettaMcpServer {
  id: string;
  server_name: string;
}

export interface LettaTool {
  id: string;
  name?: string;
}

// Note: Letta uses /v1/mcp-servers/ (hyphen), NOT /v1/mcp_servers (underscore).
// Earlier docs/SDK examples were inconsistent on this; the hyphenated form is
// the current canonical endpoint.
const MCP_PATH = "/v1/mcp-servers";

export async function listMcpServers(opts: CallOptions): Promise<LettaMcpServer[]> {
  const res = await lettaCall(opts, `${MCP_PATH}/`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`listMcpServers failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.servers)) return data.servers;
  return [];
}

export async function registerMcpServer(
  opts: CallOptions,
  serverName: string,
  serverUrl: string,
): Promise<LettaMcpServer> {
  const res = await lettaCall(opts, `${MCP_PATH}/`, {
    method: "POST",
    body: JSON.stringify({
      server_name: serverName,
      config: {
        mcp_server_type: "streamable_http",
        server_url: serverUrl,
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`registerMcpServer failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return (await res.json()) as LettaMcpServer;
}

export async function listMcpTools(opts: CallOptions, mcpServerId: string): Promise<LettaTool[]> {
  const res = await lettaCall(opts, `${MCP_PATH}/${mcpServerId}/tools`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`listMcpTools failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.tools)) return data.tools;
  return [];
}

// Force Letta to re-read the MCP server's tools/list (picking up tools we've
// added and description changes since the server was first registered). Without
// this, listMcpTools returns Letta's cached set from registration time.
// PATCH /v1/mcp-servers/{id}/refresh. 404 = older Letta without the endpoint —
// treat as non-fatal (the caller still lists+attaches whatever it can).
export async function refreshMcpServer(opts: CallOptions, mcpServerId: string): Promise<void> {
  const res = await lettaCall(opts, `${MCP_PATH}/${mcpServerId}/refresh`, { method: "PATCH" });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => "");
    throw new Error(`refreshMcpServer failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

// ─── Core memory blocks ───────────────────────────────────────────────────────

export interface LettaBlock {
  id: string;
  label: string;
  value: string;
}

export async function getAgentBlocks(opts: CallOptions, agentId: string): Promise<LettaBlock[]> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}/core-memory/blocks`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`getAgentBlocks failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.blocks)) return data.blocks;
  return [];
}

// Idempotent: if the labelled block exists, update its value; else create the
// block (POST /v1/blocks/) and attach it to the agent (PATCH
// /v1/agents/{id}/core-memory/blocks/attach/{block_id}). Used to maintain a
// custom block the agent always sees in core memory (e.g. user_state).
export async function ensureBlock(
  opts: CallOptions,
  agentId: string,
  label: string,
  value: string,
  description?: string,
): Promise<LettaBlock> {
  // 1. Check if the agent already has this labelled block.
  const blocks = await getAgentBlocks(opts, agentId);
  const found = blocks.find((b) => b.label === label);
  if (found) {
    if (found.value !== value) {
      const patchRes = await lettaCall(opts, `/v1/blocks/${found.id}`, {
        method: "PATCH",
        body: JSON.stringify({ value }),
      });
      if (!patchRes.ok) {
        const t = await patchRes.text().catch(() => "");
        throw new Error(`update block failed (${patchRes.status}): ${t.slice(0, 200)}`);
      }
    }
    return { ...found, value };
  }
  // 2. Create the block standalone.
  const createBody: Record<string, unknown> = { label, value };
  if (description) createBody.description = description;
  const createRes = await lettaCall(opts, `/v1/blocks/`, {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => "");
    throw new Error(`create block failed (${createRes.status}): ${t.slice(0, 200)}`);
  }
  const created = (await createRes.json()) as LettaBlock;
  // 3. Attach the new block to the agent.
  const attachRes = await lettaCall(
    opts,
    `/v1/agents/${agentId}/core-memory/blocks/attach/${created.id}`,
    { method: "PATCH" },
  );
  if (!attachRes.ok) {
    const t = await attachRes.text().catch(() => "");
    throw new Error(`attach block failed (${attachRes.status}): ${t.slice(0, 200)}`);
  }
  return created;
}

// ─── Agent system instructions ────────────────────────────────────────────────

export interface LettaAgentDetail {
  id: string;
  name: string;
  system?: string;
  tool_ids?: string[];
}

export async function getAgent(opts: CallOptions, agentId: string): Promise<LettaAgentDetail> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`getAgent failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as LettaAgentDetail;
}

export async function updateAgentSystem(
  opts: CallOptions,
  agentId: string,
  system: string,
): Promise<void> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify({ system }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`updateAgentSystem failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

// Attaches each tool via Letta's dedicated per-tool endpoint
// (PATCH /v1/agents/{id}/tools/attach/{tool_id}). Idempotent on the server
// side — already-attached tools return 200 or 409, both safe to ignore.
export async function attachToolsToAgent(
  opts: CallOptions,
  agentId: string,
  toolIds: string[],
): Promise<void> {
  for (const toolId of toolIds) {
    if (!toolId) continue;
    const res = await lettaCall(opts, `/v1/agents/${agentId}/tools/attach/${toolId}`, {
      method: "PATCH",
    });
    if (res.ok) continue;
    const errText = await res.text().catch(() => "");
    // Already attached → fine, move on.
    if (res.status === 409 || errText.toLowerCase().includes("already")) continue;
    throw new Error(`attach tool ${toolId} failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

// ─── Conversations (native Letta conversation_id scoping) ────────────────────
// One Letta conversation = one scoped message history *within* an agent. The
// agent's identity/memory blocks (persona, user_state, human) stay shared
// across all of its conversations — so identity continuity is automatic and
// privacy boundaries between e.g. a 1:1 chat and a group room are automatic.
// Spike-verified 2026-05-13 against live Letta API.

export interface LettaConversation {
  id: string;
  agent_id: string;
  summary?: string | null;
  in_context_message_ids?: string[] | null;
  model?: string | null;
  model_settings?: unknown;
  context_window_limit?: number | null;
  created_at?: string;
  updated_at?: string;
}

// Create a fresh conversation on an agent. agent_id MUST be a query param,
// not a body field — the API 422s on the body form. Body is optional.
export async function createConversation(
  opts: CallOptions,
  agentId: string,
): Promise<LettaConversation> {
  const res = await lettaCall(opts, `/v1/conversations?agent_id=${agentId}`, {
    method: "POST",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`createConversation failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return (await res.json()) as LettaConversation;
}

// List every conversation on the account. Useful for orphan sweeps and for
// reconciling local state with server-side reality (e.g. user deleted a
// conversation via the ADE).
export async function listConversations(opts: CallOptions): Promise<LettaConversation[]> {
  const res = await lettaCall(opts, "/v1/conversations");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`listConversations failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  return [];
}

export async function deleteConversation(
  opts: CallOptions,
  conversationId: string,
): Promise<void> {
  const res = await lettaCall(opts, `/v1/conversations/${conversationId}`, {
    method: "DELETE",
  });
  // 404 = already gone, treat as success.
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => "");
    throw new Error(`deleteConversation failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

// ─── Scheduled messages (Letta cron) ──────────────────────────────────────────

export interface LettaSchedule {
  id: string;
  cron_expression?: string;
  scheduled_at?: number;
  type?: "recurring" | "one_time";
  messages?: Array<{ role: string; content: string }>;
}

export async function listSchedules(opts: CallOptions, agentId: string): Promise<LettaSchedule[]> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}/schedule`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`listSchedules failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.schedules)) return data.schedules;
  return [];
}

export async function createRecurringSchedule(
  opts: CallOptions,
  agentId: string,
  cronExpression: string,
  content: string,
): Promise<LettaSchedule> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}/schedule`, {
    method: "POST",
    body: JSON.stringify({
      schedule: { type: "recurring", cron_expression: cronExpression },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`createRecurringSchedule failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return (await res.json()) as LettaSchedule;
}

export async function deleteSchedule(
  opts: CallOptions,
  agentId: string,
  scheduleId: string,
): Promise<void> {
  const res = await lettaCall(opts, `/v1/agents/${agentId}/schedule/${scheduleId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => "");
    throw new Error(`deleteSchedule failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function extractText(msg: LettaMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if ((part as { type?: string }).type === "text") {
          return (part as { text?: string }).text ?? "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof msg.text === "string") return msg.text;
  return "";
}

// Pull image URLs out of a multimodal message's content array. Reconstructs
// data: URLs from base64-source parts so the bubble can render them.
export function extractImageUrls(msg: LettaMessage): string[] {
  const out: string[] = [];
  if (!Array.isArray(msg.content)) return out;
  for (const part of msg.content) {
    if (typeof part === "string") continue;
    const p = part as { type?: string; source?: { type?: string; url?: string; data?: string; media_type?: string }; image_url?: { url?: string } };
    if (p.type === "image" && p.source) {
      if (p.source.type === "url" && p.source.url) {
        out.push(p.source.url);
      } else if (p.source.type === "base64" && p.source.data) {
        const mt = p.source.media_type || "image/jpeg";
        out.push(`data:${mt};base64,${p.source.data}`);
      }
    }
    // Legacy OpenAI-style fallback in case anything older still renders.
    if (p.type === "image_url" && p.image_url?.url) {
      out.push(p.image_url.url);
    }
  }
  return out;
}
