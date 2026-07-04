import type { Appearance } from "../types";

// Defaults match the design tokens in index.css.
export const DEFAULT_APPEARANCE: Required<Appearance> = {
  bubbleUserHex: "#c97f4f",
  bubbleUserAlpha: 1,
  bubbleAgentHex: "#f5ede0",
  bubbleAgentAlpha: 0.07,
  backgroundPreset: "warm-base",
  backgroundCustomDataUrl: "",
  backgroundBlur: 0,
};

// Curated background presets. Each maps to a CSS background-image string.
// Keep these warm — no cyberpunk, no candy.
export const BACKGROUND_PRESETS: Array<{
  id: string;
  label: string;
  background: string;
}> = [
  {
    id: "warm-base",
    label: "Plain",
    background: "var(--color-base)",
  },
  {
    id: "ember-glow",
    label: "Ember glow",
    background:
      "radial-gradient(circle at 20% 0%, rgba(201,127,79,0.18), transparent 60%), radial-gradient(circle at 80% 100%, rgba(244,184,96,0.12), transparent 60%), var(--color-base)",
  },
  {
    id: "dusk-fade",
    label: "Dusk fade",
    background:
      "linear-gradient(180deg, #2a141d 0%, #1a0f15 60%, #120a0f 100%)",
  },
  {
    id: "candle-room",
    label: "Candle room",
    background:
      "radial-gradient(ellipse at 50% 100%, rgba(201,127,79,0.22), transparent 55%), linear-gradient(180deg, #1a0f15 0%, #0e070a 100%)",
  },
  {
    id: "ink-fog",
    label: "Ink fog",
    background:
      "linear-gradient(135deg, #1d121a 0%, #251621 35%, #190e15 100%)",
  },
  {
    id: "soft-paper",
    label: "Soft paper",
    background:
      "radial-gradient(circle at 30% 30%, rgba(245,237,224,0.04), transparent 50%), var(--color-base)",
  },
];

function clampAlpha(a: number | undefined): number {
  if (typeof a !== "number" || Number.isNaN(a)) return 1;
  return Math.max(0, Math.min(1, a));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function rgbaFromHex(hex: string, alpha = 1): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clampAlpha(alpha)})`;
}

// Pick legible text color (warm cream vs deep ink) based on the background's
// perceptual luminance. Used for user bubbles where the user can pick anything.
export function inkForBackground(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#f5ede0";
  // Effective alpha low enough → background shows through, just use cream.
  if (alpha < 0.5) return "#f5ede0";
  // Relative luminance (approximate sRGB).
  const l = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return l > 0.55 ? "#1a0d09" : "#f5ede0";
}

// Apply appearance to the document by setting CSS custom properties on :root
// and the chat-area background. Called once on mount and whenever appearance
// changes. Cleanup restores defaults so settings page preview unwinds cleanly.
export function applyAppearance(a: Appearance | undefined): void {
  const merged: Required<Appearance> = { ...DEFAULT_APPEARANCE, ...(a ?? {}) };
  const root = document.documentElement;
  root.style.setProperty(
    "--color-bubble-user",
    rgbaFromHex(merged.bubbleUserHex, merged.bubbleUserAlpha),
  );
  root.style.setProperty(
    "--color-bubble-user-ink",
    inkForBackground(merged.bubbleUserHex, merged.bubbleUserAlpha),
  );
  root.style.setProperty(
    "--color-bubble-agent",
    rgbaFromHex(merged.bubbleAgentHex, merged.bubbleAgentAlpha),
  );
  root.style.setProperty(
    "--color-bubble-agent-ink",
    inkForBackground(merged.bubbleAgentHex, merged.bubbleAgentAlpha),
  );

  let backgroundValue: string;
  if (merged.backgroundPreset === "custom" && merged.backgroundCustomDataUrl) {
    // Layer the photo under a warm darken so user-uploaded images don't
    // wash out the chat. Tinted overlay matches the base palette.
    backgroundValue = `linear-gradient(rgba(26,15,21,0.55), rgba(26,15,21,0.55)), url("${merged.backgroundCustomDataUrl}") center / cover no-repeat`;
  } else {
    const preset = BACKGROUND_PRESETS.find((p) => p.id === merged.backgroundPreset);
    backgroundValue = preset?.background ?? "var(--color-base)";
  }
  root.style.setProperty("--familiar-bg", backgroundValue);
  root.style.setProperty("--familiar-bg-blur", `${merged.backgroundBlur}px`);
}

// Resize a File to a max dimension and re-encode as JPEG. Used for custom
// backgrounds — keeps them well under 1 MB so localStorage doesn't choke.
export async function resizeImageFile(
  file: File,
  maxDim = 1600,
  quality = 0.82,
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("image load failed"));
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unsupported");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}
