/**
 * D1 query helpers for chat_state.
 */

import type { Env } from "./index";

export interface ChatStateRow {
  agent_id: string;
  client_token: string;
  mcp_secret: string;
  user_status_text: string | null;
  user_status_emoji: string | null;
  user_presence: string | null;
  agent_status_text: string | null;
  agent_status_emoji: string | null;
  agent_presence: string | null;
  elevenlabs_api_key: string | null;
  elevenlabs_voice_id: string | null;
  klipy_api_key: string | null;
  // Legacy columns — unused since autonomous check-ins moved to Letta's native
  // scheduling. Kept on the row because they still exist in the live D1 table.
  autonomous_frequency_minutes: number | null;
  last_autonomous_at: number | null;
  dnd_until: number | null;
  letta_api_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface MediaMessageRow {
  id: string;
  agent_id: string;
  kind: string; // 'audio' | 'gif'
  text: string;
  storage_key: string;
  url: string | null;
  emotion: string | null;
  duration_ms: number | null;
  created_at: number;
  delivered_at: number | null;
}

export async function getStateByAgent(env: Env, agentId: string): Promise<ChatStateRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM chat_state WHERE agent_id = ?`)
    .bind(agentId)
    .first<ChatStateRow>();
  return row ?? null;
}

export async function getStateBySecret(env: Env, secret: string): Promise<ChatStateRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM chat_state WHERE mcp_secret = ?`)
    .bind(secret)
    .first<ChatStateRow>();
  return row ?? null;
}

export async function insertInitialState(
  env: Env,
  args: { agent_id: string; client_token: string; mcp_secret: string },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO chat_state (agent_id, client_token, mcp_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(args.agent_id, args.client_token, args.mcp_secret, now, now)
    .run();
}

export async function updateUserState(
  env: Env,
  agentId: string,
  args: { text: string | null; emoji: string | null; presence: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE chat_state
     SET user_status_text = ?, user_status_emoji = ?, user_presence = ?, updated_at = ?
     WHERE agent_id = ?`,
  )
    .bind(args.text, args.emoji, args.presence, Date.now(), agentId)
    .run();
}

export async function updateAgentStatus(
  env: Env,
  agentId: string,
  args: { text: string | null; emoji: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE chat_state
     SET agent_status_text = ?, agent_status_emoji = ?, updated_at = ?
     WHERE agent_id = ?`,
  )
    .bind(args.text, args.emoji, Date.now(), agentId)
    .run();
}

export async function updateAgentPresence(
  env: Env,
  agentId: string,
  args: { presence: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE chat_state SET agent_presence = ?, updated_at = ? WHERE agent_id = ?`,
  )
    .bind(args.presence, Date.now(), agentId)
    .run();
}

export async function insertMediaMessage(
  env: Env,
  args: {
    agentId: string;
    kind: "audio" | "gif";
    text: string;
    storageKey?: string;     // R2 key for audio; '' for gif
    url?: string | null;     // direct URL for gif; null for audio
    emotion?: string | null;
    durationMs?: number | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO media_messages (id, agent_id, kind, text, storage_key, url, emotion, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      args.agentId,
      args.kind,
      args.text,
      args.storageKey ?? "",
      args.url ?? null,
      args.emotion ?? null,
      args.durationMs ?? null,
      Date.now(),
    )
    .run();
  return id;
}

export async function getMediaMessage(env: Env, id: string): Promise<MediaMessageRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM media_messages WHERE id = ?`)
    .bind(id)
    .first<MediaMessageRow>();
  return row ?? null;
}

// Recent agent-pushed media (voice notes + GIFs) for an agent, oldest-first.
// The app dedupes by id, so it can call this freely (on load, after a send, on
// a poll) and re-fetching is harmless — a reload always rebuilds the bubbles.
export async function listRecentMediaMessages(
  env: Env,
  agentId: string,
  limit = 40,
): Promise<MediaMessageRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM media_messages
     WHERE agent_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(agentId, limit)
    .all<MediaMessageRow>();
  const rows = res.results ?? [];
  return rows.reverse(); // oldest-first for display
}

// ─── Reactions ────────────────────────────────────────────────────────────────

export interface ReactionRow {
  id: number;
  agent_id: string;
  message_id: string;
  emoji: string;
  reactor: string;
  created_at: number;
}

// List reactions for the most recent N messages on an agent. The app then
// matches them client-side by message_id. We over-fetch a bit (default 500)
// so an active page of messages comes back in one round trip.
export async function listRecentReactions(
  env: Env,
  agentId: string,
  limit = 500,
): Promise<ReactionRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reactions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(agentId, limit)
    .all<ReactionRow>();
  return res.results ?? [];
}

// Toggle a reaction: if the (agent, message, emoji, reactor) row exists,
// delete it; otherwise insert it. Returns "added" or "removed" so the caller
// can confirm the new state without a follow-up query.
export async function toggleReaction(
  env: Env,
  args: { agentId: string; messageId: string; emoji: string; reactor: string },
): Promise<"added" | "removed"> {
  const existing = await env.DB.prepare(
    `SELECT id FROM reactions WHERE agent_id=? AND message_id=? AND emoji=? AND reactor=?`,
  )
    .bind(args.agentId, args.messageId, args.emoji, args.reactor)
    .first<{ id: number }>();
  if (existing) {
    await env.DB.prepare(`DELETE FROM reactions WHERE id = ?`).bind(existing.id).run();
    return "removed";
  }
  await env.DB.prepare(
    `INSERT INTO reactions (agent_id, message_id, emoji, reactor, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(args.agentId, args.messageId, args.emoji, args.reactor, Date.now())
    .run();
  return "added";
}

export async function updateKlipyKey(
  env: Env,
  agentId: string,
  apiKey: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE chat_state SET klipy_api_key = ?, updated_at = ? WHERE agent_id = ?`,
  )
    .bind(apiKey, Date.now(), agentId)
    .run();
}

export async function updateElevenlabs(
  env: Env,
  agentId: string,
  args: { apiKey?: string | null; voiceId?: string | null },
): Promise<void> {
  // Only update fields that were explicitly provided (undefined = leave alone).
  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (args.apiKey !== undefined) {
    sets.push("elevenlabs_api_key = ?");
    binds.push(args.apiKey);
  }
  if (args.voiceId !== undefined) {
    sets.push("elevenlabs_voice_id = ?");
    binds.push(args.voiceId);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(agentId);
  await env.DB.prepare(`UPDATE chat_state SET ${sets.join(", ")} WHERE agent_id = ?`)
    .bind(...binds)
    .run();
}
