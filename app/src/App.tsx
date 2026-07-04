import { useEffect, useState } from "react";
import LoginPage from "./components/LoginPage";
import ChatPage from "./components/ChatPage";
import SettingsPage from "./components/SettingsPage";
import ConversationListPage from "./components/ConversationListPage";
import * as bridge from "./api/bridge";
import * as letta from "./api/letta";
import { applyAppearance } from "./lib/appearance";
import {
  formatUserStateBlock,
  FAMILIAR_INTEGRATION_BLOCK,
  FAMILIAR_INTEGRATION_OPEN_RE,
  FAMILIAR_INTEGRATION_VERSION,
  USER_STATE_BLOCK_LABEL,
} from "./lib/userState";
import type { AgentInfo, Appearance, Conversation, Profile, Session } from "./types";

const STORAGE_KEY = "familiar.session.v1";

type View = "chat" | "settings";

function defaultProfile(name: string): Profile {
  return { name };
}

function genId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Build a Session from whatever's in localStorage. Handles the pre-conversations
// shape (a single `agentId`) by promoting it to a direct conversation.
function migrate(raw: unknown): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<Session> & { userStatus?: Session["user"]["status"] };
  if (!s.lettaKey || !s.bridgeUrl) return null;
  const user = s.user ?? defaultProfile("You");
  if (!user.status && s.userStatus) user.status = s.userStatus;

  let agents: Record<string, AgentInfo> = s.agents ?? {};
  let conversations: Conversation[] = s.conversations ?? [];
  let activeConversationId = s.activeConversationId;

  // Pre-conversations session: one agent, no conversations array. Promote it.
  if (conversations.length === 0 && s.agentId) {
    const aid = s.agentId;
    const canonical = s.agentName ?? s.agent?.name ?? "Agent";
    agents = {
      [aid]: {
        name: canonical,
        clientToken: s.clientToken,
        presence: s.agentPresence,
        statusText: s.agent?.status?.text,
        statusEmoji: s.agent?.status?.emoji,
        pic: s.agent?.pic,
        nameOverride: s.agent?.name && s.agent.name !== canonical ? s.agent.name : undefined,
      },
    };
    const conv: Conversation = {
      id: genId(),
      kind: "direct",
      name: s.agent?.name || canonical,
      memberIds: [aid],
      primaryId: aid,
      createdAt: Date.now(),
    };
    conversations = [conv];
    activeConversationId = conv.id;
  }

  return {
    bridgeUrl: s.bridgeUrl,
    lettaKey: s.lettaKey,
    user,
    userPresence: s.userPresence,
    appearance: s.appearance,
    agents,
    conversations,
    activeConversationId,
    agentId: s.agentId,
    agentName: s.agentName,
    agent: s.agent ?? defaultProfile(s.agentName ?? "Agent"),
    clientToken: s.clientToken,
    agentPresence: s.agentPresence,
    autonomousScheduleId: s.autonomousScheduleId,
    autonomousFrequencyMinutes: s.autonomousFrequencyMinutes,
    dndUntil: s.dndUntil,
  };
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSession(s: Session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (err) {
    // QuotaExceededError, SecurityError (private mode), etc. — without this,
    // the failure was silent and a too-large avatar (or any other oversized
    // field) would just refuse to persist. Loud now: console + visible alert.
    console.error("saveSession failed — session NOT persisted", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (typeof window !== "undefined") {
      window.alert(
        `Couldn't save your session: ${msg}\n\nThis usually means one of your profile pictures is too large. Try a smaller image, or clear the offending one.`,
      );
    }
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

// Re-point the "active agent" mirror fields at a conversation's primary agent,
// pulling per-agent details from the registry. ChatPage (and the per-agent
// setup effects) read these mirror fields, so this is how a conversation switch
// takes effect.
function activate(session: Session, conv: Conversation): Session {
  const info = session.agents?.[conv.primaryId];
  const canonical = info?.name ?? conv.name ?? "Agent";
  const agentProfile: Profile = {
    name: info?.nameOverride ?? canonical,
    pic: info?.pic,
    status: info?.statusText
      ? { text: info.statusText, emoji: info.statusEmoji, setAt: Date.now() }
      : undefined,
  };
  return {
    ...session,
    activeConversationId: conv.id,
    agentId: conv.primaryId,
    agentName: canonical,
    agent: agentProfile,
    clientToken: info?.clientToken,
    agentPresence: info?.presence,
  };
}

// Write the active agent's mirror fields back into the registry so they persist
// across conversation switches.
function syncRegistry(session: Session): Session {
  if (!session.agentId) return session;
  const id = session.agentId;
  const prev = session.agents?.[id] ?? { name: session.agentName ?? "Agent" };
  const updated: AgentInfo = {
    ...prev,
    name: session.agentName ?? prev.name,
    clientToken: session.clientToken ?? prev.clientToken,
    presence: session.agentPresence ?? prev.presence,
    statusText: session.agent.status?.text,
    statusEmoji: session.agent.status?.emoji,
    pic: session.agent.pic,
    nameOverride:
      session.agent.name && session.agent.name !== (session.agentName ?? prev.name)
        ? session.agent.name
        : undefined,
  };
  return { ...session, agents: { ...session.agents, [id]: updated } };
}

async function setupAgent(bridgeUrl: string, lettaKey: string, agentId: string): Promise<string> {
  const init = await bridge.initAgent({ bridgeUrl }, agentId);
  const callOpts = { bridgeUrl, lettaKey };
  const serverName = `familiar-${agentId.slice(0, 8)}`;
  let mcpServerId: string | null = null;
  try {
    const existing = await letta.listMcpServers(callOpts);
    const found = existing.find((s) => s.server_name === serverName);
    if (found) mcpServerId = found.id;
  } catch (err) {
    console.warn("listMcpServers failed (non-fatal)", err);
  }
  if (!mcpServerId) {
    try {
      const registered = await letta.registerMcpServer(callOpts, serverName, init.mcp_url);
      mcpServerId = registered.id;
    } catch (err) {
      console.warn("registerMcpServer failed", err);
    }
  }
  if (mcpServerId) {
    try {
      const tools = await letta.listMcpTools(callOpts, mcpServerId);
      const ids = tools.map((t) => t.id).filter(Boolean);
      if (ids.length > 0) {
        await letta.attachToolsToAgent(callOpts, agentId, ids);
      }
    } catch (err) {
      console.warn("attachToolsToAgent failed", err);
    }
  }
  return init.client_token;
}

// Push the user_state block to the agent so it's always in core memory.
// Idempotent — safe to call on every status/presence change.
async function syncUserStateBlock(
  callOpts: { bridgeUrl: string; lettaKey: string },
  agentId: string,
  user: Profile,
  presence: string | undefined,
  dndUntil?: number | null,
): Promise<void> {
  const value = formatUserStateBlock({ user, presence, dndUntil });
  const description =
    "Maintained automatically by the chat app. Always reflects the user's current self-reported status (mood/activity), presence (online/away/asleep), and any do-not-disturb window. Read this on every turn — especially during autonomous check-ins — to decide whether to break silence.";
  try {
    await letta.ensureBlock(callOpts, agentId, USER_STATE_BLOCK_LABEL, value, description);
  } catch (err) {
    console.warn("syncUserStateBlock failed (non-fatal)", err);
  }
}

// Ensure Familiar's integration block is in the agent's system instructions
// at the current version. If an older version is present, REPLACE it in place
// rather than appending — keeps the block from accumulating across upgrades.
// Idempotent and safe to run on every session restore.
async function ensureSystemInstructions(
  callOpts: { bridgeUrl: string; lettaKey: string },
  agentId: string,
): Promise<void> {
  try {
    const agent = await letta.getAgent(callOpts, agentId);
    const current = agent.system ?? "";
    const versionTag = `version="${FAMILIAR_INTEGRATION_VERSION}"`;
    if (current.includes(versionTag)) return;
    let next: string;
    if (FAMILIAR_INTEGRATION_OPEN_RE.test(current)) {
      next = current.replace(FAMILIAR_INTEGRATION_OPEN_RE, FAMILIAR_INTEGRATION_BLOCK);
    } else {
      next = current.trimEnd() + "\n\n" + FAMILIAR_INTEGRATION_BLOCK + "\n";
    }
    await letta.updateAgentSystem(callOpts, agentId, next);
  } catch (err) {
    console.warn("ensureSystemInstructions failed (non-fatal)", err);
  }
}

// Re-sync MCP tools to the agent (new tools we've shipped + updated tool
// descriptions). Refreshes the server first so Letta re-reads our tool list,
// then attaches. Idempotent.
async function ensureLatestTools(
  callOpts: { bridgeUrl: string; lettaKey: string },
  agentId: string,
): Promise<void> {
  try {
    const serverName = `familiar-${agentId.slice(0, 8)}`;
    const servers = await letta.listMcpServers(callOpts);
    const server = servers.find((s) => s.server_name === serverName);
    if (!server) return; // setupAgent will handle initial registration
    try {
      await letta.refreshMcpServer(callOpts, server.id);
    } catch (err) {
      console.warn("refreshMcpServer failed (non-fatal)", err);
    }
    const tools = await letta.listMcpTools(callOpts, server.id);
    const ids = tools.map((t) => t.id).filter(Boolean);
    if (ids.length > 0) {
      await letta.attachToolsToAgent(callOpts, agentId, ids);
    }
  } catch (err) {
    console.warn("ensureLatestTools failed (non-fatal)", err);
  }
}

export default function App() {
  const bridgeUrl = import.meta.env.VITE_BRIDGE_URL ?? "http://localhost:8787";
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [setupBusy, setSetupBusy] = useState(false);
  const [view, setView] = useState<View>("chat");

  useEffect(() => {
    applyAppearance(session?.appearance);
  }, [session?.appearance]);

  useEffect(() => {
    if (session && session.bridgeUrl !== bridgeUrl) {
      const updated = { ...session, bridgeUrl };
      setSession(updated);
      saveSession(updated);
    }
  }, [bridgeUrl, session]);

  // Per-agent setup for whichever agent is currently active: user_state block,
  // Familiar system instructions, latest MCP tools, client-token backfill.
  // Re-runs on conversation switch (the active agentId changes).
  useEffect(() => {
    if (!session?.agentId || !session.lettaKey) return;
    const callOpts = { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey };
    void syncUserStateBlock(callOpts, session.agentId, session.user, session.userPresence, session.dndUntil);
    void ensureSystemInstructions(callOpts, session.agentId);
    void ensureLatestTools(callOpts, session.agentId);
    // If the open conversation is a group, keep the *other* members current too
    // (latest tools incl. room_turn, latest system block) — not just the primary.
    const activeConv = session.conversations?.find((c) => c.id === session.activeConversationId);
    if (activeConv?.kind === "group") {
      for (const mid of activeConv.memberIds) {
        if (mid === session.agentId) continue;
        void ensureSystemInstructions(callOpts, mid);
        void ensureLatestTools(callOpts, mid);
        void syncUserStateBlock(callOpts, mid, session.user, session.userPresence, session.dndUntil);
      }
    }
    if (!session.clientToken) {
      const aid = session.agentId;
      void bridge
        .initAgent({ bridgeUrl: session.bridgeUrl }, aid)
        .then((init) => {
          setSession((prev) => {
            if (!prev || prev.agentId !== aid || prev.clientToken === init.client_token) return prev;
            const next = syncRegistry({ ...prev, clientToken: init.client_token });
            saveSession(next);
            return next;
          });
        })
        .catch((err) => console.warn("clientToken backfill failed", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.agentId]);

  function handleLoginWithKey(key: string) {
    const next: Session = {
      bridgeUrl,
      lettaKey: key,
      user: defaultProfile("You"),
      agent: defaultProfile("Agent"),
      agents: {},
      conversations: [],
    };
    saveSession(next);
    setSession(next);
  }

  // Start a new direct conversation with an agent (creates the conversation,
  // runs one-time agent setup if this agent is new to us, opens it).
  async function handleStartConversation(agentId: string, agentName: string) {
    if (!session) return;
    const known = Boolean(session.agents?.[agentId]);
    let clientToken: string | undefined = session.agents?.[agentId]?.clientToken;
    if (!known || !clientToken) {
      setSetupBusy(true);
      try {
        clientToken = await setupAgent(bridgeUrl, session.lettaKey, agentId);
      } catch (err) {
        console.error("setupAgent failed", err);
      }
      const setupCallOpts = { bridgeUrl, lettaKey: session.lettaKey };
      await syncUserStateBlock(setupCallOpts, agentId, session.user, session.userPresence, session.dndUntil);
      await ensureSystemInstructions(setupCallOpts, agentId);
      if (clientToken && session.user.status) {
        try {
          await bridge.postUserState({ bridgeUrl, clientToken }, agentId, {
            status_text: session.user.status.text,
            status_emoji: session.user.status.emoji ?? null,
            presence: session.userPresence ?? null,
          });
        } catch (err) {
          console.warn("initial user state push failed (non-fatal)", err);
        }
      }
      setSetupBusy(false);
    }
    // Create a Letta conversation scoped to this Familiar conversation so the
    // agent's 1:1 history with us doesn't share a thread with any future
    // groups/other 1:1s on the same agent. Identity stays via shared memory
    // blocks, history stays scoped here. Failure is non-fatal — we fall back
    // to legacy shared-thread mode if Letta is unreachable.
    const conversationIds: Record<string, string> = {};
    try {
      const lettaConv = await letta.createConversation(
        { bridgeUrl, lettaKey: session.lettaKey },
        agentId,
      );
      conversationIds[agentId] = lettaConv.id;
    } catch (err) {
      console.warn("createConversation (direct) failed — falling back to shared thread", err);
    }
    const conv: Conversation = {
      id: genId(),
      kind: "direct",
      name: agentName,
      memberIds: [agentId],
      primaryId: agentId,
      createdAt: Date.now(),
      conversationIds: Object.keys(conversationIds).length > 0 ? conversationIds : undefined,
    };
    const agents: Record<string, AgentInfo> = {
      ...session.agents,
      [agentId]: { ...(session.agents?.[agentId] ?? { name: agentName }), name: agentName, clientToken },
    };
    const conversations = [...(session.conversations ?? []), conv];
    const next = activate({ ...session, agents, conversations }, conv);
    saveSession(next);
    setSession(next);
    setView("chat");
  }

  // Start a new GROUP conversation with several agents. Runs one-time setup for
  // any that are new to us, then creates the room with the first picked agent as
  // primary (the one who answers the human directly; the rest get room_turn
  // decide-prompts via the cascade).
  async function handleStartGroupConversation(members: Array<{ id: string; name: string }>, groupName?: string) {
    if (!session || members.length < 2) return;
    setSetupBusy(true);
    const agents: Record<string, AgentInfo> = { ...session.agents };
    for (const m of members) {
      let clientToken: string | undefined = agents[m.id]?.clientToken;
      if (!agents[m.id] || !clientToken) {
        try {
          clientToken = await setupAgent(bridgeUrl, session.lettaKey, m.id);
        } catch (err) {
          console.error("setupAgent (group member) failed", err);
        }
        const setupCallOpts = { bridgeUrl, lettaKey: session.lettaKey };
        await syncUserStateBlock(setupCallOpts, m.id, session.user, session.userPresence, session.dndUntil);
        await ensureSystemInstructions(setupCallOpts, m.id);
      } else {
        // Known agent — still make sure it has the latest tools (room_turn) and
        // the room-aware v5 system block.
        const callOpts = { bridgeUrl, lettaKey: session.lettaKey };
        await ensureSystemInstructions(callOpts, m.id);
        await ensureLatestTools(callOpts, m.id);
      }
      agents[m.id] = { ...(agents[m.id] ?? { name: m.name }), name: m.name, clientToken };
    }
    // Per-member Letta conversation: each member sees this group as its own
    // scoped thread. Sam-in-group and Sam-in-1:1 read from different threads
    // server-side; memory blocks stay shared on the agent so identity persists.
    const conversationIds: Record<string, string> = {};
    for (const m of members) {
      try {
        const lettaConv = await letta.createConversation(
          { bridgeUrl, lettaKey: session.lettaKey },
          m.id,
        );
        conversationIds[m.id] = lettaConv.id;
      } catch (err) {
        console.warn(`createConversation (group, ${m.name}) failed — falling back to shared thread`, err);
      }
    }
    setSetupBusy(false);
    const conv: Conversation = {
      id: genId(),
      kind: "group",
      name: groupName?.trim() || members.map((m) => m.name).join(", "),
      memberIds: members.map((m) => m.id),
      primaryId: members[0].id,
      createdAt: Date.now(),
      conversationIds: Object.keys(conversationIds).length > 0 ? conversationIds : undefined,
    };
    const conversations = [...(session.conversations ?? []), conv];
    const next = activate({ ...session, agents, conversations }, conv);
    saveSession(next);
    setSession(next);
    setView("chat");
  }

  function handleOpenConversation(convId: string) {
    setSession((prev) => {
      if (!prev) return prev;
      const conv = prev.conversations?.find((c) => c.id === convId);
      if (!conv) return prev;
      const next = activate(prev, conv);
      saveSession(next);
      return next;
    });
    setView("chat");
    // NOTE: Pre-isolation conversations stay on the agent's shared/default
    // Letta thread. Auto-creating a scoped conv here would point the chat
    // at an empty new thread and visually wipe the user's history (the
    // messages would still exist on Letta, just under no conversation_id).
    // Users who want clean isolation for an old conversation can delete +
    // recreate it; new conversations are scoped from creation.
  }

  // Delete a Familiar conversation. Cleans up the per-member Letta
  // conversations server-side too (fire-and-forget; failure to delete a Letta
  // conv leaves an orphan but doesn't block the local removal — user can
  // clean those up via the ADE if it matters). The agent itself, its memory
  // blocks, and any other Familiar conversations on it are untouched.
  async function handleDeleteConversation(convId: string) {
    if (!session) return;
    const conv = session.conversations?.find((c) => c.id === convId);
    if (!conv) return;
    // Snip the conv from local state first so the UI reacts immediately.
    setSession((prev) => {
      if (!prev) return prev;
      const conversations = (prev.conversations ?? []).filter((c) => c.id !== convId);
      const next: Session = {
        ...prev,
        conversations,
        activeConversationId:
          prev.activeConversationId === convId ? undefined : prev.activeConversationId,
      };
      saveSession(next);
      return next;
    });
    // Server cleanup: delete each member's scoped Letta conv. Pre-isolation
    // conversations have no conversationIds, so nothing to delete there.
    const lettaIds = Object.values(conv.conversationIds ?? {});
    for (const lettaConvId of lettaIds) {
      try {
        await letta.deleteConversation({ bridgeUrl, lettaKey: session.lettaKey }, lettaConvId);
      } catch (err) {
        console.warn(`deleteConversation(${lettaConvId}) failed (orphan left)`, err);
      }
    }
  }

  function handleBackToList() {
    setSession((prev) => {
      if (!prev) return prev;
      const next: Session = { ...prev, activeConversationId: undefined };
      saveSession(next);
      return next;
    });
    setView("chat");
  }

  function handleFullLogout() {
    clearSession();
    setSession(null);
    setView("chat");
  }

  // Update the active conversation's last-message preview (for the list row).
  function handleLastMessage(text: string, at: number) {
    setSession((prev) => {
      if (!prev || !prev.activeConversationId) return prev;
      const conversations = (prev.conversations ?? []).map((c) =>
        c.id === prev.activeConversationId
          ? { ...c, lastPreview: text.slice(0, 140), lastAt: at }
          : c,
      );
      const next: Session = { ...prev, conversations };
      saveSession(next);
      return next;
    });
  }

  function handleUserProfileChange(p: Profile) {
    if (!session) return;
    const next: Session = { ...session, user: p };
    saveSession(next);
    setSession(next);
    if (session.agentId) {
      void syncUserStateBlock(
        { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
        session.agentId,
        p,
        session.userPresence,
        session.dndUntil,
      );
      if (session.clientToken) {
        void bridge
          .postUserState({ bridgeUrl: session.bridgeUrl, clientToken: session.clientToken }, session.agentId, {
            status_text: p.status?.text ?? null,
            status_emoji: p.status?.emoji ?? null,
            presence: session.userPresence ?? null,
          })
          .catch((err) => console.warn("postUserState failed", err));
      }
    }
  }

  function handleUserPresenceChange(presenceValue: string | undefined) {
    if (!session) return;
    const next: Session = { ...session, userPresence: presenceValue };
    saveSession(next);
    setSession(next);
    if (session.agentId) {
      void syncUserStateBlock(
        { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
        session.agentId,
        session.user,
        presenceValue,
        session.dndUntil,
      );
      if (session.clientToken) {
        void bridge
          .postUserState({ bridgeUrl: session.bridgeUrl, clientToken: session.clientToken }, session.agentId, {
            status_text: session.user.status?.text ?? null,
            status_emoji: session.user.status?.emoji ?? null,
            presence: presenceValue ?? null,
          })
          .catch((err) => console.warn("postUserState (presence) failed", err));
      }
    }
  }

  function handleAgentProfileChange(p: Profile) {
    if (!session) return;
    const next = syncRegistry({ ...session, agent: p });
    // Reflect a renamed agent in its conversation rows (if it's a direct one
    // we haven't separately named).
    if (session.agentId) {
      next.conversations = (next.conversations ?? []).map((c) =>
        c.kind === "direct" && c.primaryId === session.agentId ? { ...c, name: p.name || c.name } : c,
      );
    }
    saveSession(next);
    setSession(next);
  }

  function handleAgentStateRefresh(state: bridge.BridgeState) {
    setSession((prev) => {
      if (!prev) return prev;
      const nextAgent: Profile = {
        ...prev.agent,
        status: state.agent.status_text
          ? { text: state.agent.status_text, emoji: state.agent.status_emoji ?? undefined, setAt: state.updated_at }
          : undefined,
      };
      const nextUser: Profile = {
        ...prev.user,
        status: state.user.status_text
          ? { text: state.user.status_text, emoji: state.user.status_emoji ?? undefined, setAt: state.updated_at }
          : prev.user.status,
      };
      const next = syncRegistry({
        ...prev,
        agent: nextAgent,
        user: nextUser,
        agentPresence: state.agent.presence ?? undefined,
        userPresence: state.user.presence ?? prev.userPresence,
      });
      saveSession(next);
      return next;
    });
  }

  function handleAppearanceChange(appearance: Appearance) {
    setSession((prev) => {
      if (!prev) return prev;
      const next: Session = { ...prev, appearance };
      saveSession(next);
      return next;
    });
  }

  function handleAutonomousChange(args: {
    scheduleId?: string;
    frequencyMinutes?: number | null;
    dndUntil?: number | null;
  }) {
    setSession((prev) => {
      if (!prev) return prev;
      const next: Session = {
        ...prev,
        autonomousScheduleId: args.scheduleId ?? prev.autonomousScheduleId,
        autonomousFrequencyMinutes:
          args.frequencyMinutes !== undefined ? args.frequencyMinutes : prev.autonomousFrequencyMinutes,
        dndUntil: args.dndUntil !== undefined ? args.dndUntil : prev.dndUntil,
      };
      saveSession(next);
      if (next.agentId && args.dndUntil !== undefined) {
        void syncUserStateBlock(
          { bridgeUrl: next.bridgeUrl, lettaKey: next.lettaKey },
          next.agentId,
          next.user,
          next.userPresence,
          next.dndUntil,
        );
      }
      return next;
    });
  }

  // ─── Routing ───────────────────────────────────────────────────────────────

  if (!session?.lettaKey) {
    return <LoginPage bridgeUrl={bridgeUrl} onKeyVerified={handleLoginWithKey} />;
  }

  // No conversation open → the conversation list (which also handles the
  // "you have none yet" empty state and starting a new one).
  if (!session.activeConversationId || !session.conversations?.some((c) => c.id === session.activeConversationId)) {
    return (
      <ConversationListPage
        session={session}
        busy={setupBusy}
        onOpen={handleOpenConversation}
        onStartConversation={handleStartConversation}
        onStartGroupConversation={handleStartGroupConversation}
        onDeleteConversation={handleDeleteConversation}
        onLogout={handleFullLogout}
      />
    );
  }

  if (view === "settings") {
    return (
      <SettingsPage
        session={session}
        onAppearanceChange={handleAppearanceChange}
        onAutonomousChange={handleAutonomousChange}
        onSwitchAgent={handleBackToList}
        onLogout={handleFullLogout}
        onBack={() => setView("chat")}
      />
    );
  }

  return (
    <ChatPage
      session={session}
      onSwitchAgent={handleBackToList}
      onUserProfileChange={handleUserProfileChange}
      onAgentProfileChange={handleAgentProfileChange}
      onUserPresenceChange={handleUserPresenceChange}
      onAgentStateRefresh={handleAgentStateRefresh}
      onLastMessage={handleLastMessage}
      onOpenSettings={() => setView("settings")}
    />
  );
}
