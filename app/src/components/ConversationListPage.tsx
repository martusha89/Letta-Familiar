import { useEffect, useState } from "react";
import type { LettaAgent, Session } from "../types";
import { listAgents } from "../api/letta";
import Avatar from "./Avatar";

interface Props {
  session: Session;
  busy?: boolean; // true while a new agent is being set up
  onOpen: (conversationId: string) => void;
  onStartConversation: (agentId: string, agentName: string) => void;
  onStartGroupConversation: (members: Array<{ id: string; name: string }>, groupName?: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onLogout: () => void;
}

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60_000) return "now";
  const m = Math.round(d / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(d / 3_600_000);
  if (h < 24) return `${h}h`;
  const days = Math.round(d / 86_400_000);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ConversationListPage({
  session,
  busy,
  onOpen,
  onStartConversation,
  onStartGroupConversation,
  onDeleteConversation,
  onLogout,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const conversations = [...(session.conversations ?? [])].sort(
    (a, b) => (b.lastAt ?? b.createdAt) - (a.lastAt ?? a.createdAt),
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-[var(--color-line)] bg-[var(--color-base)]/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-medium text-ink leading-tight">Familiar</div>
            <div className="text-[11px] text-ink-faint">{session.user.name || "You"}'s conversations</div>
          </div>
          <button
            onClick={() => setPickerOpen(true)}
            className="rounded-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-bubble-user-ink)] w-9 h-9 flex items-center justify-center transition-all duration-200 active:scale-95 shadow-warm"
            aria-label="New conversation"
            title="New conversation"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            onClick={onLogout}
            className="text-ink-faint hover:text-ink-muted transition-colors text-[12px] px-1"
            title="Log out"
          >
            log out
          </button>
        </div>
      </header>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-accent-soft)] flex items-center justify-center mb-3">
              <span className="text-xl">·</span>
            </div>
            <p className="text-[14px] text-ink-muted">No conversations yet.</p>
            <p className="text-[12px] text-ink-faint mt-1 mb-4">Start one with one of your Letta agents.</p>
            <button
              onClick={() => setPickerOpen(true)}
              className="rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-bubble-user-ink)] px-4 py-2 text-[13px] font-medium transition-all duration-200 active:scale-[0.98] shadow-warm"
            >
              Start a conversation
            </button>
          </div>
        ) : (
          <ul className="max-w-3xl mx-auto divide-y divide-[var(--color-line)]">
            {conversations.map((c) => {
              const primary = session.agents?.[c.primaryId];
              const displayName = c.name || primary?.nameOverride || primary?.name || "Agent";
              const confirming = confirmDeleteId === c.id;
              return (
                <li key={c.id} className="group/row relative">
                  <div className="flex items-stretch hover:bg-[var(--color-line)] transition-colors duration-150">
                    <button
                      onClick={() => onOpen(c.id)}
                      className="flex-1 text-left flex items-center gap-3 px-4 py-3 min-w-0"
                    >
                      <Avatar name={displayName} pic={primary?.pic} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[15px] font-medium text-ink truncate">{displayName}</span>
                          {c.kind === "group" && (
                            <span className="text-[10px] uppercase tracking-wide text-ink-faint shrink-0">group</span>
                          )}
                          <span className="ml-auto text-[11px] text-ink-faint shrink-0 tabular">
                            {relativeTime(c.lastAt)}
                          </span>
                        </div>
                        <div className="text-[12.5px] text-ink-dim truncate mt-0.5">
                          {c.lastPreview || <span className="italic text-ink-faint">no messages yet</span>}
                        </div>
                      </div>
                    </button>
                    {/* Delete affordance — revealed on row hover (desktop), always
                        visible on touch / when in confirm state. Two-step: first
                        click arms (turns red & shows "delete?"), second confirms.
                        Click anywhere else to cancel. */}
                    <div className="flex items-center pr-3 pl-1 shrink-0">
                      {confirming ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteConversation(c.id);
                              setConfirmDeleteId(null);
                            }}
                            className="text-[11px] rounded-md bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 px-2 py-1 transition-colors"
                          >
                            delete
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(null);
                            }}
                            className="text-[11px] text-ink-faint hover:text-ink-muted px-1 py-1 transition-colors"
                          >
                            cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(c.id);
                          }}
                          aria-label="Delete conversation"
                          title="Delete conversation"
                          className="opacity-0 group-hover/row:opacity-100 focus:opacity-100 text-ink-faint hover:text-red-300 transition-opacity p-2 rounded-md"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pickerOpen && (
        <AgentPickerOverlay
          bridgeUrl={session.bridgeUrl}
          lettaKey={session.lettaKey}
          busy={busy}
          existingMemberIds={new Set(Object.keys(session.agents ?? {}))}
          onPickOne={(id, name) => {
            onStartConversation(id, name);
            setPickerOpen(false);
          }}
          onPickGroup={(members, groupName) => {
            onStartGroupConversation(members, groupName);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function AgentPickerOverlay({
  bridgeUrl,
  lettaKey,
  busy,
  existingMemberIds,
  onPickOne,
  onPickGroup,
  onClose,
}: {
  bridgeUrl: string;
  lettaKey: string;
  busy?: boolean;
  existingMemberIds: Set<string>;
  onPickOne: (agentId: string, agentName: string) => void;
  onPickGroup: (members: Array<{ id: string; name: string }>, groupName?: string) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<LettaAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]); // ordered: first = primary
  const [groupName, setGroupName] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listAgents({ bridgeUrl, lettaKey });
        if (!cancelled) setAgents(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeUrl, lettaKey]);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function nameFor(id: string): string {
    return agents.find((a) => a.id === id)?.name ?? "Agent";
  }

  function start() {
    if (selected.length === 0 || busy) return;
    if (selected.length === 1) {
      onPickOne(selected[0], nameFor(selected[0]));
    } else {
      onPickGroup(
        selected.map((id) => ({ id, name: nameFor(id) })),
        groupName,
      );
    }
  }

  const isGroup = selected.length >= 2;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--color-line-strong)] bg-[var(--color-overlay)] shadow-warm-lg p-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[15px] font-medium text-ink">New conversation</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-[18px] leading-none px-1" aria-label="Close">×</button>
        </div>
        <p className="text-[11.5px] text-ink-faint mb-3">
          Pick one agent for a 1:1 — or several for a group room. The first you pick answers you directly; the rest chime in.
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-ink-muted mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
            Connecting tools to your agent(s)… (one-time setup)
          </div>
        )}
        {loading && <p className="text-[13px] text-ink-faint">Loading your agents…</p>}
        {error && (
          <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">{error}</p>
        )}
        {!loading && !error && (
          <ul className="space-y-2 overflow-y-auto flex-1">
            {agents.map((a) => {
              const idx = selected.indexOf(a.id);
              const picked = idx !== -1;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => toggle(a.id)}
                    disabled={busy}
                    className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-200 flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed ${
                      picked
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                        : "border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-line)]"
                    }`}
                  >
                    <Avatar name={a.name} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink truncate">{a.name}</div>
                      <div className="text-[10.5px] text-ink-faint truncate font-mono">
                        {a.id}
                        {existingMemberIds.has(a.id) && <span className="ml-2 not-italic text-ink-dim">· already set up</span>}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-semibold ${
                        picked ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bubble-user-ink)]" : "border-[var(--color-line-strong)] text-transparent"
                      }`}
                    >
                      {picked ? (idx === 0 ? "★" : idx + 1) : ""}
                    </span>
                  </button>
                </li>
              );
            })}
            {agents.length === 0 && <p className="text-[13px] text-ink-faint">No agents on this account.</p>}
          </ul>
        )}
        {!loading && !error && selected.length > 0 && (
          <div className="pt-3 mt-1 border-t border-[var(--color-line)] space-y-2">
            {isGroup && (
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={`Group name (optional) — default: ${selected.map(nameFor).join(", ")}`}
                disabled={busy}
                className="w-full rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
              />
            )}
            <button
              onClick={start}
              disabled={busy}
              className="w-full rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-[var(--color-bubble-user-ink)] px-4 py-2.5 text-[13px] font-medium transition-all duration-200 active:scale-[0.98] shadow-warm"
            >
              {isGroup ? `Start group (${selected.length})` : `Start conversation with ${nameFor(selected[0])}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
