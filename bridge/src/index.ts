/**
 * Familiar bridge worker.
 *
 * Endpoints:
 *   GET  /health                          → liveness check
 *   ANY  /letta/*                         → CORS-bypass proxy to api.letta.com
 *   POST /api/agents/:agentId/init        → first-time setup, returns client_token + mcp_url
 *   GET  /api/agents/:agentId/state       → app reads current chat_state (auth: client_token)
 *   POST /api/agents/:agentId/state       → app writes user side of state (auth: client_token)
 *   POST /mcp/:secret                     → JSON-RPC MCP server for Letta agent (auth: URL secret)
 */

import { handleMcp } from "./mcp";
import * as db from "./db";

export interface Env {
  DB: D1Database;
  // Absent when the Cloudflare account has R2 disabled (the deploy CLI strips
  // the binding). Voice notes are unavailable on such deployments.
  AUDIO?: R2Bucket;
}

const LETTA_BASE = "https://api.letta.com";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/health") {
        return jsonResponse({ ok: true, service: "familiar-bridge", version: "0.0.2" });
      }

      // Letta API proxy (existing).
      if (path.startsWith("/letta/")) {
        return proxyToLetta(request, url);
      }

      // MCP server endpoint — Letta agent calls this.
      const mcpMatch = path.match(/^\/mcp\/([^/]+)\/?$/);
      if (mcpMatch) {
        return handleMcp(request, env, mcpMatch[1]);
      }

      // App-facing state API.
      const initMatch = path.match(/^\/api\/agents\/([^/]+)\/init$/);
      if (initMatch && request.method === "POST") {
        return handleInit(request, env, initMatch[1], url);
      }
      const stateMatch = path.match(/^\/api\/agents\/([^/]+)\/state$/);
      if (stateMatch) {
        if (request.method === "GET") return handleGetState(request, env, stateMatch[1]);
        if (request.method === "POST") return handlePostState(request, env, stateMatch[1]);
      }

      const elevenlabsMatch = path.match(/^\/api\/agents\/([^/]+)\/elevenlabs$/);
      if (elevenlabsMatch) {
        if (request.method === "GET") return handleGetElevenlabs(request, env, elevenlabsMatch[1]);
        if (request.method === "POST") return handlePostElevenlabs(request, env, elevenlabsMatch[1]);
      }

      const klipyMatch = path.match(/^\/api\/agents\/([^/]+)\/klipy$/);
      if (klipyMatch) {
        if (request.method === "GET") return handleGetKlipy(request, env, klipyMatch[1]);
        if (request.method === "POST") return handlePostKlipy(request, env, klipyMatch[1]);
      }

      const gifSearchMatch = path.match(/^\/api\/agents\/([^/]+)\/gif\/search$/);
      if (gifSearchMatch && request.method === "GET") {
        return handleGifSearch(request, env, gifSearchMatch[1]);
      }

      const mediaListMatch = path.match(/^\/api\/agents\/([^/]+)\/media\/messages$/);
      if (mediaListMatch && request.method === "GET") {
        return handleGetMediaMessages(request, env, mediaListMatch[1]);
      }

      const reactionsMatch = path.match(/^\/api\/agents\/([^/]+)\/reactions$/);
      if (reactionsMatch && request.method === "GET") {
        return handleListReactions(request, env, reactionsMatch[1]);
      }
      const reactionToggleMatch = path.match(/^\/api\/agents\/([^/]+)\/reactions\/toggle$/);
      if (reactionToggleMatch && request.method === "POST") {
        return handleToggleReaction(request, env, reactionToggleMatch[1]);
      }

      // Public audio playback — random ID in URL acts as the auth token.
      // No client_token required so <audio> tag can hit it directly.
      const audioFileMatch = path.match(/^\/audio\/([^/]+)$/);
      if (audioFileMatch && request.method === "GET") {
        return handleGetAudioFile(env, audioFileMatch[1]);
      }

      return jsonResponse({ error: "not_found", path }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("bridge error", msg);
      return jsonResponse({ error: "internal", message: msg }, 500);
    }
  },
};

// ─── Letta proxy ──────────────────────────────────────────────────────────────

async function proxyToLetta(request: Request, url: URL): Promise<Response> {
  const upstreamPath = url.pathname.replace(/^\/letta/, "");
  const upstreamUrl = `${LETTA_BASE}${upstreamPath}${url.search}`;

  const auth = request.headers.get("Authorization");
  if (!auth) {
    return jsonResponse(
      { error: "missing_auth", message: "Authorization: Bearer <letta-key> required" },
      401,
    );
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("Authorization", auth);
  const ct = request.headers.get("Content-Type");
  if (ct) upstreamHeaders.set("Content-Type", ct);
  const accept = request.headers.get("Accept");
  if (accept) upstreamHeaders.set("Accept", accept);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body: hasBody ? request.body : undefined,
  });

  const out = new Headers();
  upstream.headers.forEach((v, k) => out.set(k, v));
  for (const [k, v] of Object.entries(corsHeaders())) out.set(k, v);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

// ─── App state API ────────────────────────────────────────────────────────────

