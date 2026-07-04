import { useEffect, useRef, useState } from "react";
import * as bridge from "../api/bridge";
import type { GifResult } from "../api/bridge";
import {
  loadGifFavorites,
  toggleGifFavorite,
  isGifFavorited,
  type GifFavorite,
} from "../lib/gifFavorites";

interface Props {
  bridgeUrl: string;
  clientToken: string;
  agentId: string;
  onPick: (gifUrl: string) => void;
  onClose: () => void;
}

// Seed chips shown above the grid so there's always something to tap. A blank
// query asks the bridge for KLIPY trending, so the picker opens populated.
const TRENDING_QUERIES = ["happy", "lol", "yes", "no", "love", "tired", "hug", "yay"];

export default function GifPicker({ bridgeUrl, clientToken, agentId, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Favourites — starred GIFs in localStorage. `showFavorites` swaps the grid
  // to the saved list so a GIF can be re-sent without searching again.
  const [favorites, setFavorites] = useState<GifFavorite[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Outside click / Esc closes the popover.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  // Load favourites + autofocus on mount.
  useEffect(() => {
    setFavorites(loadGifFavorites());
    inputRef.current?.focus();
  }, []);

  // Debounced search. Empty query → bridge returns KLIPY trending, so the grid
  // is populated the moment the picker opens (and whenever the box is cleared).
  useEffect(() => {
    if (showFavorites) return;
    const q = query.trim();
    setSearching(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const r = await bridge.searchGifs({ bridgeUrl, clientToken }, agentId, q);
        setResults(r);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("klipy_not_configured")) {
          setError("Add a KLIPY API key in Settings → GIFs first.");
        } else {
          setError(msg);
        }
      } finally {
        setSearching(false);
      }
    }, q ? 320 : 0);
    return () => clearTimeout(handle);
  }, [query, showFavorites, agentId, bridgeUrl, clientToken]);

  function handleToggleFavorite(gif: GifResult) {
    setFavorites((prev) => toggleGifFavorite(prev, gif));
  }

  const gridItems: GifResult[] = showFavorites ? favorites : results;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full mb-2 left-3 right-3 sm:left-auto sm:right-auto sm:w-[420px] rounded-2xl border border-[var(--color-line-strong)] bg-[var(--color-overlay)] shadow-warm-lg p-3 z-20"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setShowFavorites(false);
          setQuery(e.target.value);
        }}
        placeholder="Search Klipy"
        className="w-full rounded-lg bg-[var(--color-raised)] border border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint mb-2"
      />

      {/* Favourites toggle + trending chips */}
      <div className="flex flex-wrap gap-1 mb-2.5">
        <button
          type="button"
          onClick={() => setShowFavorites((v) => !v)}
          aria-pressed={showFavorites}
          className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition ${
            showFavorites
              ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-ink"
              : "border-[var(--color-line)] bg-[var(--color-raised)] text-ink-faint hover:text-ink"
          }`}
        >
          <svg viewBox="0 0 24 24" fill={showFavorites ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
            <path d="M12 17.3 6.2 20.5l1.1-6.5L2.5 9.3l6.5-.9L12 2.5l3 5.9 6.5.9-4.8 4.7 1.1 6.5z" />
          </svg>
          Favourites{favorites.length > 0 ? ` (${favorites.length})` : ""}
        </button>
        {TRENDING_QUERIES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setShowFavorites(false);
              setQuery(t);
            }}
            className="rounded-full border border-[var(--color-line)] bg-[var(--color-raised)] px-2.5 py-1 text-[11px] text-ink-faint hover:text-ink transition"
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 px-2 py-1.5 rounded-md mb-2">
          {error}
        </p>
      )}
      {showFavorites && gridItems.length === 0 && (
        <p className="text-[12px] text-ink-faint">No favourites yet. Tap the star on any GIF to save it.</p>
      )}
      {!showFavorites && searching && results.length === 0 && (
        <p className="text-[12px] text-ink-faint">Searching…</p>
      )}
      {!showFavorites && !searching && results.length === 0 && !error && (
        <p className="text-[12px] text-ink-faint">No results.</p>
      )}

      {gridItems.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 max-h-[280px] overflow-y-auto">
          {gridItems.map((g) => {
            const fav = isGifFavorited(favorites, g.id);
            return (
              <div
                key={g.id}
                className="group relative aspect-square rounded-md overflow-hidden border border-[var(--color-line)] hover:border-[var(--color-accent)] transition-all duration-150"
              >
                <button
                  onClick={() => onPick(g.url)}
                  className="block w-full h-full active:scale-95 transition-transform"
                  aria-label={g.description || "GIF"}
                >
                  <img
                    src={g.preview}
                    alt={g.description || ""}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite(g);
                  }}
                  aria-label={fav ? "Remove from favourites" : "Add to favourites"}
                  aria-pressed={fav}
                  className={`absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm transition hover:bg-black/70 ${
                    fav ? "text-amber-300" : "text-white/85"
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M12 17.3 6.2 20.5l1.1-6.5L2.5 9.3l6.5-.9L12 2.5l3 5.9 6.5.9-4.8 4.7 1.1 6.5z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[9.5px] tracking-wide uppercase text-ink-faint mt-2 text-right opacity-60">
        GIFs via KLIPY
      </p>
    </div>
  );
}
