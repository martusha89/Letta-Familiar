import type { Profile } from "../types";
import Avatar from "./Avatar";

interface Props {
  profile: Profile;
  fallbackName?: string;
  align?: "left" | "right";
  pulsing?: boolean;
  presence?: string; // "online" | "away" | "asleep" | undefined
  onClick: () => void;
}

function presenceColor(p?: string): string | null {
  if (p === "online") return "#6ba879"; // warm sage
  if (p === "away") return "#d68d5d"; // accent amber
  if (p === "asleep") return "#6b6068"; // warm gray
  return null;
}

export default function ProfileCard({
  profile,
  fallbackName,
  align = "left",
  pulsing,
  presence,
  onClick,
}: Props) {
  const displayName = profile.name?.trim() || fallbackName || "—";
  const status = profile.status;
  const isRight = align === "right";
  const dot = presenceColor(presence);

  const statusLine = pulsing
    ? "typing…"
    : status
      ? `${status.emoji ? status.emoji + " " : ""}${status.text}`
      : isRight
        ? "tap to set status"
        : "—";

  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2.5 rounded-xl px-2 py-1.5 -mx-2 transition-colors duration-200 hover:bg-[var(--color-line)] active:bg-[var(--color-line-strong)] min-w-0 ${
        isRight ? "flex-row-reverse text-right" : ""
      }`}
      aria-label={`Edit ${displayName}'s profile`}
    >
      <span className="shrink-0">
        <Avatar name={displayName} pic={profile.pic} size={40} pulsing={pulsing} />
      </span>
      <div className="min-w-0 max-w-[180px] sm:max-w-[220px] overflow-hidden">
        <div className="text-[13px] font-medium tracking-tight text-ink truncate leading-tight">
          {displayName}
        </div>
        <div
          className={`text-[11px] leading-snug mt-0.5 line-clamp-2 break-words ${
            pulsing ? "text-accent" : "text-ink-dim"
          }`}
          title={presence ? `${presence} · ${statusLine}` : statusLine}
        >
          {dot && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
              style={{ backgroundColor: dot }}
              aria-label={`presence: ${presence}`}
            />
          )}
          {statusLine}
        </div>
      </div>
    </button>
  );
}