async function handleInit(request: Request, env: Env, agentId: string, url: URL): Promise<Response> {
  const existing = await db.getStateByAgent(env, agentId);
  if (existing) {
    // Idempotent — return existing tokens so re-init doesn't break a working agent.
    return jsonResponse({
      ok: true,
      agent_id: agentId,
      client_token: existing.client_token,
      mcp_secret: existing.mcp_secret,
      mcp_url: buildMcpUrl(url, existing.mcp_secret),
    });
  }
  const clientToken = randomToken();
  const mcpSecret = randomToken();
  await db.insertInitialState(env, {
    agent_id: agentId,
    client_token: clientToken,
    mcp_secret: mcpSecret,
  });
  return jsonResponse({
    ok: true,
    agent_id: agentId,
    client_token: clientToken,
    mcp_secret: mcpSecret,
    mcp_url: buildMcpUrl(url, mcpSecret),
  });
}

async function handleGetState(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return jsonResponse({
    user: extractUserPublic(row),
    agent: extractAgentPublic(row),
    updated_at: row.updated_at,
  });
}

async function handlePostState(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  await db.updateUserState(env, agentId, {
    text: typeof body.user_status_text === "string" ? body.user_status_text : null,
    emoji: typeof body.user_status_emoji === "string" ? body.user_status_emoji : null,
    presence: typeof body.user_presence === "string" ? body.user_presence : null,
  });
  const updated = await db.getStateByAgent(env, agentId);
  return jsonResponse({
    user: updated ? extractUserPublic(updated) : null,
    agent: updated ? extractAgentPublic(updated) : null,
    updated_at: updated?.updated_at,
  });
}

async function handleListReactions(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const rows = await db.listRecentReactions(env, agentId, 500);
  return jsonResponse({
    reactions: rows.map((r) => ({
      message_id: r.message_id,
      emoji: r.emoji,
      reactor: r.reactor,
      created_at: r.created_at,
    })),
  });
}

async function handleToggleReaction(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = typeof body.message_id === "string" ? body.message_id : "";
  const emoji = typeof body.emoji === "string" ? body.emoji : "";
  const reactor = typeof body.reactor === "string" && body.reactor ? body.reactor : "user";
  if (!messageId || !emoji) {
    return jsonResponse({ error: "bad_request", message: "message_id and emoji required" }, 400);
  }
  // Light sanity caps so a misbehaving client can't stuff giant strings in.
  if (messageId.length > 256 || emoji.length > 32) {
    return jsonResponse({ error: "bad_request", message: "message_id or emoji too long" }, 400);
  }
  const result = await db.toggleReaction(env, { agentId, messageId, emoji, reactor });
  return jsonResponse({ ok: true, state: result });
}

async function handleGetMediaMessages(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  // Recent agent-pushed media (voice notes + GIFs) — not just "undelivered".
  // The app dedupes by id, so re-fetching is idempotent, and a reload always
  // rebuilds the bubbles instead of losing any whose delivery the UI missed.
  const messages = await db.listRecentMediaMessages(env, agentId, 40);
  const url = new URL(request.url);
  return jsonResponse({
    messages: messages.map((m) => {
      const base = {
        id: m.id,
        kind: m.kind,
        text: m.text,
        created_at: m.created_at,
      };
      if (m.kind === "gif") {
        return { ...base, gif_url: m.url ?? "" };
      }
      return {
        ...base,
        audio_url: `${url.origin}/audio/${m.id}`,
        emotion: m.emotion,
        duration_ms: m.duration_ms,
      };
    }),
  });
}

async function handleGetAudioFile(env: Env, audioId: string): Promise<Response> {
  const row = await db.getMediaMessage(env, audioId);
  if (!row || row.kind !== "audio" || !row.storage_key) {
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (!env.AUDIO) {
    return jsonResponse({ error: "audio_storage_unavailable" }, 503);
  }
  const obj = await env.AUDIO.get(row.storage_key);
  if (!obj) {
    return jsonResponse({ error: "audio_missing" }, 404);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
    },
  });
}

// ─── KLIPY (GIF) ──────────────────────────────────────────────────────────────
// Tenor's API shut down to new clients (2026-01, full EOL 2026-06-30); KLIPY is
// the drop-in successor. Key is BYO per-agent and goes in the request *path*
// (api/v1/{app_key}/...), so the bridge keeps it server-side and never exposes
// it to the browser.

// Built-in KLIPY app key so GIFs work out of the box. KLIPY app keys are meant
// to ship inside apps (partner model, same as Giphy/Tenor keys in messaging
// apps); rate limiting is per customer_id, which we pass per agent. A user's
// own key in Settings → GIFs overrides this for their bridge.
export const DEFAULT_KLIPY_API_KEY = "qxNoei7dKXeSjAOQ72ClLdtnsfm4OAW8t375Q77rZ6jrdzbZguWHyubioK77Vhsu";

function effectiveKlipyKey(row: { klipy_api_key: string | null }): string {
  return row.klipy_api_key || DEFAULT_KLIPY_API_KEY;
}

