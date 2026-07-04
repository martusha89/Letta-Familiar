import { useEffect, useRef, useState } from "react";
import type { Profile } from "../types";
import Avatar from "./Avatar";
import { resizeImageFile } from "../lib/appearance";

interface Props {
  side: "user" | "agent";
  profile: Profile;
  canonicalName?: string;
  presence?: string;
  onSave: (next: Profile) => void;
  onPresenceChange?: (next: string | undefined) => void;
  onClose: () => void;
}

const PRESENCE_OPTIONS: Array<{ value: string; label: string; emoji: string }> = [
  { value: "online", label: "online", emoji: "🟢" },
  { value: "away", label: "away", emoji: "🟡" },
  { value: "asleep", label: "asleep", emoji: "🌙" },
];

const PRESETS: Array<{ emoji: string; text: string }> = [
  { emoji: "😴", text: "tired" },
  { emoji: "💻", text: "working" },
  { emoji: "🔥", text: "hyperfocused" },
  { emoji: "🌿", text: "peaceful" },
  { emoji: "😔", text: "low" },
  { emoji: "🌀", text: "restless" },
  { emoji: "👍", text: "fine" },
  { emoji: "💔", text: "sad" },
];

export default function ProfileEditor({
  side,
  profile,
  canonicalName,
  presence,
  onSave,
  onPresenceChange,
  onClose,
}: Props) {
  const [name, setName] = useState(profile.name);
  const [pic, setPic] = useState<string | undefined>(profile.pic);
  const [statusText, setStatusText] = useState(profile.status?.text ?? "");
  const [statusEmoji, setStatusEmoji] = useState(profile.status?.emoji ?? "");
  const [localPresence, setLocalPresence] = useState<string | undefined>(presence);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function pickFile() {
    fileRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadError(null);
    setUploading(true);
    try {
      // Resize to a sane avatar size — 256px max, 80% JPEG quality. Without
      // this, a phone-camera photo's full-resolution base64 can blow past
      // localStorage's quota (~5-10MB) and the save silently fails for the
      // *whole* session object — losing not just the pic but other unsaved
      // state too.
      const dataUrl = await resizeImageFile(f, 256, 0.8);
      setPic(dataUrl);
    } catch (err) {
      console.error("avatar resize failed", err);
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function applyPreset(p: { emoji: string; text: string }) {
    setStatusEmoji(p.emoji);
    setStatusText(p.text);
  }

  function clearStatus() {
    setStatusEmoji("");
    setStatusText("");
  }

  function save() {
    const next: Profile = {
      name: name.trim() || profile.name,
      pic,
      status: statusText.trim()
        ? { text: statusText.trim(), emoji: statusEmoji || undefined, setAt: Date.now() }
        : undefined,
    };
    onSave(next);
    if (onPresenceChange && localPresence !== presence) {
      onPresenceChange(localPresence);
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4 z-30"
      style={{ animation: "familiar-fade-up 200ms ease-out both" }}
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-sm rounded-t-2xl md:rounded-2xl border-t md:border border-[var(--color-line-strong)] bg-[var(--color-overlay)] shadow-warm-lg p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h2 className="text-[15px] font-medium tracking-tight text-ink">
            {side === "user" ? "Your profile" : "Their profile"}
          </h2>
          <button
            onClick={onClose}
            className="text-[11px] text-ink-faint hover:text-ink-muted px-2 py-1 rounded-md transition-colors"
          >
            esc
          </button>
        </header>

        <div className="flex items-center gap-4">
          <Avatar name={name || canonicalName || "?"} pic={pic} size={64} />
          <div className="flex flex-col gap-1.5">
            <button
              onClick={pickFile}
              disabled={uploading}
              className="text-[12px] rounded-md bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-2.5 py-1 text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
            >
              {uploading ? "Processing…" : "Upload picture"}
            </button>
            {pic && !uploading && (
              <button
                onClick={() => setPic(undefined)}
                className="text-[11px] text-ink-faint hover:text-ink-muted text-left transition-colors"
              >
                Remove
              </button>
            )}
            {uploadError && (
              <p className="text-[11px] text-red-300 leading-snug max-w-[180px]">{uploadError}</p>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFile}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={canonicalName ?? "Your name"}
            className="w-full rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint transition-colors"
          />
          {side === "agent" && canonicalName && name !== canonicalName && (
            <p className="text-[11px] text-ink-faint leading-relaxed">
              Letta calls them <span className="font-mono text-ink-muted">{canonicalName}</span>.
              Your override only changes the display in this app.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            Status
          </label>
          <div className="flex gap-2">
            <input
              value={statusEmoji}
              onChange={(e) => setStatusEmoji(e.target.value.slice(0, 2))}
              placeholder="😊"
              className="w-12 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-2 py-2 text-[14px] text-center transition-colors"
            />
            <input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              placeholder={side === "user" ? "tired" : "thinking about dinner"}
              className="flex-1 rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {PRESETS.map((p) => (
              <button
                key={p.text}
                onClick={() => applyPreset(p)}
                className="text-[12px] rounded-full bg-[var(--color-raised)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] hover:border-[var(--color-accent)] px-2.5 py-1 text-ink-muted hover:text-ink transition-all duration-200 active:scale-95"
              >
                <span>{p.emoji}</span> <span>{p.text}</span>
              </button>
            ))}
            {(statusText || statusEmoji) && (
              <button
                onClick={clearStatus}
                className="text-[12px] rounded-full px-2.5 py-1 text-ink-faint hover:text-ink-muted transition-colors"
              >
                clear
              </button>
            )}
          </div>
        </div>

        {side === "user" && (
          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Presence
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRESENCE_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setLocalPresence(p.value)}
                  className={`text-[12px] rounded-full border px-2.5 py-1 transition-all duration-200 active:scale-95 ${
                    localPresence === p.value
                      ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-ink"
                      : "bg-[var(--color-raised)] hover:bg-[var(--color-line-strong)] border-[var(--color-line)] text-ink-muted hover:text-ink"
                  }`}
                >
                  <span>{p.emoji}</span> <span>{p.label}</span>
                </button>
              ))}
              {localPresence && (
                <button
                  onClick={() => setLocalPresence(undefined)}
                  className="text-[12px] rounded-full px-2.5 py-1 text-ink-faint hover:text-ink-muted transition-colors"
                >
                  clear
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-[var(--color-line)] hover:bg-[var(--color-line-strong)] border border-[var(--color-line)] px-3 py-2.5 text-[14px] text-ink-muted hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="flex-1 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-2.5 text-[14px] font-medium text-[var(--color-bubble-user-ink)] transition-all duration-200 active:scale-[0.98] shadow-warm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
