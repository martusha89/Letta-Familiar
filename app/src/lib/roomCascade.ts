/**
 * Group-room turn-taking cascade.
 *
 * Letta has no shared-thread concept, so a "room" is synthesised: when an agent
 * speaks, its message is fanned into every other member's Letta history as a
 * `name`-tagged user message. Each agent's own thread thus becomes the room
 * transcript from its seat (and the ADE shows it). The app renders the unified
 * timeline from the *primary* agent's thread — so we also make sure the primary
 * ends up having ingested every other member's turn (the final "catch-up" turn).
 *
 * Flow for one human turn:
 *   1. human → primary (a normal streamed reply, no room_turn tool)
 *   2. primary's reply + the human's message are queued for the other members
 *   3. rounds: each member with something new queued gets the queued messages
 *      (name-tagged) + a `[room_turn]` decide-prompt in one POST, and must call
 *      the `room_turn` tool — `speak` (fanned onward) or `pass`. Any plain text
 *      it emits instead is discarded.
 *   4. stop when: a full round goes by with nobody speaking, the burst cap is
 *      hit (agent messages since the human last spoke), max rounds, the wall
 *      clock, or the caller aborts (user sent a new message / hit stop).
 *   5. final catch-up: if anything's still queued for the primary, hand it one
 *      last room_turn (it'll usually pass) so its thread holds the full room.
 */

import { streamMessage, streamTurn, toolCallArgs, extractText } from "../api/letta";
import type { Conversation, Session } from "../types";

export interface RoomBubble {
  id: string;
  senderId: string | null; // Letta agent id; null = the human
  text: string;
  ts: string;
}

export interface CascadeCallbacks {
  onBubble: (b: RoomBubble) => void; // a finished message to render
  onTyping: (agentId: string | null) => void; // who's "thinking" right now (null = nobody)
  onError?: (msg: string) => void;
}

const MAX_BURST = 6; // agent messages since the human last spoke → hard stop
const MAX_ROUNDS = 3; // full passes over the members
const WALL_CLOCK_MS = 90_000;

type QueueItem = {
  fromName: string;
  fromId: string | null;
  text: string;
  // Short id for react_to_message — set when the original message has one
  // (i.e. it's the human's turn; agent turns don't carry user-addressable ids
  // in v1).
  shortId?: string;
};

