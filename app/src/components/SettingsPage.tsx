import { useEffect, useRef, useState } from "react";
import type { Appearance, Session } from "../types";
import {
  BACKGROUND_PRESETS,
  DEFAULT_APPEARANCE,
  rgbaFromHex,
  inkForBackground,
  resizeImageFile,
} from "../lib/appearance";
import { AUTONOMOUS_PROMPT } from "../lib/userState";
import * as bridge from "../api/bridge";
import * as letta from "../api/letta";

// Suppress the "import bridge but only used inside ElevenlabsConfig" lint —
// referenced via `bridge.getElevenlabs` etc.
void bridge;

interface Props {
  session: Session;
  onAppearanceChange: (next: Appearance) => void;
  onAutonomousChange: (args: {
    scheduleId?: string;
    frequencyMinutes?: number | null;
    dndUntil?: number | null;
  }) => void;
  onSwitchAgent: () => void;
  onLogout: () => void;
  onBack: () => void;
}

export default function SettingsPage({
  session,
  onAppearanceChange,
  onAutonomousChange,
  onSwitchAgent,
  onLogout,
  onBack,
}: Props) {
  const merged: Required<Appearance> = {
    ...DEFAULT_APPEARANCE,
    ...(session.appearance ?? {}),
  };
  // Local working state so sliders don't fire onChange storms upstream.
  const [draft, setDraft] = useState<Required<Appearance>>(merged);

  // Push to parent whenever draft changes. Parent's useEffect applies CSS vars.
  useEffect(() => {
    onAppearanceChange(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function patch(p: Partial<Appearance>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  function reset() {
    setDraft({ ...DEFAULT_APPEARANCE });
  }

  const maskedKey = session.lettaKey
    ? `${session.lettaKey.slice(0, 7)}…${session.lettaKey.slice(-4)}`
    : "—";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-line)] bg-[var(--color-base)]/80 backdrop-blur-md sticky top-0 z-10">
        <button
          onClick={onBack}
          className="text-ink-faint hover:text-ink-muted transition-colors p-1.5 rounded-md active:scale-95"
          aria-label="Back"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="text-[15px] font-medium tracking-tight text-ink">Settings</div>
        <div className="ml-auto">
          <button
            onClick={reset}
            className="text-[11px] uppercase tracking-[0.14em] text-ink-faint hover:text-ink-muted transition-colors"
          >
            Reset
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-5 py-8 space-y-10">
          {/* Appearance */}
          <Section title="Appearance" subtitle="The chat is yours. Make it feel like home.">
            <SubSection label="Your bubble">
              <ColorAlpha
                hex={draft.bubbleUserHex}
                alpha={draft.bubbleUserAlpha}
                onChange={(hex, alpha) =>
                  patch({ bubbleUserHex: hex, bubbleUserAlpha: alpha })
                }
              />
              <BubblePreview
                hex={draft.bubbleUserHex}
                alpha={draft.bubbleUserAlpha}
                align="right"
                text="this is how your messages will look."
              />
            </SubSection>

            <SubSection label="Their bubble">
              <ColorAlpha
                hex={draft.bubbleAgentHex}
                alpha={draft.bubbleAgentAlpha}
                onChange={(hex, alpha) =>
                  patch({ bubbleAgentHex: hex, bubbleAgentAlpha: alpha })
                }
              />
              <BubblePreview
                hex={draft.bubbleAgentHex}
                alpha={draft.bubbleAgentAlpha}
                align="left"
                text="and theirs will look like this."
              />
            </SubSection>

            <SubSection label="Background">
              <BackgroundGrid
                selected={draft.backgroundPreset}
                customDataUrl={draft.backgroundCustomDataUrl}
                onPickPreset={(id) => patch({ backgroundPreset: id })}
                onPickCustom={(dataUrl) =>
                  patch({ backgroundPreset: "custom", backgroundCustomDataUrl: dataUrl })
                }
                onRemoveCustom={() =>
                  patch({
                    backgroundPreset:
                      draft.backgroundPreset === "custom" ? "warm-base" : draft.backgroundPreset,
                    backgroundCustomDataUrl: "",
                  })
                }
              />
            </SubSection>

            <SubSection label="Blur" caption={`${draft.backgroundBlur}px`}>
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={draft.backgroundBlur}
                onChange={(e) => patch({ backgroundBlur: Number(e.target.value) })}
                className="w-full accent-[var(--color-accent)]"
              />
            </SubSection>
          </Section>

          {/* Account */}
          <Section title="Account">
            <Row label="Letta key" value={<span className="font-mono">{maskedKey}</span>} />
            <Row
              label="Connected agent"
              value={session.agentName ?? "—"}
              hint={session.agentId?.slice(0, 24) + "…"}
            />
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={onSwitchAgent}
                className="rounded-lg bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-3 py-2 text-[13px] text-ink-muted hover:text-ink transition-colors"
              >
                Change agent
              </button>
              <button
                onClick={onLogout}
                className="rounded-lg bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-3 py-2 text-[13px] text-red-300 hover:text-red-200 transition-colors"
              >
                Log out
              </button>
            </div>
          </Section>

          {/* Autonomous check-ins */}
          <Section
            title="Autonomous check-ins"
            subtitle="Tap your agent on a cadence. They decide whether there's something real to say. Empty is the right answer most of the time."
          >
            <AutonomousConfigPanel session={session} onChange={onAutonomousChange} />
          </Section>

          {/* Voice (ElevenLabs) */}
          <Section
            title="Voice"
            subtitle="Optional. Lets your agent send you voice notes via ElevenLabs."
          >
            <ElevenlabsConfig session={session} />
          </Section>

          {/* GIFs (KLIPY) */}
          <Section
            title="GIFs"
            subtitle="Optional. Powers the GIF picker in the composer via KLIPY."
          >
            <KlipyConfigPanel session={session} />
          </Section>

          {/* About */}
          <Section title="About">
            <Row label="Version" value={<span className="font-mono">0.0.2</span>} />
            <Row
              label="Bridge"
              value={
                <span className="font-mono text-[11px] break-all">
                  {session.bridgeUrl.replace(/^https?:\/\//, "")}
                </span>
              }
            />
          </Section>

          <p className="text-[11px] text-ink-faint text-center pt-4 pb-8">
            Familiar · A chat client for your Letta agent
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">{title}</h2>
        {subtitle && (
          <p className="text-[13px] text-ink-muted leading-relaxed">{subtitle}</p>
        )}
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function SubSection({
  label,
  caption,
  children,
}: {
  label: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {caption && (
          <span className="text-[11px] tabular text-ink-faint">{caption}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-[var(--color-line)] last:border-0">
      <span className="text-[13px] text-ink-muted">{label}</span>
      <div className="text-[13px] text-ink text-right min-w-0">
        <div className="truncate">{value}</div>
        {hint && <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{hint}</div>}
      </div>
    </div>
  );
}

function ColorAlpha({
  hex,
  alpha,
  onChange,
}: {
  hex: string;
  alpha: number;
  onChange: (hex: string, alpha: number) => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value, alpha)}
          className="w-12 h-10 rounded-lg bg-transparent border border-[var(--color-line)] cursor-pointer"
          style={{ padding: 2 }}
        />
        <input
          type="text"
          value={hex.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#?[0-9a-f]{6}$/i.test(v)) {
              onChange(v.startsWith("#") ? v : `#${v}`, alpha);
            }
          }}
          className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] font-mono tabular text-ink"
        />
        <span className="text-[11px] tabular text-ink-faint w-10 text-right">
          {Math.round(alpha * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(alpha * 100)}
        onChange={(e) => onChange(hex, Number(e.target.value) / 100)}
        className="w-full accent-[var(--color-accent)]"
        aria-label="Transparency"
      />
    </div>
  );
}

const FREQUENCY_OPTIONS: Array<{ minutes: number | null; label: string; sublabel: string }> = [
  { minutes: null, label: "Off", sublabel: "Only when you message first" },
  { minutes: 360, label: "Sparse", sublabel: "Every 6 hours" },
  { minutes: 240, label: "Light", sublabel: "Every 4 hours" },
  { minutes: 120, label: "Active", sublabel: "Every 2 hours" },
  { minutes: 60, label: "Hourly", sublabel: "Every hour" },
];

const PAUSE_PRESETS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: "1h" },
  { hours: 4, label: "4h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
];

function frequencyToCron(minutes: number): string {
  // Letta uses 5-field cron expressions, UTC. Map our tiers to "every N hours
  // on the hour" so behaviour is predictable. Hourly is "every hour at :00".
  const hours = minutes / 60;
  if (hours <= 1) return "0 * * * *";
  return `0 */${Math.round(hours)} * * *`;
}

function AutonomousConfigPanel({
  session,
  onChange,
}: {
  session: Session;
  onChange: (args: {
    scheduleId?: string;
    frequencyMinutes?: number | null;
    dndUntil?: number | null;
  }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, reconcile local session state with what's actually on Letta —
  // schedules can be deleted via the ADE without us knowing.
  useEffect(() => {
    if (!session.agentId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const schedules = await letta.listSchedules(
          { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
          session.agentId!,
        );
        if (cancelled) return;
        const ours = schedules.find(
          (s) =>
            s.id === session.autonomousScheduleId ||
            s.messages?.some((m) => m.content?.startsWith("[autonomous_check_in]")),
        );
        const userExplicitlyOff =
          (session.autonomousFrequencyMinutes ?? null) === null && !session.autonomousScheduleId;

        if (userExplicitlyOff) {
          // User has Off selected. Any [autonomous_check_in] schedule found
          // server-side is an orphan from a failed previous Off — nuke it,
          // don't re-adopt.
          const orphans = schedules.filter((s) =>
            s.messages?.some((m) => m.content?.startsWith("[autonomous_check_in]")),
          );
          for (const o of orphans) {
            try {
              await letta.deleteSchedule(
                { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey },
                session.agentId!,
                o.id,
              );
            } catch (e) {
              console.warn(`Failed to delete orphan schedule ${o.id}`, e);
            }
          }
        } else if (!ours && session.autonomousScheduleId) {
          // Stale — schedule was deleted on Letta side.
          onChange({ scheduleId: undefined, frequencyMinutes: null });
        } else if (ours && ours.id !== session.autonomousScheduleId) {
          onChange({ scheduleId: ours.id });
        }
      } catch (e) {
        if (!cancelled) console.warn("listSchedules failed (non-fatal)", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.agentId]);

  async function setFrequency(minutes: number | null) {
    if (!session.agentId) return;
    setError(null);
    setSaving(true);
    const opts = { bridgeUrl: session.bridgeUrl, lettaKey: session.lettaKey };
    try {
      // List ALL schedules and delete every [autonomous_check_in] one — not
      // just the id we have locally. The local id can drift / be missing /
      // be stale; relying on it is what let the original off-then-orphan bug
      // through. Belt and braces.
      let allSchedules: letta.LettaSchedule[] = [];
      try {
        allSchedules = await letta.listSchedules(opts, session.agentId);
      } catch (e) {
        console.warn("listSchedules failed before delete (continuing)", e);
      }
      const targets = allSchedules.filter(
        (s) =>
          s.id === session.autonomousScheduleId ||
          s.messages?.some((m) => m.content?.startsWith("[autonomous_check_in]")),
      );
      // Fallback: if list call failed and we still have a local id, try that.
      if (targets.length === 0 && session.autonomousScheduleId) {
        targets.push({ id: session.autonomousScheduleId });
      }
      const deleteFailures: string[] = [];
      for (const t of targets) {
        try {
          await letta.deleteSchedule(opts, session.agentId, t.id);
        } catch (e) {
          deleteFailures.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (deleteFailures.length > 0) {
        // SURFACE the failure — silent warn is what hid this bug originally.
        throw new Error(
          `Couldn't delete ${deleteFailures.length} existing schedule(s) on Letta: ${deleteFailures[0]}`,
        );
      }
      if (minutes === null) {
        onChange({ scheduleId: undefined, frequencyMinutes: null });
        setSaving(false);
        return;
      }
      const created = await letta.createRecurringSchedule(
        opts,
        session.agentId,
        frequencyToCron(minutes),
        AUTONOMOUS_PROMPT,
      );
      onChange({ scheduleId: created.id, frequencyMinutes: minutes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function pauseFor(hours: number) {
    onChange({ dndUntil: Date.now() + hours * 3_600_000 });
  }

  function clearPause() {
    onChange({ dndUntil: null });
  }

  if (loading) {
    return <p className="text-[12px] text-ink-faint">Loading…</p>;
  }

  const currentFrequency = session.autonomousFrequencyMinutes ?? null;
  const dndActive = session.dndUntil && session.dndUntil > Date.now();
  const enabled = Boolean(session.autonomousScheduleId && currentFrequency);

  return (
    <div className="space-y-5">
      <SubSection label="Frequency">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          {FREQUENCY_OPTIONS.map((opt) => {
            const selected = currentFrequency === opt.minutes;
            return (
              <button
                key={opt.label}
                onClick={() => setFrequency(opt.minutes)}
                disabled={saving}
                className={`text-left rounded-lg border px-3 py-2 transition-all duration-200 ${
                  selected
                    ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-ink"
                    : "bg-[var(--color-raised)] hover:bg-[var(--color-line-strong)] border-[var(--color-line)] text-ink-muted hover:text-ink"
                } disabled:opacity-50`}
              >
                <div className="text-[12px] font-medium">{opt.label}</div>
                <div className="text-[10.5px] text-ink-faint mt-0.5">{opt.sublabel}</div>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-ink-faint pt-1 leading-relaxed">
          Your agent gets a quiet nudge on this cadence. They read your status, presence, and
          DND before deciding whether to break silence — and most nudges end in nothing being said.
          The schedule lives on Letta's side, not yours; your API key never leaves the browser.
        </p>
      </SubSection>

      {enabled && (
        <SubSection
          label="Pause"
          caption={dndActive ? `paused until ${new Date(session.dndUntil!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "no pause"}
        >
          <div className="flex flex-wrap gap-1.5">
            {PAUSE_PRESETS.map((p) => (
              <button
                key={p.hours}
                onClick={() => pauseFor(p.hours)}
                disabled={saving}
                className="text-[12px] rounded-full bg-[var(--color-raised)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-2.5 py-1 text-ink-muted hover:text-ink transition-colors active:scale-95 disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
            {dndActive && (
              <button
                onClick={clearPause}
                disabled={saving}
                className="text-[12px] rounded-full px-2.5 py-1 text-ink-faint hover:text-ink-muted transition-colors disabled:opacity-50"
              >
                resume now
              </button>
            )}
          </div>
        </SubSection>
      )}

      {error && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">
          {error}
        </p>
      )}
    </div>
  );
}

function KlipyConfigPanel({ session }: { session: Session }) {
  const [hasKey, setHasKey] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.agentId || !session.clientToken) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = await bridge.getKlipy(
          { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
          session.agentId!,
        );
        if (!cancelled) setHasKey(c.has_key);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.agentId, session.bridgeUrl, session.clientToken]);

  async function save() {
    if (!session.agentId || !session.clientToken || !draftKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const c = await bridge.postKlipy(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
        { api_key: draftKey.trim() },
      );
      setHasKey(c.has_key);
      setDraftKey("");
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!session.agentId || !session.clientToken) return;
    if (!window.confirm("Remove your KLIPY key? GIF search will stop working.")) return;
    setSaving(true);
    setError(null);
    try {
      const c = await bridge.postKlipy(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
        { api_key: null },
      );
      setHasKey(c.has_key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-[12px] text-ink-faint">Loading…</p>;

  return (
    <div className="space-y-2.5">
      <SubSection label="KLIPY API key" caption={hasKey ? "configured" : "not configured"}>
        {!editing ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] px-3 py-2 text-[13px] font-mono text-ink-muted">
              {hasKey ? "••••••••••••••••" : "—"}
            </span>
            <button
              onClick={() => {
                setEditing(true);
                setDraftKey("");
              }}
              className="rounded-lg bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-3 py-2 text-[12px] text-ink-muted hover:text-ink transition-colors"
            >
              {hasKey ? "Replace" : "Add"}
            </button>
            {hasKey && (
              <button
                onClick={clearKey}
                disabled={saving}
                className="rounded-lg px-2 py-2 text-[12px] text-red-300 hover:text-red-200 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder="your KLIPY app key…"
              autoFocus
              className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] font-mono text-ink placeholder:text-ink-faint transition-colors"
            />
            <button
              onClick={save}
              disabled={saving || !draftKey.trim()}
              className="rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 px-3 py-2 text-[12px] font-medium text-[var(--color-bubble-user-ink)] transition-all"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraftKey("");
              }}
              className="rounded-lg px-2 py-2 text-[12px] text-ink-faint hover:text-ink-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </SubSection>
      <p className="text-[11px] text-ink-faint leading-relaxed">
        Get a free key at{" "}
        <a
          href="https://klipy.com/developers"
          target="_blank"
          rel="noreferrer"
          className="text-ink-muted underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-ink hover:decoration-[var(--color-accent)]"
        >
          klipy.com → Partner Panel → API Keys
        </a>
        . Testing keys allow 100 requests/min; request Production access for unlimited.
        (Tenor's GIF API shut down to new clients in Jan 2026 — KLIPY is the successor.)
      </p>
      {error && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">
          {error}
        </p>
      )}
    </div>
  );
}

function ElevenlabsConfig({ session }: { session: Session }) {
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [voiceId, setVoiceId] = useState<string>("");
  const [draftKey, setDraftKey] = useState<string>("");
  const [draftVoiceId, setDraftVoiceId] = useState<string>("");
  const [editingKey, setEditingKey] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!session.agentId || !session.clientToken) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const config = await bridge.getElevenlabs(
          { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
          session.agentId!,
        );
        if (cancelled) return;
        setHasKey(config.has_key);
        setVoiceId(config.voice_id ?? "");
        setDraftVoiceId(config.voice_id ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.agentId, session.bridgeUrl, session.clientToken]);

  const dirty =
    (editingKey && draftKey.length > 0) || draftVoiceId !== voiceId;

  async function save() {
    if (!session.agentId || !session.clientToken) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { api_key?: string; voice_id?: string | null } = {};
      if (editingKey && draftKey.length > 0) patch.api_key = draftKey;
      if (draftVoiceId !== voiceId) patch.voice_id = draftVoiceId || null;
      const result = await bridge.postElevenlabs(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
        patch,
      );
      setHasKey(result.has_key);
      setVoiceId(result.voice_id ?? "");
      setDraftVoiceId(result.voice_id ?? "");
      setDraftKey("");
      setEditingKey(false);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!session.agentId || !session.clientToken) return;
    if (!window.confirm("Remove your ElevenLabs key? Voice notes will stop working.")) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bridge.postElevenlabs(
        { bridgeUrl: session.bridgeUrl, clientToken: session.clientToken },
        session.agentId,
        { api_key: null },
      );
      setHasKey(result.has_key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-[12px] text-ink-faint">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <SubSection
        label="API key"
        caption={hasKey ? "configured" : "not configured"}
      >
        {!editingKey ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] px-3 py-2 text-[13px] font-mono text-ink-muted">
              {hasKey ? "••••••••••••••••" : "—"}
            </span>
            <button
              onClick={() => {
                setEditingKey(true);
                setDraftKey("");
              }}
              className="rounded-lg bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-3 py-2 text-[12px] text-ink-muted hover:text-ink transition-colors"
            >
              {hasKey ? "Replace" : "Add"}
            </button>
            {hasKey && (
              <button
                onClick={clearKey}
                disabled={saving}
                className="rounded-lg px-2 py-2 text-[12px] text-red-300 hover:text-red-200 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder="sk_xxxxxxxxxxxxxxxxxxxx"
              autoFocus
              className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] font-mono text-ink placeholder:text-ink-faint transition-colors"
            />
            <button
              onClick={() => {
                setEditingKey(false);
                setDraftKey("");
              }}
              className="rounded-lg px-2 py-2 text-[12px] text-ink-faint hover:text-ink-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        <p className="text-[11px] text-ink-faint pt-1">
          Get one at{" "}
          <a
            href="https://elevenlabs.io/app/settings/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-ink-muted underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-ink hover:decoration-[var(--color-accent)]"
          >
            elevenlabs.io
          </a>
          . Stored in your bridge's database — never sent anywhere except ElevenLabs.
        </p>
      </SubSection>

      <SubSection label="Voice ID">
        <input
          value={draftVoiceId}
          onChange={(e) => setDraftVoiceId(e.target.value)}
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
          className="w-full rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] font-mono text-ink placeholder:text-ink-faint transition-colors"
        />
        <p className="text-[11px] text-ink-faint pt-1">
          Find voice IDs in your{" "}
          <a
            href="https://elevenlabs.io/app/voice-lab"
            target="_blank"
            rel="noreferrer"
            className="text-ink-muted underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-ink hover:decoration-[var(--color-accent)]"
          >
            voice library
          </a>
          .
        </p>
      </SubSection>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed px-4 py-2 text-[13px] font-medium text-[var(--color-bubble-user-ink)] transition-all duration-200 active:scale-[0.98]"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && !dirty && (
          <span className="text-[11px] text-ink-faint">Saved.</span>
        )}
      </div>

      {error && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">
          {error}
        </p>
      )}
    </div>
  );
}

function BackgroundGrid({
  selected,
  customDataUrl,
  onPickPreset,
  onPickCustom,
  onRemoveCustom,
}: {
  selected: string | undefined;
  customDataUrl: string | undefined;
  onPickPreset: (id: string) => void;
  onPickCustom: (dataUrl: string) => void;
  onRemoveCustom: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const dataUrl = await resizeImageFile(f, 1600, 0.82);
      onPickCustom(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {BACKGROUND_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onPickPreset(p.id)}
            className={`relative aspect-square rounded-lg overflow-hidden border transition-all duration-200 ${
              selected === p.id
                ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]"
                : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
            }`}
            aria-label={p.label}
            title={p.label}
          >
            <span className="absolute inset-0" style={{ background: p.background }} />
            <span className="absolute bottom-1 left-1.5 right-1.5 text-[9px] uppercase tracking-wider text-ink-muted bg-black/40 backdrop-blur-sm rounded px-1 py-0.5 truncate">
              {p.label}
            </span>
          </button>
        ))}

        {/* Custom slot — empty state shows a picker, filled shows the photo + remove */}
        {customDataUrl ? (
          <div
            className={`relative aspect-square rounded-lg overflow-hidden border transition-all duration-200 ${
              selected === "custom"
                ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]"
                : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
            }`}
          >
            <button
              onClick={() => onPickPreset("custom")}
              className="absolute inset-0"
              aria-label="Use custom background"
            >
              <img
                src={customDataUrl}
                alt="Custom background"
                className="w-full h-full object-cover"
                draggable={false}
              />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveCustom();
              }}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm flex items-center justify-center text-ink text-[10px]"
              aria-label="Remove custom background"
            >
              ×
            </button>
            <span className="absolute bottom-1 left-1.5 right-1.5 text-[9px] uppercase tracking-wider text-ink-muted bg-black/40 backdrop-blur-sm rounded px-1 py-0.5 truncate">
              Custom
            </span>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="relative aspect-square rounded-lg overflow-hidden border border-dashed border-[var(--color-line-strong)] hover:border-[var(--color-accent)] hover:bg-[var(--color-line)] transition-all duration-200 flex flex-col items-center justify-center gap-1 text-ink-faint hover:text-ink-muted disabled:opacity-50"
            aria-label="Upload custom background"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="text-[10px] uppercase tracking-wider">
              {busy ? "loading…" : "Upload"}
            </span>
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />
      {error && (
        <p className="text-[11px] text-red-300">{error}</p>
      )}
    </div>
  );
}

function BubblePreview({
  hex,
  alpha,
  align,
  text,
}: {
  hex: string;
  alpha: number;
  align: "left" | "right";
  text: string;
}) {
  const bg = rgbaFromHex(hex, alpha);
  const ink = inkForBackground(hex, alpha);
  const isRight = align === "right";
  return (
    <div className={`flex ${isRight ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] px-4 py-2 text-[13px] leading-relaxed shadow-warm ${
          isRight ? "rounded-2xl rounded-br-sm" : "rounded-2xl rounded-bl-sm border border-[var(--color-line)]"
        }`}
        style={{ background: bg, color: ink }}
      >
        {text}
      </div>
    </div>
  );
}
