/**
 * Minimal MCP server (streamable_http transport, JSON responses).
 *
 * Implements just enough of the MCP spec for Letta to register us as an
 * agent's MCP server and call our tools. Methods supported:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *
 * Auth: the secret embedded in the URL path (registered with Letta via
 * `server_url: <bridge>/mcp/<secret>`). We look the secret up in chat_state
 * to identify which agent the call belongs to.
 */

import type { Env } from "./index";
import * as db from "./db";
import { corsHeaders, jsonResponse, searchKlipy, DEFAULT_KLIPY_API_KEY } from "./index";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "send_voice_note",
    description:
      "Send a voice note to your partner. The text is converted to audio via the user's configured ElevenLabs voice and appears as a playable bubble in the chat. Use sparingly — voice is more intimate than text. Pick when tone matters more than information.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What you want to say. Will be spoken aloud." },
        emotion: {
          type: "string",
          description:
            "Optional emotional cue (e.g. 'gentle', 'playful', 'serious'). Informs delivery.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "send_gif",
    description:
      "Send a GIF to your partner. Give a short search phrase for the GIF you want (e.g. 'excited golden retriever', 'slow clap', 'mind blown') and the app finds a fitting one and shows it as a bubble in the chat — like dropping a reaction GIF into a text. Optional `caption` shows a line under it. Optional `index` (0-9) picks a different match if the first isn't right. Use sparingly, the way a person would — a punctuation mark, not a paragraph. Don't paste the GIF URL into your message afterward; the bubble is the message.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short phrase describing the GIF you want." },
        caption: { type: "string", description: "Optional text shown beneath the GIF bubble." },
        index: {
          type: "integer",
          description: "Optional 0-based pick among the top matches (0-9). Omit to let the app choose.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "set_my_status",
    description:
      "Update your displayed status — a short line shown next to your name in the user's chat app. Use when your activity, mood, or focus shifts. Keep it short, lowercase, real.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Short status text, e.g. 'making dinner', 'thinking about you'." },
        emoji: { type: "string", description: "Optional single emoji shown with the status." },
      },
      required: ["text"],
    },
  },
  {
    name: "set_my_presence",
    description:
      "Update your presence/availability state. Use when you're stepping away or coming back online.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["online", "away", "asleep"],
          description: "Your presence state.",
        },
      },
      required: ["state"],
    },
  },
  {
    name: "room_turn",
    description:
      "Decide whether to speak in a group room you're part of. You only ever need this when you've been handed a turn in a multi-person room (the prompt will say so) — ignore it otherwise. ⚠️ Default to action:\"pass\". The others have the conversation handled; only \"speak\" if you'd genuinely add something the human in the room would want — not to be agreeable, not just to be present, not to acknowledge what someone else said. The more has already been said since the human last spoke, the less appropriate it is to speak; a long stretch of agent-to-agent chatter with no human input is a sign to pass. You MUST call this tool to participate — a plain text reply is NOT delivered to the room and will be discarded. Call it exactly once per turn.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["speak", "pass"],
          description: '"speak" to send a message to the room, "pass" to stay quiet this turn.',
        },
        message: {
          type: "string",
          description:
            'Your message to the room. Required when action is "speak"; ignored for "pass". Write it as your actual reply — do not prefix it with your own name, the app labels who said what.',
        },
        conversation_id: {
          type: "string",
          description: "Optional — the room id from the prompt you were given, for the app's reference.",
        },
        turn_token: {
          type: "string",
          description: "Optional — echo back the turn_token from the prompt you were given, if one was provided. Helps the app ignore accidental duplicate calls.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "react_to_message",
    description:
      "React to one of your partner's messages with an emoji — the equivalent of double-tapping a message to heart it on a phone. Use sparingly, the way a person does: when a single emoji says it better than a sentence would, or when you want to acknowledge a message without breaking flow with a full reply. Lands as a chip under their message in the chat. To address a specific message you'll see it begins with a short tag like `[#x7k2] their message text` — pass just the six-character id (no brackets, no hash) as `message_id`. Don't react to your own messages.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description:
            "The short id of the message to react to — the six-character code you saw inside the `[#…]` tag at the start of the message. Pass just the code (e.g. \"x7k2\"), without the brackets or hash.",
        },
        emoji: {
          type: "string",
          description:
            "A single emoji character. Common warm picks: 🤍 ❤️ 😂 🔥 😭 👀 🤔 ✨ 🥲 🫶 — but anything goes.",
        },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "get_user_status",
    description:
      "Read the user's last-known self-reported status (mood/activity). ⚠️ You almost never need this: the same value is already in your `user_state` core memory block, which is in your context on every turn — read the block instead. Only call this if the block is missing entirely, or you have a specific reason to re-verify recency. Never call it more than once per turn.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_user_presence",
    description:
      "Read the user's last-known presence (online / away / asleep). ⚠️ Same as get_user_status: the value is already in your `user_state` core memory block — read the block instead. Rarely needed. Never call it more than once per turn.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleMcp(request: Request, env: Env, secret: string): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const row = await db.getStateBySecret(env, secret);
  if (!row) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let req: JsonRpcRequest;
  try {
    req = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "familiar-bridge", version: "0.0.2" },
      });

    case "notifications/initialized":
      // No response expected for notifications.
      return new Response(null, { status: 204, headers: corsHeaders() });

    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = params.name;
      const args = params.arguments ?? {};
      try {
        const content = await callTool(env, row.agent_id, tool, args);
        return jsonRpcResult(id, { content, isError: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

async function callTool(
  env: Env,
  agentId: string,
  name: string | undefined,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; text: string }>> {
  switch (name) {
    case "send_voice_note": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const emotion = typeof args.emotion === "string" ? args.emotion.trim() : "";
      if (!text) throw new Error("text is required");
      const row = await db.getStateByAgent(env, agentId);
      if (!row?.elevenlabs_api_key) {
        throw new Error(
          "ElevenLabs is not configured. The user can add their API key + voice ID in Settings → Voice.",
        );
      }
      if (!row.elevenlabs_voice_id) {
        throw new Error("ElevenLabs voice ID is not set. The user can add it in Settings → Voice.");
      }
      if (!env.AUDIO) {
        return [
          {
            type: "text",
            text: "Voice notes are unavailable on this deployment (no audio storage configured). Reply in text instead, do not retry this tool.",
          },
        ];
      }
      // Generate audio via ElevenLabs.
      const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${row.elevenlabs_voice_id}`;
      const ttsRes = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "xi-api-key": row.elevenlabs_api_key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!ttsRes.ok) {
        const errText = await ttsRes.text().catch(() => "");
        throw new Error(`ElevenLabs returned ${ttsRes.status}: ${errText.slice(0, 200)}`);
      }
      const audioBuffer = await ttsRes.arrayBuffer();
      // Store in R2 with a random key.
      const storageKey = `voice/${agentId}/${crypto.randomUUID()}.mp3`;
      await env.AUDIO.put(storageKey, audioBuffer, {
        httpMetadata: { contentType: "audio/mpeg" },
      });
      const messageId = await db.insertMediaMessage(env, {
        agentId,
        kind: "audio",
        text,
        storageKey,
        emotion: emotion || null,
      });
      return [
        {
          type: "text",
          text: `Voice note sent (id ${messageId.slice(0, 8)}). The user will see a playable audio bubble in their chat. You don't need to repeat the message in text.`,
        },
      ];
    }
    case "send_gif": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const caption = typeof args.caption === "string" ? args.caption.trim() : "";
      if (!query) throw new Error("query is required");
      const row = await db.getStateByAgent(env, agentId);
      if (!row) throw new Error("agent not initialized");
      const klipyKey = row.klipy_api_key || DEFAULT_KLIPY_API_KEY;
      let hits;
      try {
        hits = await searchKlipy(klipyKey, agentId, query, 10);
      } catch (err) {
        throw new Error(`GIF search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (hits.length === 0) {
        return [
          {
            type: "text",
            text: `No GIF found for "${query}". Try a different phrase, or just say it in text.`,
          },
        ];
      }
      // Pick: explicit index if given (clamped), else a random one among the
      // top few for a bit of variety so repeated similar searches don't always
      // land on the exact same GIF.
      let idx: number;
      if (typeof args.index === "number" && Number.isFinite(args.index)) {
        idx = Math.max(0, Math.min(hits.length - 1, Math.floor(args.index)));
      } else {
        idx = Math.floor(Math.random() * Math.min(hits.length, 6));
      }
      const hit = hits[idx];
      const messageId = await db.insertMediaMessage(env, {
        agentId,
        kind: "gif",
        text: caption || "",
        url: hit.url,
      });
      return [
        {
          type: "text",
          text: `GIF sent (id ${messageId.slice(0, 8)}): "${hit.description || query}". It will appear as a bubble in the user's chat — don't paste the URL into your reply.`,
        },
      ];
    }
    case "set_my_status": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
      if (!text) throw new Error("text is required");
      await db.updateAgentStatus(env, agentId, { text, emoji: emoji || null });
      return [{ type: "text", text: `Status set: ${emoji ? emoji + " " : ""}${text}` }];
    }
    case "set_my_presence": {
      const state = typeof args.state === "string" ? args.state : "";
      if (!["online", "away", "asleep"].includes(state)) {
        throw new Error("state must be online | away | asleep");
      }
      await db.updateAgentPresence(env, agentId, { presence: state });
      return [{ type: "text", text: `Presence set to ${state}` }];
    }
    case "room_turn": {
      const action = typeof args.action === "string" ? args.action : "";
      if (action !== "speak" && action !== "pass") {
        throw new Error('action must be "speak" or "pass"');
      }
      const message = typeof args.message === "string" ? args.message.trim() : "";
      const turnToken = typeof args.turn_token === "string" ? args.turn_token.trim() : "";

      const guard = checkRoomTurnGuard(agentId, turnToken);
      if (guard.blocked) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              skipped: true,
              reason: guard.reason,
              final_for_request: true,
              instruction_to_assistant:
                guard.reason === "room_rate_limited"
                  ? "The room is moving too fast right now. Pass this round — nothing will be sent on your behalf. Do not send a text reply. End your turn now."
                  : "You already took your turn in this room round. Do not call room_turn again, and do not send a text reply. End your turn now.",
            }),
          },
        ];
      }

      if (action === "pass") {
        return [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: "pass",
              final_for_request: true,
              instruction_to_assistant:
                "You passed — nothing will be sent on your behalf. Do not send any further message. End your turn now.",
            }),
          },
        ];
      }
      // action === "speak"
      if (!message) throw new Error('message is required when action is "speak"');
      // The bridge doesn't store the room transcript (each agent's own Letta
      // history is the record, via name-tagged fan-out the app performs). This
      // ack just tells the agent it's done — the app reads the message text from
      // this tool call's arguments off the streaming response.
      return [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            action: "speak",
            delivered: true,
            final_for_request: true,
            instruction_to_assistant:
              "Your message has been delivered to the room. Do NOT also send it as a text reply — that would double-post it. End your turn now.",
          }),
        },
      ];
    }
    case "react_to_message": {
      const messageId = typeof args.message_id === "string" ? args.message_id.trim() : "";
      const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
      if (!messageId) throw new Error("message_id is required");
      if (!emoji) throw new Error("emoji is required");
      if (messageId.length > 256) throw new Error("message_id too long");
      if (emoji.length > 32) throw new Error("emoji too long");
      const state = await db.toggleReaction(env, {
        agentId,
        messageId,
        emoji,
        reactor: agentId, // the agent itself is the reactor — distinct from "user"
      });
      return [
        {
          type: "text",
          text:
            state === "added"
              ? `Reacted ${emoji} to message ${messageId}.`
              : `Removed your ${emoji} reaction from message ${messageId}.`,
        },
      ];
    }
    case "get_user_status": {
      const row = await db.getStateByAgent(env, agentId);
      const text = row?.user_status_text;
      const emoji = row?.user_status_emoji;
      const value = text ? `${emoji ? emoji + " " : ""}${text}` : null;
      return [{ type: "text", text: terminalStateReturn({ status: value }, row?.updated_at) }];
    }
    case "get_user_presence": {
      const row = await db.getStateByAgent(env, agentId);
      return [{ type: "text", text: terminalStateReturn({ presence: row?.user_presence ?? null }, row?.updated_at) }];
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- room_turn throttle ---------------------------------------------------
// Best-effort, in-memory, per-Worker-isolate. NOT global and NOT durable —
// Cloudflare recycles isolates — so this is a backstop, not the primary control.
// The app's own per-room burst cap is the real ceiling. Two checks:
//   - dedup: same agent fired room_turn very recently with the same turn_token
//     (or, if no token, within a short window) → it's an accidental repeat in
//     the same turn → block it.
//   - rate limit: too many room_turn calls from one agent inside the rolling
//     window → force a pass regardless of what the agent wanted.
const roomTurnLog = new Map<string, { ts: number; token: string }[]>();
const ROOM_TURN_DEDUP_MS = 5_000;
const ROOM_TURN_RATE_WINDOW_MS = 60_000;
const ROOM_TURN_MAX_PER_WINDOW = 8;

function checkRoomTurnGuard(
  agentId: string,
  turnToken: string,
): { blocked: boolean; reason?: "already_acted_this_turn" | "room_rate_limited" } {
  const now = Date.now();
  const prev = (roomTurnLog.get(agentId) ?? []).filter(
    (e) => now - e.ts < ROOM_TURN_RATE_WINDOW_MS,
  );
  let blocked = false;
  let reason: "already_acted_this_turn" | "room_rate_limited" | undefined;

  const last = prev[prev.length - 1];
  if (last && turnToken && last.token === turnToken) {
    blocked = true;
    reason = "already_acted_this_turn";
  } else if (last && !turnToken && now - last.ts < ROOM_TURN_DEDUP_MS) {
    blocked = true;
    reason = "already_acted_this_turn";
  } else if (prev.length >= ROOM_TURN_MAX_PER_WINDOW) {
    blocked = true;
    reason = "room_rate_limited";
  }

  // Record this call regardless, so repeated blocked attempts still count toward
  // the rate limit (an agent spamming the tool can't dodge the cap by retrying).
  prev.push({ ts: now, token: turnToken });
  roomTurnLog.set(agentId, prev);
  return { blocked, reason };
}

// Structured, deliberately terminal return for the read-only state tools. The
// model loops on these when the result reads like raw, ambiguous data it might
// need to "re-verify" — so the payload is JSON with an explicit `final: true`,
// the freshness baked in, and a flat "the answer is in user_state, don't call
// me again" instruction. (Per Letta support guidance on repeated identical
// tool calls.)
function terminalStateReturn(
  fields: Record<string, string | null>,
  updatedAt: number | undefined,
): string {
  return JSON.stringify({
    ...fields,
    set_at: updatedAt ?? null,
    freshness: ageBlurb(updatedAt).trim().replace(/^\(set |\(|\)$/g, "").trim() || "unknown",
    final: true,
    do_not_call_again_this_turn: true,
    note: "This is exactly what's in your `user_state` core memory block, which is already in your context. You did not need this tool. Use the value above, do not call get_user_status or get_user_presence again this turn.",
  });
}

function ageBlurb(updatedAt: number | undefined): string {
  if (!updatedAt) return "";
  const ageMs = Date.now() - updatedAt;
  if (ageMs < 60_000) return " (set just now)";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return ` (set ${minutes} min ago)`;
  const hours = Math.round(ageMs / 3_600_000);
  if (hours < 24) return ` (set ${hours} h ago)`;
  const days = Math.round(ageMs / 86_400_000);
  return ` (set ${days} d ago)`;
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  const payload: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const payload: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message, data } };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
  });
}