export async function runRoomCascade(args: {
  conv: Conversation;
  session: Session;
  humanText: string;
  humanImages?: string[];
  humanShortId?: string; // short id baked into the human's message for react_to_message
  signal: AbortSignal;
  cb: CascadeCallbacks;
}): Promise<void> {
  const { conv, session, humanText, humanImages, humanShortId, signal, cb } = args;
  const callOpts = { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey, signal };
  const primary = conv.primaryId; // owns the canonical timeline (reloads rebuild from its thread)
  const log = (...a: unknown[]) => console.log("[room-cascade]", ...a);
  const humanName = session.user.name?.trim() || "the user";
  const nameOf = (id: string) =>
    session.agents?.[id]?.nameOverride?.trim() || session.agents?.[id]?.name?.trim() || "a participant";

  // Who answers the human's message first. Default: the primary. Override: if the
  // message @-mentions a member by name (e.g. "@Caleb what do you think?"), that
  // member answers first instead, and everyone else just gets a decide-prompt.
  const responder = pickResponder(humanText, conv, nameOf) ?? primary;
  const others = conv.memberIds.filter((id) => id !== responder);
  log("start", { convId: conv.id, primary, responder, others, humanText: humanText.slice(0, 40) });

  const aborted = () => signal.aborted;
  const started = Date.now();
  const overTime = () => Date.now() - started > WALL_CLOCK_MS;

  const pending: Record<string, QueueItem[]> = {};
  for (const id of conv.memberIds) pending[id] = [];

  const speak = (agentId: string, text: string) => {
    cb.onBubble({ id: rid(), senderId: agentId, text, ts: new Date().toISOString() });
    for (const otherId of conv.memberIds) {
      if (otherId === agentId) continue;
      (pending[otherId] = pending[otherId] ?? []).push({ fromName: nameOf(agentId), fromId: agentId, text });
    }
  };

  // Run one agent's `[room_turn]` turn: hand it the queued messages (name-tagged)
  // + a decide-prompt, read its room_turn tool call off the stream, return the
  // text it chose to say (or null = passed / error / nothing).
  async function roomTurn(
    agentId: string,
    items: QueueItem[],
    burst: number,
    quiet = false, // quiet = don't show a typing indicator (used for the silent catch-up turn)
  ): Promise<string | null> {
    const turnToken = rid();
    const messages = buildTurnMessages(conv, items, burst, turnToken, nameOf, agentId);
    log("roomTurn →", agentId, { items: items.length, burst, quiet });
    if (!quiet) cb.onTyping(agentId);
    let spoken: string | null = null;
    try {
      // Scope this agent's turn to its Letta conversation for this room (if we
      // have one). Each member sees this group as a distinct thread server-side;
      // the agent's 1:1 with the human stays untouched.
      const memberConvId = conv.conversationIds?.[agentId];
      for await (const msg of streamTurn(callOpts, agentId, messages, { conversationId: memberConvId })) {
        if (msg.message_type === "error_message") console.error("[room-cascade] roomTurn error_message", agentId, msg);
        log("roomTurn msg", agentId, msg.message_type, msg.tool_call?.name ?? "");
        if (msg.message_type === "tool_call_message" && (msg.tool_call?.name ?? "").includes("room_turn")) {
          const a = toolCallArgs(msg);
          log("roomTurn args", agentId, a);
          spoken =
            a.action === "speak" && typeof a.message === "string" && a.message.trim() ? a.message.trim() : null;
        }
        // assistant_message / reasoning / other tool calls: discarded by design.
      }
    } catch (e) {
      console.error("[room-cascade] roomTurn failed", agentId, e);
      if (!quiet) cb.onTyping(null);
      if (aborted()) return null;
      cb.onError?.(e instanceof Error ? e.message : String(e));
      return null; // one agent's failure doesn't kill the cascade
    }
    if (!quiet) cb.onTyping(null);
    log("roomTurn done", agentId, "spoken:", spoken ? spoken.slice(0, 40) : "(passed)");
    return spoken;
  }

  // ── Round 0: human → responder (normal streamed reply) ───────────────────
  // No `name` tag here — the agent knows this is the human, and some Letta model
  // backends (e.g. an OpenAI-proxy) error on a `name`-tagged user message.
  // Attribution between participants is done with a `[Name] ` content prefix.
  log("round 0 → responder", responder);
  cb.onTyping(responder);
  let responderReply = "";
  try {
    for await (const msg of streamMessage(callOpts, responder, {
      text: humanText,
      imageDataUrls: humanImages && humanImages.length > 0 ? humanImages : undefined,
      conversationId: conv.conversationIds?.[responder],
      shortId: humanShortId,
    })) {
      if (msg.message_type === "error_message") console.error("[room-cascade] round 0 error_message", msg);
      log("round 0 msg", msg.message_type, typeof msg.content === "string" ? msg.content.slice(0, 60) : "");
      if (msg.message_type === "assistant_message") {
        const t = extractText(msg);
        if (t) responderReply += t;
      }
      // The responder's tool calls (memory, status, voice notes, …) run as normal
      // but aren't surfaced here — voice notes/GIFs still arrive via the media poll.
    }
  } catch (e) {
    console.error("[room-cascade] round 0 failed", e);
    cb.onTyping(null);
    if (aborted()) return;
    cb.onError?.(e instanceof Error ? e.message : String(e));
    return;
  }
  cb.onTyping(null);
  if (aborted()) return;
  responderReply = responderReply.trim();
  log("round 0 done, responderReply:", responderReply ? responderReply.slice(0, 60) : "(empty)");
  if (responderReply) cb.onBubble({ id: rid(), senderId: responder, text: responderReply, ts: new Date().toISOString() });

  // Everyone except the responder needs the human's message + the responder's
  // reply — including the primary (so its thread, the timeline of record, ends
  // up with the responder's turn via the catch-up). The human's text carries
  // the same short id we used in round 0, so non-responder members can also
  // address it via react_to_message.
  for (const id of others) {
    if (humanText.trim())
      pending[id].push({
        fromName: humanName,
        fromId: null,
        text: humanText.trim(),
        shortId: humanShortId,
      });
    if (responderReply) pending[id].push({ fromName: nameOf(responder), fromId: responder, text: responderReply });
  }

  let burst = responderReply ? 1 : 0; // the responder's reply is the first agent message

  // ── Cascade rounds ───────────────────────────────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (aborted() || overTime() || burst >= MAX_BURST) break;
    let anyoneSpoke = false;
    for (const agentId of conv.memberIds) {
      if (aborted() || overTime() || burst >= MAX_BURST) break;
      const queue = pending[agentId];
      if (!queue || queue.length === 0) continue;
      const items = queue.splice(0, queue.length); // snapshot + clear
      const text = await roomTurn(agentId, items, burst);
      if (aborted()) return;
      if (text) {
        anyoneSpoke = true;
        burst++;
        speak(agentId, text);
      }
    }
    if (!anyoneSpoke) break; // a quiet round → the room has settled
  }

  // ── Final catch-up: the timeline is rebuilt from the primary's thread, so
  // make sure it has ingested everyone else's turns. Usually it'll pass; if it
  // speaks, render that too. Skipped on abort. ───────────────────────────────
  if (!aborted() && (pending[primary]?.length ?? 0) > 0) {
    const items = pending[primary].splice(0, pending[primary].length);
    const text = await roomTurn(primary, items, MAX_BURST, true); // quiet; MAX_BURST → "strongly prefer pass"
    if (!aborted() && text) cb.onBubble({ id: rid(), senderId: primary, text, ts: new Date().toISOString() });
  }
}

