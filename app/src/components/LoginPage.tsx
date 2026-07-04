import { useState } from "react";
import { listAgents } from "../api/letta";

interface Props {
  bridgeUrl: string;
  onKeyVerified: (key: string) => void;
}

// First screen: enter your Letta key. We validate it by listing your agents
// (you need at least one). On success the app moves on to the conversation list.
export default function LoginPage({ bridgeUrl, onKeyVerified }: Props) {
  const [lettaKey, setLettaKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function verify(key: string) {
    setError(null);
    const k = key.trim();
    if (!k) {
      setError("Paste your Letta API key first.");
      return;
    }
    setLoading(true);
    try {
      const list = await listAgents({ bridgeUrl, lettaKey: k });
      if (list.length === 0) {
        setError("No agents on this account. Create one in the Letta ADE first.");
        return;
      }
      onKeyVerified(k);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-12 relative overflow-hidden">
      <div
        aria-hidden
        className="absolute pointer-events-none -top-32 -left-32 w-[420px] h-[420px] rounded-full opacity-40"
        style={{
          background: "radial-gradient(closest-side, rgba(201,127,79,0.25), rgba(201,127,79,0) 70%)",
        }}
      />
      <div
        aria-hidden
        className="absolute pointer-events-none -bottom-40 -right-40 w-[520px] h-[520px] rounded-full opacity-30"
        style={{
          background: "radial-gradient(closest-side, rgba(244,184,96,0.2), rgba(244,184,96,0) 70%)",
        }}
      />

      <div className="w-full max-w-5xl grid md:grid-cols-[1fr_1px_1fr] gap-10 md:gap-16 items-center relative">
        <div className="space-y-4">
          <div
            className="text-[64px] md:text-[88px] font-light tracking-[-0.04em] leading-[0.95] text-ink"
            style={{ textWrap: "balance" }}
          >
            Familiar.
          </div>
          <p className="text-[15px] text-ink-muted max-w-sm leading-relaxed">
            A chat client for the AI you've already built.
            <br />
            Bring your Letta key. Keep your agents. Keep your memory.
          </p>
          <div className="flex items-center gap-2 pt-1 text-[12px] text-ink-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
            <span className="tabular">v0.0.3 · early access</span>
          </div>
        </div>

        <div className="hidden md:block h-64 self-center w-px bg-[var(--color-line-strong)]" aria-hidden />

        <div className="w-full max-w-sm justify-self-center md:justify-self-start">
          <div className="space-y-4">
            <label className="block text-[12px] uppercase tracking-[0.14em] text-ink-faint">
              Letta API key
            </label>
            <input
              type="password"
              value={lettaKey}
              onChange={(e) => setLettaKey(e.target.value)}
              placeholder="sk-let-…"
              autoFocus
              className="w-full rounded-xl bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint font-mono transition-colors duration-200"
              onKeyDown={(e) => {
                if (e.key === "Enter") verify(lettaKey);
              }}
            />
            <p className="text-[12px] text-ink-faint leading-relaxed">
              Get one at{" "}
              <a
                href="https://app.letta.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-ink-muted underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-ink hover:decoration-[var(--color-accent)] transition-colors"
              >
                app.letta.com/api-keys
              </a>
              . Stored only in your browser — never sent anywhere except Letta.
            </p>
            <button
              onClick={() => verify(lettaKey)}
              disabled={loading}
              className="w-full rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 px-4 py-2.5 text-[14px] font-medium text-[var(--color-bubble-user-ink)] transition-all duration-200 active:scale-[0.98] shadow-warm"
            >
              {loading ? "Checking…" : "Continue"}
            </button>
            {error && (
              <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-md">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