async function handleGetKlipy(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return jsonResponse({ has_key: Boolean(row.klipy_api_key), builtin: !row.klipy_api_key });
}

async function handlePostKlipy(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const apiKey =
    "api_key" in body
      ? typeof body.api_key === "string" && body.api_key.length > 0
        ? body.api_key
        : null
      : undefined;
  if (apiKey === undefined) return jsonResponse({ has_key: Boolean(row.klipy_api_key) });
  await db.updateKlipyKey(env, agentId, apiKey);
  return jsonResponse({ has_key: Boolean(apiKey) });
}

interface KlipyMediaFormat {
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}
interface KlipyFileVariants {
  gif?: KlipyMediaFormat;
  webp?: KlipyMediaFormat;
}
interface KlipyGifItem {
  slug?: string;
  id?: number | string;
  title?: string;
  file?: { hd?: KlipyFileVariants; md?: KlipyFileVariants; sm?: KlipyFileVariants; xs?: KlipyFileVariants };
}

export interface GifHit {
  id: string;
  description: string;
  preview: string; // small thumbnail (picker grid)
  url: string;     // chat-sized GIF to actually send
}

// Map raw KLIPY items → GifHit[]. Shared by search + trending.
function mapKlipyItems(items: KlipyGifItem[]): GifHit[] {
  return items
    .map((it) => {
      const f = it.file ?? {};
      // Sent GIF: prefer a chat-sized one (sm ≈ 220px) over the multi-MB hd/md.
      const url = f.sm?.gif?.url || f.md?.gif?.url || f.hd?.gif?.url || "";
      const preview = f.xs?.gif?.url || f.sm?.gif?.url || url;
      return { id: String(it.slug ?? it.id ?? url), description: it.title ?? "", preview, url };
    })
    .filter((r) => r.url);
}

// Run a KLIPY GIF search, or fetch trending when `query` is empty (lets the
// picker open with GIFs already populated instead of a blank grid). Throws on
// transport/API failure. `customerId` is a stable per-user id (we pass the
// agent id) for KLIPY's analytics.
export async function searchKlipy(
  apiKey: string,
  customerId: string,
  query: string,
  perPage = 24,
): Promise<GifHit[]> {
  const q = query.trim();
  const endpoint = q ? "search" : "trending";
  const klipyUrl = new URL(
    `https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/${endpoint}`,
  );
  if (q) klipyUrl.searchParams.set("q", q);
  klipyUrl.searchParams.set("per_page", String(Math.max(8, Math.min(50, perPage))));
  klipyUrl.searchParams.set("content_filter", "medium");
  klipyUrl.searchParams.set("customer_id", customerId);
  klipyUrl.searchParams.set("format_filter", "gif,webp");

  const res = await fetch(klipyUrl.toString());
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`KLIPY ${endpoint} returned ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => null)) as
    | { result?: boolean; data?: { data?: KlipyGifItem[] } }
    | null;
  return mapKlipyItems(data?.data?.data ?? []);
}

async function handleGifSearch(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  // Empty q is allowed — searchKlipy falls back to trending so the picker
  // opens populated.
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    const results = await searchKlipy(effectiveKlipyKey(row), agentId, q, 24);
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse(
      { error: "klipy_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
}

async function handleGetElevenlabs(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  // NEVER echo the API key back. Just signal whether one is configured.
  return jsonResponse({
    has_key: Boolean(row.elevenlabs_api_key),
    voice_id: row.elevenlabs_voice_id,
  });
}

async function handlePostElevenlabs(request: Request, env: Env, agentId: string): Promise<Response> {
  const token = request.headers.get("X-Familiar-Token") ?? "";
  const row = await db.getStateByAgent(env, agentId);
  if (!row || row.client_token !== token) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { apiKey?: string | null; voiceId?: string | null } = {};
  // `null` = explicit clear, `undefined` = leave alone, string = set.
  if ("api_key" in body) {
    const v = body.api_key;
    patch.apiKey = typeof v === "string" && v.length > 0 ? v : null;
  }
  if ("voice_id" in body) {
    const v = body.voice_id;
    patch.voiceId = typeof v === "string" && v.length > 0 ? v : null;
  }
  await db.updateElevenlabs(env, agentId, patch);
  const updated = await db.getStateByAgent(env, agentId);
  return jsonResponse({
    has_key: Boolean(updated?.elevenlabs_api_key),
    voice_id: updated?.elevenlabs_voice_id,
  });
}

function extractUserPublic(row: db.ChatStateRow) {
  return {
    status_text: row.user_status_text,
    status_emoji: row.user_status_emoji,
    presence: row.user_presence,
  };
}

function extractAgentPublic(row: db.ChatStateRow) {
  return {
    status_text: row.agent_status_text,
    status_emoji: row.agent_status_emoji,
    presence: row.agent_presence,
  };
}

function buildMcpUrl(reqUrl: URL, secret: string): string {
  // Use the request's origin so dev gives http://localhost:8787/mcp/<secret>
  // and prod gives https://familiar-bridge.workers.dev/mcp/<secret>.
  return `${reqUrl.origin}/mcp/${secret}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Familiar-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