function rid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

// If the human's message @-mentions a room member by display name
// (case-insensitive — "@Caleb", "@caleb", "@Caleb?"), return that member's id so
// they answer first instead of the primary. Otherwise null (→ default primary).
function pickResponder(text: string, conv: Conversation, nameOf: (id: string) => string): string | null {
  const lower = text.toLowerCase();
  for (const id of conv.memberIds) {
    const n = nameOf(id).trim().toLowerCase();
    if (!n) continue;
    const tag = `@${n}`;
    const idx = lower.indexOf(tag);
    if (idx !== -1) {
      const after = lower[idx + tag.length];
      if (after === undefined || /[^a-z0-9_]/.test(after)) return id; // not part of a longer word
    }
  }
  return null;
}

// Prefix used to attribute a room message to its sender inside the message text
// (instead of the `name`/`sender_id` MessageCreate fields, which some Letta
// model backends reject). Format: `[Display Name] message text`.
export function roomPrefix(name: string): string {
  return `[${name}] `;
}

// One agent's room turn = each new room message as its own user message,
// `[Name] `-prefixed so the agent (and the ADE) can see who said what, then a
// `[room_turn]` decide-prompt as the final user message — the thing it runs on.
function buildTurnMessages(
  conv: Conversation,
  items: QueueItem[],
  burst: number,
  turnToken: string,
  nameOf: (id: string) => string,
  selfId: string,
): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  for (const it of items) {
    // `[#xxxxxx] [Name] text` — short id first (so the app's extractShortId
    // catches it before [Name] parsing), then the speaker tag, then the body.
    // The short id makes the message addressable via react_to_message; the
    // app strips the prefix from display the same way it does in 1:1.
    const idPrefix = it.shortId ? `[#${it.shortId}] ` : "";
    msgs.push({
      role: "user",
      content: `${idPrefix}${roomPrefix(it.fromName)}${it.text}`,
    });
  }
  const roster =
    conv.memberIds
      .filter((id) => id !== selfId)
      .map((id) => nameOf(id))
      .join(", ") || "(no other agents)";
  let eagerness: string;
  if (burst >= 4) {
    eagerness =
      "This room has become mostly back-and-forth between agents with no new input from the human — strongly prefer to pass. Only speak if it's genuinely important.";
  } else if (burst >= 3) {
    eagerness = "A couple of replies have already gone by since the human last spoke — lean toward passing.";
  } else {
    eagerness = "Pass unless you'd genuinely add something the human wants to read.";
  }
  const prompt =
    `[room_turn] You're in a group room${conv.name ? ` ("${conv.name}")` : ""} with: ${roster}, plus the human.\n` +
    `The new messages since your last turn are shown above and are in your history now. Decide whether to add anything.\n` +
    `${eagerness}\n` +
    `To participate you MUST call the room_turn tool — a plain text reply will NOT be delivered to the room and is discarded.\n` +
    `  • room_turn(action:"pass", turn_token:"${turnToken}") — stay quiet (the usual choice)\n` +
    `  • room_turn(action:"speak", message:"...", turn_token:"${turnToken}") — say something; write it as your natural reply, don't prefix it with your own name.\n` +
    `Don't address anyone who isn't in this room. conversation_id is "${conv.id}".`;
  msgs.push({ role: "user", content: prompt });
  return msgs;
}

// Reload helper: build a name→agentId map for a group conversation so the
// timeline (rebuilt from the primary's Letta thread) can attribute `name`-tagged
// user messages back to the member that sent them.
export function buildMembersByName(conv: Conversation, session: Session): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of conv.memberIds) {
    const info = session.agents?.[id];
    const n = info?.nameOverride?.trim() || info?.name?.trim();
    if (n && !map.has(n)) map.set(n, id);
  }
  return map;
}
