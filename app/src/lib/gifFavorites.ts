// GIF favourites — local-only list of GIFs the user starred in the picker.
// Stored in localStorage (per-device, no bridge round-trip) so favourites
// survive reloads and are instantly available the next time the picker opens.
// The full GIF record is saved (not just an id) so favourites render and can be
// picked without re-running a Klipy search.

const FAVORITES_KEY = "familiar.gif_favorites";
const MAX_FAVORITES = 60; // newest-first cap — keeps the list and storage sane

export type GifFavorite = {
  id: string;
  preview: string;
  url: string;
  description: string;
};

export function loadGifFavorites(): GifFavorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: keep only well-formed records (storage can be hand-edited or
    // written by an older shape).
    return parsed.filter(
      (g): g is GifFavorite =>
        g && typeof g.id === "string" && typeof g.url === "string",
    );
  } catch {
    return [];
  }
}

function save(list: GifFavorite[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // quota / private-mode — favourites are a nicety, never break the picker.
  }
}

export function isGifFavorited(list: GifFavorite[], id: string): boolean {
  return list.some((g) => g.id === id);
}

/**
 * Toggle a GIF's favourite state and persist. Returns the new list so the
 * caller can update React state from the same value that was stored.
 * Newly-favourited GIFs go to the front (most-recent-first).
 */
export function toggleGifFavorite(list: GifFavorite[], gif: GifFavorite): GifFavorite[] {
  const next = isGifFavorited(list, gif.id)
    ? list.filter((g) => g.id !== gif.id)
    : [
        { id: gif.id, preview: gif.preview, url: gif.url, description: gif.description },
        ...list,
      ].slice(0, MAX_FAVORITES);
  save(next);
  return next;
}
