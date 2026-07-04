import { useEffect, useRef, useState } from "react";
import type { Conversation, LettaMessage, Profile, Session } from "../types";
import {
  extractText,
  extractImageUrls,
  extractShortId,
  getMessages,
  newShortMessageId,
  streamMessage,
  sendMessage,
} from "../api/letta";
import { runRoomCascade, buildMembersByName } from "../lib/roomCascade";
import * as bridge from "../api/bridge";
import { resizeImageFile } from "../lib/appearance";
import Avatar from "./Avatar";
import AudioPlayer from "./AudioPlayer";
import GifPicker from "./GifPicker";
import ProfileCard from "./ProfileCard";
import ProfileEditor from "./ProfileEditor";

interface Props {
  session: Session;
  onSwitchAgent: () => void; // back to the conversation list
  onUserProfileChange: (p: Profile) => void;
  onAgentProfileChange: (p: Profile) => void;
  onUserPresenceChange: (presence: string | undefined) => void;
  onAgentStateRefresh: (state: bridge.BridgeState) => void;
  onLastMessage?: (text: string, at: number) => void;
  onOpenSettings: () => void;
}

// Quick-pick emojis for the reaction popover. Curated for warm/dry vibe —
// not exhaustive. Future: optional full picker behind a "more" button.
const REACTION_PICKS = ["🤍", "😂", "🔥", "😭", "👀", "🤔"];

interface DisplayMessage {
  id: string;
  who: "user" | "assistant" | "system" | "tool";
  text: string;
  senderId?: string | null; // group rooms: which member said it (null/undefined = the human or the primary)
  images?: string[]; // data URLs or remote URLs to render in the bubble
  audio?: { url: string; emotion?: string | null };
  gif?: { url: string; caption?: string }; // agent-sent GIF (via send_gif)
  error?: boolean; // when who === "tool": render as a visible failure note, not a quiet italic line
  ts?: string;
}

// When rebuilding a group conversation's timeline from the primary agent's Letta
// thread, this maps `name`-tagged user messages back to the member that sent them.
interface GroupCtx {
  membersByName: Map<string, string>;
  primaryId: string;
  humanName: string; // so a `[HumanName] ` prefix on a fanned-in message is stripped & shown as the user
}

const PAGE_SIZE = 50;

function humanizeToolName(name?: string): string {
  if (!name) return "using a tool";
  const n = name.toLowerCase();
  if (n.includes("send_voice_note")) return ""; // voice note becomes its own bubble — don't double-announce
  if (n.includes("set_my_status")) return "updating their status";
  if (n.includes("set_my_presence")) return "updating their presence";
  if (n.includes("get_user_status")) return "checking in on you";
  if (n.includes("get_user_presence")) return "checking your presence";
  if (n.includes("memory_insert") || n.includes("core_memory_append")) return "adding to memory";
  if (n.includes("memory_replace") || n.includes("core_memory_replace")) return "rewriting a memory block";
  if (n.includes("archival_memory_insert")) return "saving to long-term memory";
  if (n.includes("archival_memory_search")) return "searching memory";
  if (n.includes("conversation_search")) return "looking back through chats";
  if (n.includes("send_message")) return "";
  if (n.includes("pause_heartbeats")) return "";
  return `using ${name.replace(/_/g, " ")}`;
}

// Pull a human-readable error string out of a tool_return_message. Letta may
// hand us the raw string, a JSON-wrapped `{type:"text",text:"…"}`, or an array
// of such parts (that's the MCP `content` shape). Returns null if the return
// doesn't look like an error — successful tool returns are noise we don't render.
function toolReturnError(m: LettaMessage): string | null {
  const raw = (typeof m.tool_return === "string" ? m.tool_return : "") || extractText(m);
  let text = raw.trim();
  if (!text) return m.status === "error" ? "A tool call failed." : null;
  // Unwrap a JSON envelope if present.
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const part = Array.isArray(parsed) ? parsed[0] : parsed;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        text = ((part as { text: string }).text).trim();
      }
    } catch {
      // not JSON — leave as-is
    }
  }
  const looksLikeError = m.status === "error" || /^error\b[:\s]/i.test(text);
  if (!looksLikeError) return null;
  const cleaned = text.replace(/^error\b[:\s]+/i, "").trim() || text;
  return cleaned.slice(0, 240);
}

