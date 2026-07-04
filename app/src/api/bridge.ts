/**
 * Familiar bridge API client. Calls our own bridge worker (not Letta).
 */

interface BridgeOpts {
  bridgeUrl: string;
  clientToken?: string;
}

export interface InitResult {
  ok: boolean;
  agent_id: string;
  client_token: string;
  mcp_secret: string;
  mcp_url: string;
}

export interface BridgeStateUser {
  status_text: string | null;
  status_emoji: string | null;
  presence: string | null;
}

export interface BridgeStateAgent {
  status_text: string | null;
  status_emoji: string | null;
  presence: string | null;
}

export interface BridgeState {
  user: BridgeStateUser;
  agent: BridgeStateAgent;
  updated_at: number;
}

function url(opts: BridgeOpts, path: string): string {
  return `${opts.bridgeUrl.replace(/\/$/, "")}${path}`;
}

export async function initAgent(opts: BridgeOpts, agentId: string): Promise<InitResult> {
  const res = await fetch(url(opts, `/api/agents/${agentId}/init`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge init failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as InitResult;
}

export async function getState(opts: BridgeOpts, agentId: string): Promise<BridgeState> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/state`), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge getState failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as BridgeState;
}

export interface KlipyConfig {
  has_key: boolean;
}

export interface GifResult {
  id: string;
  description: string;
  preview: string;
  url: string;
}

export async function getKlipy(opts: BridgeOpts, agentId: string): Promise<KlipyConfig> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/klipy`), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge getKlipy failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as KlipyConfig;
}

export async function postKlipy(
  opts: BridgeOpts,
  agentId: string,
  patch: { api_key?: string | null },
): Promise<KlipyConfig> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/klipy`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Familiar-Token": opts.clientToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge postKlipy failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as KlipyConfig;
}

export async function searchGifs(
  opts: BridgeOpts,
  agentId: string,
  query: string,
): Promise<GifResult[]> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const u = new URL(url(opts, `/api/agents/${agentId}/gif/search`));
  u.searchParams.set("q", query);
  const res = await fetch(u.toString(), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge searchGifs failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: GifResult[] };
  return data.results ?? [];
}

// Agent-pushed media that isn't part of Letta's text history. Discriminated
// by `kind`: 'audio' carries audio_url/emotion/duration_ms; 'gif' carries gif_url.
export type MediaMessage =
  | {
      id: string;
      kind: "audio";
      text: string;
      audio_url: string;
      emotion: string | null;
      duration_ms: number | null;
      created_at: number;
    }
  | {
      id: string;
      kind: "gif";
      text: string; // optional caption ('' if none)
      gif_url: string;
      created_at: number;
    };

export async function getMediaMessages(
  opts: BridgeOpts,
  agentId: string,
): Promise<MediaMessage[]> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/media/messages`), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge getMediaMessages failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { messages?: MediaMessage[] };
  return data.messages ?? [];
}

export interface ElevenlabsConfig {
  has_key: boolean;
  voice_id: string | null;
}

export async function getElevenlabs(opts: BridgeOpts, agentId: string): Promise<ElevenlabsConfig> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/elevenlabs`), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge getElevenlabs failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as ElevenlabsConfig;
}

// Pass `null` to clear a field, omit to leave it unchanged, pass a string to set.
export async function postElevenlabs(
  opts: BridgeOpts,
  agentId: string,
  patch: { api_key?: string | null; voice_id?: string | null },
): Promise<ElevenlabsConfig> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/elevenlabs`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Familiar-Token": opts.clientToken },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge postElevenlabs failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as ElevenlabsConfig;
}

// ─── Reactions ────────────────────────────────────────────────────────────────

export interface Reaction {
  message_id: string;
  emoji: string;
  reactor: string; // "user" | agent_id (v2)
  created_at: number;
}

export async function listReactions(
  opts: BridgeOpts,
  agentId: string,
): Promise<Reaction[]> {
  if (!opts.clientToken) return [];
  const res = await fetch(url(opts, `/api/agents/${agentId}/reactions`), {
    headers: { "X-Familiar-Token": opts.clientToken },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge listReactions failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { reactions?: Reaction[] };
  return data.reactions ?? [];
}

export async function toggleReaction(
  opts: BridgeOpts,
  agentId: string,
  args: { messageId: string; emoji: string; reactor?: string },
): Promise<"added" | "removed"> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/reactions/toggle`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Familiar-Token": opts.clientToken },
    body: JSON.stringify({
      message_id: args.messageId,
      emoji: args.emoji,
      reactor: args.reactor ?? "user",
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge toggleReaction failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { state: "added" | "removed" };
  return data.state;
}

export async function postUserState(
  opts: BridgeOpts,
  agentId: string,
  patch: Partial<BridgeStateUser>,
): Promise<BridgeState> {
  if (!opts.clientToken) throw new Error("clientToken required");
  const res = await fetch(url(opts, `/api/agents/${agentId}/state`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Familiar-Token": opts.clientToken },
    body: JSON.stringify({
      user_status_text: patch.status_text ?? null,
      user_status_emoji: patch.status_emoji ?? null,
      user_presence: patch.presence ?? null,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bridge postUserState failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as BridgeState;
}
