// Lifted from Letta's API surface. Kept narrow — extend as we use more fields.

export interface LettaAgent {
  id: string;
  name: string;
  agent_type?: string;
  created_at?: string;
  updated_at?: string;
  last_run_completion?: string | null;
}

// Multimodal content parts for messages.create. Letta uses Anthropic-style
// image shape (NOT OpenAI's image_url) — verified against their messages
// create API which 422s on the OpenAI form.
export type LettaImageSource =
  | { type: "url"; url: string }
  | { type: "base64"; data: string; media_type: string };

export type LettaContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: LettaImageSource };

export type LettaMessageContent = string | LettaContentPart[];

// Letta returns an array of typed messages. We only render a subset of types.
export type LettaMessageType =
  | "user_message"
  | "assistant_message"
  | "system_message"
  | "reasoning_message"
  | "tool_call_message"
  | "tool_return_message"
  // Streaming control / error events Letta emits on the SSE channel.
  | "ping"
  | "stop_reason"
  | "error_message"
  | "usage_statistics";

export interface LettaMessage {
  id?: string;
  message_type: LettaMessageType;
  // Either a plain string (legacy) or a content-parts array (multimodal).
  content?: string | LettaContentPart[];
  text?: string;
  date?: string;
  created_at?: string;
  name?: string;
  // Tool call shape (Letta exposes these fields when message_type is tool_call_message).
  tool_call?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  // Tool return shape (message_type === "tool_return_message"). `status` is
  // "success" | "error"; `tool_return` is the stringified result. Some Letta
  // versions also echo the originating tool name here.
  tool_return?: string;
  status?: "success" | "error" | string;
  tool_call_id?: string;
  // Reasoning messages have a string `reasoning` or fall back to text/content.
  reasoning?: string;
}

export interface UserStatus {
  text: string;
  emoji?: string;
  setAt: number;
}

export interface Profile {
  name: string;
  pic?: string; // data URL or empty for initials fallback
  status?: UserStatus;
}

export interface Appearance {
  bubbleUserHex?: string;     // "#c97f4f"
  bubbleUserAlpha?: number;   // 0..1
  bubbleAgentHex?: string;
  bubbleAgentAlpha?: number;
  backgroundPreset?: string;  // id of preset, "custom", or undefined for default
  backgroundCustomDataUrl?: string; // when backgroundPreset === "custom"
  backgroundBlur?: number;    // 0..30
}

// Per-agent details, keyed by Letta agent id. An agent can belong to several
// conversations, so this stuff (bridge token, presence, display overrides)
// lives once here, not per-conversation.
export interface AgentInfo {
  name: string;          // canonical name from Letta
  clientToken?: string;  // bridge-side auth for this agent's state API
  presence?: string;     // synced via bridge
  statusText?: string;
  statusEmoji?: string;
  pic?: string;          // display avatar (data URL), user-set
  nameOverride?: string; // display-name override, user-set
}

// A conversation in the list. `kind: "direct"` = a 1:1 with one agent (a thin
// wrapper). `kind: "group"` = a room with several agents (Phase 2).
export interface Conversation {
  id: string;
  kind: "direct" | "group";
  name: string;                       // display name; for direct, the agent's name
  memberIds: string[];                // Letta agent ids in this conversation
  primaryId: string;                  // who answers by default (direct = the one member)
  colors?: Record<string, string>;    // per-member bubble color override (group)
  lastPreview?: string;               // last message text, for the list row
  lastAt?: number;                    // ms timestamp of the last message
  createdAt: number;
  // Per-member Letta conversation id. Each (member agent, Familiar
  // conversation) pair gets its own Letta conversation so 1:1 history and
  // group history don't bleed into the same agent thread. Agent identity +
  // memory blocks stay shared across all conversations on the agent.
  // Lazily populated for conversations created before isolation shipped.
  conversationIds?: Record<string, string>;
}

export interface Session {
  bridgeUrl: string;
  lettaKey: string;
  user: Profile;
  userPresence?: string; // synced via bridge
  appearance?: Appearance;
  // Conversation list + the agents that appear in them. activeConversationId
  // is the open one (undefined = showing the list).
  agents?: Record<string, AgentInfo>;
  conversations?: Conversation[];
  activeConversationId?: string;
  // ─── Legacy "active agent" mirror ───────────────────────────────────────────
  // These mirror the active conversation's PRIMARY agent so ChatPage (and the
  // per-agent setup effects) keep working unchanged. Re-pointed on every
  // conversation switch from the `agents` registry; written back to the
  // registry when they change.
  agentId?: string;
  agentName?: string;
  agent: Profile;        // display override (pic, name) for the active agent
  clientToken?: string;
  agentPresence?: string;
  // Autonomous check-ins for the active agent — schedule id (so we can
  // delete/recreate when frequency changes); dnd_until silences the agent
  // during its autonomous turns, written into the user_state block.
  autonomousScheduleId?: string;
  autonomousFrequencyMinutes?: number | null;
  dndUntil?: number | null;
}