function toDisplay(messages: LettaMessage[], ctx?: GroupCtx): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const m of messages) {
    if (m.message_type === "user_message") {
      const text = extractText(m);
      // Hide the autonomous-check trigger messages — they were sent by the
      // scheduler, not by the user, and reading them in chat history would
      // be confusing ("did I send this?"). Same for [room_turn] decide-prompts
      // (those are internal, not utterances).
      if (
        text.startsWith("[autonomous_check_in]") ||
        text.startsWith("[room_turn]") ||
        text.startsWith("[reaction]")
      )
        continue;
      const images = extractImageUrls(m);
      // Pull the short id baked into the text by sendMessage/streamMessage
      // (so agents can address it via react_to_message). Strip the prefix
      // from the displayed text; use the short id as the DisplayMessage id
      // so the reactions table and the bubble agree on the same key.
      const { id: shortId, text: textWithoutShortId } = extractShortId(text);
      // In a group, a fanned-in turn from another participant arrives `[Name] `-
      // prefixed (we attribute via the text, not the `name` field — some model
      // backends reject `name`). If the bracketed name is a known member, render
      // it as that agent and strip the prefix; otherwise it's the human.
      let fromMember: string | undefined;
      let displayText = textWithoutShortId;
      if (ctx) {
        const mm = textWithoutShortId.match(/^\[([^\]]+)\]\s([\s\S]*)$/);
        if (mm) {
          const tag = mm[1].trim();
          const memberId = ctx.membersByName.get(tag);
          if (memberId) {
            fromMember = memberId; // a fanned-in turn from that agent
            displayText = mm[2];
          } else if (tag === ctx.humanName) {
            displayText = mm[2]; // the human's own message, fanned into the primary's thread — strip the tag
          }
        }
      }
      if (displayText || images.length > 0) {
        out.push({
          // Prefer the short id (agent-addressable) when present; fall back to
          // Letta's own message id (pre-isolation messages, etc.) so we still
          // render and dedupe consistently.
          id: shortId ?? m.id ?? cryptoId(),
          who: fromMember ? "assistant" : "user",
          senderId: fromMember,
          text: displayText,
          images: images.length > 0 ? images : undefined,
          ts: m.date ?? m.created_at,
        });
      }
    } else if (m.message_type === "assistant_message") {
      const text = extractText(m);
      const images = extractImageUrls(m);
      if (text || images.length > 0) {
        out.push({
          id: m.id ?? cryptoId(),
          who: "assistant",
          senderId: ctx?.primaryId,
          text,
          images: images.length > 0 ? images : undefined,
          ts: m.date ?? m.created_at,
        });
      }
    } else if (m.message_type === "tool_call_message") {
      const label = humanizeToolName(m.tool_call?.name);
      if (label) out.push({ id: m.id ?? cryptoId(), who: "tool", text: label, ts: m.date ?? m.created_at });
    } else if (m.message_type === "tool_return_message") {
      // Successful returns are noise; only a failure earns a visible note.
      // Without this, a tool that errors (e.g. send_voice_note with no
      // ElevenLabs key) is completely silent — the call note is suppressed
      // and no bubble ever appears.
      const err = toolReturnError(m);
      if (err) {
        out.push({ id: m.id ?? cryptoId(), who: "tool", text: err, error: true, ts: m.date ?? m.created_at });
      }
    }
  }
  return out;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Sort key for a display message. Messages without a timestamp (optimistic
// user sends still in flight) sort last — they're the newest thing on screen.
function tsOf(m: DisplayMessage): number {
  if (!m.ts) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(m.ts);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

// Legacy: older messages may still have the [my current status: ...] prefix
// from when we injected it per-message. Strip it so old history reads cleanly.
function stripLegacyStatusFromUserDisplay(text: string): string {
  return text.replace(/^\[my current status:[^\]]+\]\s*/i, "");
}

export default function ChatPage({
  session,
  onSwitchAgent,
  onUserProfileChange,
  onAgentProfileChange,
  onUserPresenceChange,
  onAgentStateRefresh,
  onLastMessage,
  onOpenSettings,
}: Props) {
  const conv: Conversation | undefined = session.conversations?.find(
    (c) => c.id === session.activeConversationId,
  );
  const isGroup = conv?.kind === "group";
  const groupCtx: GroupCtx | undefined =
    isGroup && conv
      ? {
          membersByName: buildMembersByName(conv, session),
          primaryId: conv.primaryId,
          humanName: session.user.name?.trim() || "the user",
        }
      : undefined;

  // Resolve the Letta conversation id scoped to (active agent, this Familiar
  // conversation). Returns undefined for legacy conversations created before
  // isolation shipped — Letta then falls back to the agent's shared thread
  // and the chat works as before (just without the privacy boundary).
  const activeLettaConvId: string | undefined = session.agentId
    ? conv?.conversationIds?.[session.agentId]
    : undefined;

  // Display name / avatar / colour for a member of the active conversation.
  // `null`/undefined or the primary's id falls back to the active-agent mirror
  // (so 1:1 chats and the primary in a group render exactly as before).
  function memberDisplay(agentId: string | null | undefined): { name: string; pic?: string; color?: string } {
    if (!agentId || agentId === session.agentId) {
      return {
        name: session.agent.name || session.agentName || "Agent",
        pic: session.agent.pic,
        color: conv?.colors?.[session.agentId ?? ""],
      };
    }
    const info = session.agents?.[agentId];
    return {
      name: info?.nameOverride || info?.name || "Agent",
      pic: info?.pic,
      color: conv?.colors?.[agentId],
    };
  }

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [typingAgentId, setTypingAgentId] = useState<string | null>(null);
  const cascadeAbortRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedSend, setFailedSend] = useState<{ text: string; images: string[]; placeholderId: string } | null>(null);
  const [editing, setEditing] = useState<"user" | "agent" | null>(null);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [oldestLettaId, setOldestLettaId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Reactions on messages (user-side for v1). Stored as a flat list of
  // (message_id, emoji, reactor) rows; the bubble renderer groups them.
  const [reactions, setReactions] = useState<bridge.Reaction[]>([]);
  const [reactingFor, setReactingFor] = useState<string | null>(null); // message id whose picker is open
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  // Pull recent agent-pushed media (voice notes + GIFs) and merge any new ones
  // into the timeline at their real timestamp (not appended to the end —
  // otherwise the bubble lands at the bottom on every load even when it's
  // chronologically older). Dedupes against what's already on screen, so it's
  // safe to call repeatedly (load, post-send, the 15s poll). Silent on failure.
  // Toggle a user reaction on a message. Optimistic — we flip local state
  // immediately, then reconcile with the server's authoritative response.
  async function toggleReaction(messageId: string, emoji: string) {
    if (!session.clientToken || !session.agentId) return;
    const reactor = "user";
    let wasAdded = false;
    setReactions((prev) => {
      const existing = prev.find(
        (r) => r.message_id === messageId && r.emoji === emoji && r.reactor === reactor,
      );
      if (existing) return prev.filter((r) => r !== existing);
      wasAdded = true;
      return [...prev, { message_id: messageId, emoji, reactor, created_at: Date.now() }];
    });
    try {
      await bridge.toggleReaction(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
        { messageId, emoji, reactor },
      );
    } catch (e) {
      console.warn("toggleReaction failed — reverting", e);
      try {
        const fresh = await bridge.listReactions(
          { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
          session.agentId,
        );
        setReactions(fresh);
      } catch {
        // give up; user can refresh
      }
      return;
    }
    // ── Visibility: tell the agent about the reaction by injecting a silent
    // [reaction] user_message into their Letta conversation. Lands in their
    // history; the system block tells them to read it but not reply. We
    // filter these out of the display in toDisplay so the user never sees
    // them as bubbles. Only fired on `added`, not removed (don't pester).
    if (!wasAdded) return;
    // Figure out whose message we just reacted to so we know which agent's
    // conversation to inject into. In a 1:1, it's the active agent. In a
    // group, the reacted message has a senderId we can trust (assistant
    // messages from members) — and for a user message reacted on, the agent
    // who SAW it gets the note (the active agent's group conv).
    const reactedMsg = messages.find((mm) => mm.id === messageId);
    const targetAgentId =
      reactedMsg?.who === "assistant" && reactedMsg.senderId
        ? reactedMsg.senderId
        : session.agentId;
    const targetConvId = conv?.conversationIds?.[targetAgentId];
    // Find the original text so the agent has context — truncate to keep the
    // injection cheap. Skip injection if we can't find the message at all.
    const snippet = reactedMsg?.text
      ? reactedMsg.text.replace(/\s+/g, " ").slice(0, 140)
      : "";
    const userName = session.user.name?.trim() || "the user";
    const note = snippet
      ? `[reaction] ${userName} reacted ${emoji} to your message: "${snippet}"`
      : `[reaction] ${userName} reacted ${emoji} to something you said.`;
    try {
      await sendMessage(
        { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
        targetAgentId,
        { text: note, conversationId: targetConvId },
      );
    } catch (err) {
      console.warn("reaction visibility injection failed (non-fatal)", err);
    }
  }

  // Pull fresh reactions list from the bridge. Called both on the 15s poll
  // and immediately after a send (so an agent that reacted via tool during
  // the turn shows up without a 15s wait).
  async function fetchReactions() {
    if (!session.clientToken || !session.agentId) return;
    try {
      const fresh = await bridge.listReactions(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
      );
      setReactions(fresh);
    } catch (e) {
      console.warn("fetchReactions failed", e);
    }
  }

  async function fetchMedia() {
    if (!session.clientToken || !session.agentId) return;
    try {
      const media = await bridge.getMediaMessages(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
      );
      if (media.length === 0) return;
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const fresh = media.filter((m) => !have.has(m.id));
        if (fresh.length === 0) return prev;
        const freshDisplay: DisplayMessage[] = fresh.map((m) =>
          m.kind === "gif"
            ? {
                id: m.id,
                who: "assistant",
                text: "",
                gif: { url: m.gif_url, caption: m.text || undefined },
                ts: new Date(m.created_at).toISOString(),
              }
            : {
                id: m.id,
                who: "assistant",
                text: m.text,
                audio: { url: m.audio_url, emotion: m.emotion },
                ts: new Date(m.created_at).toISOString(),
              },
        );
        // Stable sort by timestamp; messages without a ts (optimistic sends
        // mid-flight) sort to the end where they belong.
        return [...prev, ...freshDisplay].sort((a, b) => tsOf(a) - tsOf(b));
      });
    } catch (e) {
      console.warn("fetchMedia failed", e);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const list = await getMessages(
          { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
          session.agentId!,
          { limit: PAGE_SIZE, conversationId: activeLettaConvId },
        );
        if (!cancelled) {
          const display = toDisplay(list, groupCtx).map((d) =>
            d.who === "user" ? { ...d, text: stripLegacyStatusFromUserDisplay(d.text) } : d,
          );
          setMessages(display);
          const oldestRaw = list.find((m) => m.id);
          setOldestLettaId(oldestRaw?.id ?? null);
          setHasMore(list.length >= PAGE_SIZE);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (session.clientToken && !cancelled) {
        try {
          const state = await bridge.getState(
            { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
            session.agentId!,
          );
          if (!cancelled) onAgentStateRefresh(state);
        } catch (e) {
          console.warn("bridge.getState failed", e);
        }
        // Note: autonomous turns are part of regular conversation history (Letta
        // cron runs them through the same message pipeline), so they arrive via
        // getMessages above. The trigger text is filtered out in toDisplay.
        // Voice notes, though, live only in our D1 — pull them in:
        if (!cancelled) await fetchMedia();
        // Reactions too — they live in our D1 keyed by Letta message id.
        if (!cancelled) {
          try {
            const list = await bridge.listReactions(
              { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
              session.agentId!,
            );
            if (!cancelled) setReactions(list);
          } catch (e) {
            console.warn("listReactions failed", e);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.agentId, session.bridgeUrl, session.lettaKey, session.clientToken, historyReloadKey]);

  // Poll for new agent-pushed media (voice notes + GIFs) while the chat is open
  // — covers autonomous turns (no send() to piggyback on) and any delivery the
  // post-send fetch missed.
  useEffect(() => {
    if (!session.clientToken || !session.agentId) return;
    const id = setInterval(() => {
      void fetchMedia();
      void fetchReactions();
    }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.agentId, session.bridgeUrl, session.clientToken]);

  async function loadOlder() {
    if (!oldestLettaId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const container = scrollRef.current;
    const distFromBottom = container ? container.scrollHeight - container.scrollTop : 0;
    try {
      const older = await getMessages(
        { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
        session.agentId!,
        { limit: PAGE_SIZE, before: oldestLettaId, conversationId: activeLettaConvId },
      );
      const oldestRaw = older.find((m) => m.id);
      // Guard against a non-advancing cursor (Letta handing back the same /
      // overlapping batch): if the oldest id didn't move, stop paginating.
      if (older.length === 0 || (oldestRaw?.id && oldestRaw.id === oldestLettaId)) {
        setHasMore(false);
      } else {
        const olderDisplay = toDisplay(older, groupCtx).map((d) =>
          d.who === "user" ? { ...d, text: stripLegacyStatusFromUserDisplay(d.text) } : d,
        );
        // Dedupe against whatever's already on screen — never render the same
        // message twice (avoids duplicate React keys / glitchy renders if a
        // batch overlaps).
        setMessages((m) => {
          const have = new Set(m.map((x) => x.id));
          const fresh = olderDisplay.filter((d) => !have.has(d.id));
          return fresh.length > 0 ? [...fresh, ...m] : m;
        });
        if (oldestRaw?.id) setOldestLettaId(oldestRaw.id);
        setHasMore(older.length >= PAGE_SIZE);
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - distFromBottom;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  // Auto-scroll to the bottom only when a *new* message lands at the bottom
  // (or the typing indicator appears) — NOT when older messages are prepended
  // by "Load older messages" (that would yank the user back down and fight
  // loadOlder's scroll-position restore).
  const lastMsgIdRef = useRef<string | null>(null);
  useEffect(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastId = last ? last.id : null;
    const lastChanged = lastId !== lastMsgIdRef.current;
    lastMsgIdRef.current = lastId;
    if (lastChanged || sending) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
    // Keep the conversation-list row's preview current.
    if (lastChanged && last && onLastMessage) {
      const preview = last.audio ? "🎤 voice note" : last.gif ? "🖼 GIF" : last.text;
      onLastMessage(preview || "…", tsOf(last) === Number.MAX_SAFE_INTEGER ? Date.now() : tsOf(last));
    }
  }, [messages, sending, onLastMessage]);

  async function attachImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    setError(null);
    try {
      const dataUrl = await resizeImageFile(file, 1600, 0.82);
      setAttachedImages((imgs) => [...imgs, dataUrl]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = "";
      if (cameraRef.current) cameraRef.current.value = "";
    }
  }

  function removeAttachment(idx: number) {
    setAttachedImages((imgs) => imgs.filter((_, i) => i !== idx));
  }

  function attachGif(gifUrl: string) {
    setAttachedImages((imgs) => [...imgs, gifUrl]);
    setGifPickerOpen(false);
  }

  async function send(retryPayload?: { text: string; images: string[]; placeholderId: string }) {
    const text = retryPayload?.text ?? draft.trim();
    const images = retryPayload?.images ?? attachedImages;
    if ((!text && images.length === 0) || sending) return;
    setError(null);
    setFailedSend(null);
    if (!retryPayload) {
      setDraft("");
      setAttachedImages([]);
    }
    setSending(true);
    // Generate (or re-use, on retry) a short message id that's both the
    // optimistic bubble's React key AND the id baked into the Letta-side text
    // for the agent to address via react_to_message. Same value end to end.
    const placeholderId = retryPayload?.placeholderId ?? newShortMessageId();
    if (!retryPayload) {
      const userMsg: DisplayMessage = {
        id: placeholderId,
        who: "user",
        text,
        images: images.length > 0 ? images : undefined,
        ts: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
    }
    // ── Group room: run the turn-taking cascade instead of a single stream ──
    if (isGroup && conv) {
      const ac = new AbortController();
      cascadeAbortRef.current = ac;
      try {
        await runRoomCascade({
          conv,
          session,
          humanText: text,
          humanImages: images.length > 0 ? images : undefined,
          humanShortId: placeholderId,
          signal: ac.signal,
          cb: {
            onBubble: (b) =>
              setMessages((m) => [
                ...m,
                { id: b.id, who: b.senderId ? "assistant" : "user", senderId: b.senderId, text: b.text, ts: b.ts },
              ]),
            onTyping: (aid) => setTypingAgentId(aid),
            onError: (msg) => setError(msg),
          },
        });
        if (session.clientToken && session.agentId) {
          try {
            const state = await bridge.getState(
              { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
              session.agentId,
            );
            onAgentStateRefresh(state);
          } catch (e) {
            console.warn("bridge.getState (post-cascade) failed", e);
          }
          await fetchMedia(); // the primary may have sent a voice note / GIF
          await fetchReactions(); // …or called react_to_message
        }
      } catch (e) {
        console.error("[room-cascade] runRoomCascade threw", e);
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        cascadeAbortRef.current = null;
        setTypingAgentId(null);
        setSending(false);
      }
      return;
    }
    try {
      // Stream the agent's turn — tool calls and assistant messages arrive as
      // they happen. Keeps the connection alive (no 524s on long turns) and
      // makes the UI feel responsive instead of stalling on a typing bubble.
      const stream = streamMessage(
        { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
        session.agentId!,
        {
          text,
          imageDataUrls: images.length > 0 ? images : undefined,
          conversationId: activeLettaConvId,
          shortId: placeholderId,
        },
      );
      for await (const msg of stream) {
        const incremental = toDisplay([msg]);
        const newOnes = incremental.filter((d) => d.who !== "user");
        if (newOnes.length > 0) {
          setMessages((m) => [...m, ...newOnes]);
        }
      }
      if (session.clientToken) {
        try {
          const state = await bridge.getState(
            { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
            session.agentId!,
          );
          onAgentStateRefresh(state);
        } catch (e) {
          console.warn("bridge.getState (post-send) failed", e);
        }
        // Sam may have called send_voice_note or send_gif during this turn —
        // pull any new media in. Same for react_to_message → reactions.
        await fetchMedia();
        await fetchReactions();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Stash the payload so the user can retry with one tap.
      setFailedSend({ text, images, placeholderId });
    } finally {
      setSending(false);
    }
  }

  function retryFailed() {
    if (!failedSend) return;
    void send(failedSend);
  }

  function stopCascade() {
    cascadeAbortRef.current?.abort();
  }

  // Abort an in-flight room cascade if the conversation changes or we unmount.
  useEffect(() => {
    return () => cascadeAbortRef.current?.abort();
  }, [session.activeConversationId]);

  function dismissError() {
    setError(null);
    setFailedSend(null);
  }

  function reloadHistory() {
    setHistoryReloadKey((k) => k + 1);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header — two profile cards bracketing a quiet ⇄ switch */}
      <header className="border-b border-[var(--color-line)] bg-[var(--color-base)]/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2.5">
        <div className="flex-1 min-w-0">
          <ProfileCard
            profile={isGroup ? { name: conv?.name || "Group" } : session.agent}
            fallbackName={isGroup ? "Group" : session.agentName}
            align="left"
            pulsing={sending}
            presence={isGroup ? undefined : session.agentPresence}
            onClick={() => {
              if (!isGroup) setEditing("agent");
            }}
          />
          {isGroup && conv && (
            <div className="text-[10.5px] text-ink-faint truncate -mt-0.5 ml-1">
              {conv.memberIds
                .map((id) => session.agents?.[id]?.nameOverride || session.agents?.[id]?.name || "agent")
                .join(" · ")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onSwitchAgent}
            className="text-ink-faint hover:text-ink-muted active:scale-95 transition-all duration-200 p-1.5 rounded-md"
            title="Back to conversations"
            aria-label="Back to conversations"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={onOpenSettings}
            className="text-ink-faint hover:text-ink-muted active:scale-95 transition-all duration-200 p-1.5 rounded-md"
            title="Settings"
            aria-label="Open settings"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-[18px] h-[18px]"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-w-0 flex justify-end">
          <div className="min-w-0 max-w-full">
            <ProfileCard
              profile={session.user}
              fallbackName="You"
              align="right"
              presence={session.userPresence}
              onClick={() => setEditing("user")}
            />
          </div>
        </div>
        </div>
      </header>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-6 space-y-3">
        {loading && <SkeletonHistory />}
        {!loading && loadError && (
          <div className="flex justify-center pt-2 pb-4">
            <div className="flex items-center gap-3 text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">
              <span>Couldn't load chat history</span>
              <button
                onClick={reloadHistory}
                className="text-[11px] font-medium text-red-200 hover:text-red-100 underline decoration-red-300/40 underline-offset-2"
              >
                Refresh
              </button>
            </div>
          </div>
        )}
        {!loading && hasMore && (
          <div className="flex justify-center pb-2">
            <button
              onClick={loadOlder}
              disabled={loadingMore}
              className="text-[11px] text-ink-dim hover:text-ink-muted disabled:opacity-40 px-3 py-1.5 rounded-full border border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-line)] transition-all duration-200"
            >
              {loadingMore ? "loading…" : "Load older messages"}
            </button>
          </div>
        )}
        {!loading && messages.length === 0 && <EmptyState />}
        {messages.map((m) => {
          if (m.who === "tool") {
            if (m.error) {
              return (
                <div
                  key={m.id}
                  className="flex justify-center"
                  style={{ animation: "familiar-fade-up 220ms ease-out both" }}
                >
                  <span className="text-[11px] text-red-300/90 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1 max-w-[85%]">
                    couldn't complete that — {m.text}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={m.id}
                className="flex justify-center"
                style={{ animation: "familiar-fade-up 220ms ease-out both" }}
              >
                <span className="text-[10.5px] tracking-wide italic text-ink-faint px-2 py-0.5">
                  · {m.text} ·
                </span>
              </div>
            );
          }
          const isUser = m.who === "user";
          const disp = isUser ? null : memberDisplay(m.senderId);
          const avatarName = isUser ? session.user.name || "You" : disp?.name || session.agentName || "Agent";
          const avatarPic = isUser ? session.user.pic : disp?.pic;
          const msgReactions = reactions.filter((r) => r.message_id === m.id);
          // Group reactions by emoji → count + did-user-react (for highlight).
          const grouped = new Map<string, { count: number; mine: boolean }>();
          for (const r of msgReactions) {
            const g = grouped.get(r.emoji) ?? { count: 0, mine: false };
            g.count++;
            if (r.reactor === "user") g.mine = true;
            grouped.set(r.emoji, g);
          }
          const pickerOpen = reactingFor === m.id;
          return (
            <div
              key={m.id}
              className={`flex items-end gap-2 group/bubble ${isUser ? "justify-end" : "justify-start"}`}
              style={{ animation: "familiar-fade-up 220ms ease-out both" }}
            >
              {!isUser && (
                <Avatar name={avatarName} pic={avatarPic} size={28} />
              )}
              <div
                className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
                style={{ maxWidth: "min(72%, 640px)" }}
              >
                <div className={`relative flex items-center gap-1.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
                  <div
                    className={`text-[14px] leading-relaxed whitespace-pre-wrap shadow-warm overflow-hidden ${
                      isUser
                        ? "rounded-2xl rounded-br-sm bg-[var(--color-bubble-user)] text-[var(--color-bubble-user-ink)]"
                        : "rounded-2xl rounded-bl-sm bg-[var(--color-bubble-agent)] text-[var(--color-bubble-agent-ink)] border border-[var(--color-line)]"
                    }`}
                    style={!isUser && disp?.color ? { background: disp.color } : undefined}
                  >
                    {isGroup && !isUser && (
                      <div className="px-4 pt-1.5 text-[10.5px] font-medium text-ink-faint">{disp?.name}</div>
                    )}
                    {m.images && m.images.length > 0 && (
                      <div
                        className={`flex flex-col gap-1 ${m.text || m.audio ? "pb-1" : ""}`}
                      >
                        {m.images.map((src, i) => (
                          <img
                            key={i}
                            src={src}
                            alt=""
                            className="block max-w-full max-h-[400px] object-cover"
                            loading="lazy"
                          />
                        ))}
                      </div>
                    )}
                    {m.audio && (
                      <div className="px-3 py-2.5">
                        <AudioPlayer src={m.audio.url} emotion={m.audio.emotion} caption={m.text} />
                      </div>
                    )}
                    {m.gif && (
                      <div>
                        <img
                          src={m.gif.url}
                          alt={m.gif.caption || "GIF"}
                          className="block max-w-full max-h-[360px] object-cover"
                          loading="lazy"
                        />
                        {m.gif.caption && (
                          <div className="px-4 py-2 text-[14px]">{m.gif.caption}</div>
                        )}
                      </div>
                    )}
                    {m.text && !m.audio && !m.gif && (
                      <div className={`px-4 py-2 ${isGroup && !isUser ? "pt-0.5" : ""}`}>{m.text}</div>
                    )}
                  </div>
                  {/* React button — hover-reveal, sits beside the bubble. Tap
                      to open the emoji popover. */}
                  <button
                    onClick={() => setReactingFor(pickerOpen ? null : m.id)}
                    aria-label="Add reaction"
                    title="Add reaction"
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-ink-faint hover:text-ink hover:bg-[var(--color-line)] transition-all duration-200 ${
                      pickerOpen ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100 focus:opacity-100"
                    }`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px]">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      <line x1="9" y1="9" x2="9.01" y2="9" />
                      <line x1="15" y1="9" x2="15.01" y2="9" />
                      <path d="M19 4v4M21 6h-4" />
                    </svg>
                  </button>
                  {pickerOpen && (
                    <>
                      <button
                        onClick={() => setReactingFor(null)}
                        aria-label="Close reaction picker"
                        className="fixed inset-0 z-10 cursor-default"
                      />
                      <div
                        className={`absolute z-20 bottom-full mb-1 flex gap-0.5 rounded-full border border-[var(--color-line-strong)] bg-[var(--color-overlay)] shadow-warm-lg p-1 backdrop-blur-md ${
                          isUser ? "right-0" : "left-0"
                        }`}
                      >
                        {REACTION_PICKS.map((e) => (
                          <button
                            key={e}
                            onClick={() => {
                              setReactingFor(null);
                              void toggleReaction(m.id, e);
                            }}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-[18px] hover:bg-[var(--color-line)] hover:scale-110 transition-all duration-150 active:scale-95"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {/* Reaction chips under the bubble. Tap to toggle off. */}
                {grouped.size > 0 && (
                  <div className={`flex flex-wrap gap-1 ${isUser ? "justify-end" : "justify-start"}`}>
                    {Array.from(grouped.entries()).map(([emoji, { count, mine }]) => (
                      <button
                        key={emoji}
                        onClick={() => void toggleReaction(m.id, emoji)}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] border transition-all duration-150 active:scale-95 ${
                          mine
                            ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)]/40 text-ink"
                            : "bg-[var(--color-raised)] border-[var(--color-line)] text-ink-muted hover:border-[var(--color-line-strong)]"
                        }`}
                      >
                        <span>{emoji}</span>
                        {count > 1 && <span className="text-[11px] tabular">{count}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isUser && (
                <Avatar name={avatarName} pic={avatarPic} size={28} />
              )}
            </div>
          );
        })}
        {sending && (() => {
          const td = memberDisplay(typingAgentId);
          return (
            <div className="flex items-end gap-2 justify-start">
              <Avatar name={td.name || session.agentName || "Agent"} pic={td.pic} size={28} pulsing />
              <div
                className="rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-[var(--color-bubble-agent)] border border-[var(--color-line)]"
                style={td.color ? { background: td.color } : undefined}
              >
                {isGroup && <span className="block text-[10px] text-ink-faint mb-1">{td.name}</span>}
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-[familiar-pulse_1.4s_ease-in-out_infinite]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-[familiar-pulse_1.4s_ease-in-out_0.2s_infinite]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-[familiar-pulse_1.4s_ease-in-out_0.4s_infinite]" />
                </span>
              </div>
              {isGroup && (
                <button
                  onClick={stopCascade}
                  className="self-center text-[11px] text-ink-faint hover:text-ink-muted underline decoration-dotted underline-offset-2 px-2"
                  title="Stop the room"
                >
                  stop
                </button>
              )}
            </div>
          );
        })()}
        {error && (
          <div className="flex justify-center">
            <div className="flex items-center gap-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded-md max-w-[85%]">
              <span className="truncate">{error}</span>
              {failedSend && (
                <button
                  onClick={retryFailed}
                  disabled={sending}
                  className="shrink-0 text-[11px] font-medium text-red-200 hover:text-red-100 underline decoration-red-300/40 underline-offset-2 disabled:opacity-50"
                >
                  Retry
                </button>
              )}
              <button
                onClick={dismissError}
                className="shrink-0 text-red-300 hover:text-red-200 opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--color-line)] px-3 py-3 bg-[var(--color-base)]/80 backdrop-blur-md relative">
        {gifPickerOpen && session.clientToken && session.agentId && (
          <GifPicker
            bridgeUrl={session.bridgeUrl}
            clientToken={session.clientToken}
            agentId={session.agentId}
            onPick={attachGif}
            onClose={() => setGifPickerOpen(false)}
          />
        )}
        {attachedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-2">
            {attachedImages.map((src, i) => (
              <div key={i} className="relative">
                <img
                  src={src}
                  alt=""
                  className="w-16 h-16 rounded-lg object-cover border border-[var(--color-line-strong)]"
                />
                <button
                  onClick={() => removeAttachment(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 hover:bg-black/90 backdrop-blur-sm flex items-center justify-center text-ink text-[10px]"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* Attach menu — single + button, opens a small popover with the
              three options (gallery / camera / GIF). Keeps the composer row
              tight; one icon instead of three. */}
          <div className="relative shrink-0">
            <button
              onClick={() => setAttachMenuOpen((v) => !v)}
              disabled={sending || attaching}
              className={`w-[42px] h-[42px] rounded-full flex items-center justify-center text-ink-muted hover:text-ink hover:bg-[var(--color-line)] disabled:opacity-40 transition-all duration-200 active:scale-95 ${
                attachMenuOpen ? "bg-[var(--color-line)] text-ink rotate-45" : ""
              }`}
              aria-label="Attach"
              title="Attach"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[20px] h-[20px] transition-transform duration-200"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {attachMenuOpen && (
              <>
                {/* Backdrop catches outside-clicks */}
                <button
                  onClick={() => setAttachMenuOpen(false)}
                  aria-label="Close attach menu"
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div className="absolute bottom-[52px] left-0 z-20 min-w-[180px] rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-overlay)] shadow-warm-lg p-1 backdrop-blur-md">
                  <button
                    onClick={() => {
                      setAttachMenuOpen(false);
                      fileRef.current?.click();
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-ink hover:bg-[var(--color-line)] transition-colors text-left"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-[16px] h-[16px] text-ink-muted">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                    Photo or file
                  </button>
                  <button
                    onClick={() => {
                      setAttachMenuOpen(false);
                      cameraRef.current?.click();
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-ink hover:bg-[var(--color-line)] transition-colors text-left"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-[16px] h-[16px] text-ink-muted">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                    Take photo
                  </button>
                  <button
                    onClick={() => {
                      setAttachMenuOpen(false);
                      setGifPickerOpen(true);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-ink hover:bg-[var(--color-line)] transition-colors text-left"
                  >
                    <span className="inline-flex items-center justify-center w-[16px] h-[16px] rounded-[3px] border border-current text-[8px] font-bold text-ink-muted">
                      GIF
                    </span>
                    GIF
                  </button>
                </div>
              </>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={attachImage}
          />
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={attachImage}
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={attaching ? "preparing image…" : "type a message…"}
            disabled={sending}
            rows={1}
            className="flex-1 resize-none rounded-2xl bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-4 py-2.5 text-[14px] text-ink placeholder:text-ink-faint transition-colors duration-200 max-h-32"
            style={{ minHeight: "42px" }}
          />
          <button
            onClick={() => void send()}
            disabled={sending || (!draft.trim() && attachedImages.length === 0)}
            className="rounded-full w-[42px] h-[42px] flex items-center justify-center bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:bg-[var(--color-line-strong)] disabled:text-ink-faint text-[var(--color-bubble-user-ink)] transition-all duration-200 active:scale-95 shadow-warm shrink-0"
            aria-label="Send"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {editing === "user" && (
        <ProfileEditor
          side="user"
          profile={session.user}
          presence={session.userPresence}
          onSave={onUserProfileChange}
          onPresenceChange={onUserPresenceChange}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "agent" && (
        <ProfileEditor
          side="agent"
          profile={session.agent}
          canonicalName={session.agentName}
          presence={session.agentPresence}
          onSave={onAgentProfileChange}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SkeletonHistory() {
  return (
    <div className="space-y-3 pt-2">
      {[
        { side: "left", width: "60%" },
        { side: "right", width: "45%" },
        { side: "left", width: "75%" },
        { side: "right", width: "35%" },
        { side: "left", width: "55%" },
      ].map((s, i) => (
        <div
          key={i}
          className={`flex items-end gap-2 ${s.side === "right" ? "justify-end" : "justify-start"}`}
        >
          {s.side === "left" && <div className="skeleton w-7 h-7 rounded-full" />}
          <div
            className="skeleton h-9"
            style={{ width: s.width, maxWidth: "72%" }}
          />
          {s.side === "right" && <div className="skeleton w-7 h-7 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <div className="w-12 h-12 rounded-full bg-[var(--color-accent-soft)] flex items-center justify-center mb-3">
        <span className="text-xl">·</span>
      </div>
      <p className="text-[13px] text-ink-muted">
        No messages yet.
      </p>
      <p className="text-[12px] text-ink-faint mt-1">
        Say hi when you're ready.
      </p>
    </div>
  );
}
