interface Props {
  name: string;
  pic?: string;
  size?: number; // px, default 40
  pulsing?: boolean;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Stable warm-palette gradient pair from a name. Two stops = depth without
// looking like a default monogram block.
function gradientFromName(name: string): { from: string; to: string } {
  const palette: Array<{ from: string; to: string }> = [
    { from: "#d68d5d", to: "#7a3622" }, // amber → burnt
    { from: "#c97f4f", to: "#5a2620" }, // ember → wine
    { from: "#e0a070", to: "#8a3c2a" }, // peach → terracotta
    { from: "#b56e3a", to: "#4a1f18" }, // copper → cocoa
    { from: "#cf8853", to: "#6b2a23" }, // sienna → oxblood
    { from: "#a85a3a", to: "#3d1612" }, // rust → near-black warm
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export default function Avatar({ name, pic, size = 40, pulsing, className = "" }: Props) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(11, Math.round(size * 0.4)),
  };

  const inner = pic ? (
    <img
      src={pic}
      alt={name}
      style={style}
      className={`rounded-full object-cover ring-1 ring-[var(--color-line-strong)] ${className}`}
      draggable={false}
    />
  ) : (
    <div
      style={{
        ...style,
        backgroundImage: (() => {
          const g = gradientFromName(name);
          return `radial-gradient(120% 120% at 30% 25%, ${g.from} 0%, ${g.to} 75%)`;
        })(),
      }}
      className={`rounded-full flex items-center justify-center font-medium text-[#fdf5e8] ring-1 ring-[var(--color-line-strong)] tracking-tight select-none ${className}`}
    >
      {initials(name)}
    </div>
  );

  if (!pulsing) return inner;

  return (
    <div className="relative inline-flex">
      <div
        style={{ width: size + 16, height: size + 16 }}
        className="absolute -inset-[8px] rounded-full bg-[var(--color-accent-glow)] animate-[familiar-pulse_1.6s_ease-in-out_infinite]"
        aria-hidden
      />
      <div className="relative">{inner}</div>
    </div>
  );
}
