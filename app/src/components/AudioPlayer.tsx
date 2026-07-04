import { useEffect, useRef, useState } from "react";

interface Props {
  src: string;
  emotion?: string | null;
  // Optional fallback text to show as a caption beneath the player.
  caption?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AudioPlayer({ src, emotion, caption }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    function onPlay() { setPlaying(true); }
    function onPause() { setPlaying(false); }
    function onEnded() { setPlaying(false); setTime(0); }
    function onTimeUpdate() {
      if (a) setTime(a.currentTime);
    }
    function onLoadedMetadata() {
      if (a && Number.isFinite(a.duration)) setDuration(a.duration);
      setLoading(false);
    }
    function onLoadStart() { setLoading(true); }
    function onCanPlay() { setLoading(false); }
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("loadedmetadata", onLoadedMetadata);
    a.addEventListener("loadstart", onLoadStart);
    a.addEventListener("canplay", onCanPlay);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("loadedmetadata", onLoadedMetadata);
      a.removeEventListener("loadstart", onLoadStart);
      a.removeEventListener("canplay", onCanPlay);
    };
  }, []);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play();
    } else {
      a.pause();
    }
  }

  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <div className="space-y-2 min-w-[220px] max-w-[340px]">
      <div className="flex items-center gap-2.5">
        <button
          onClick={toggle}
          className="shrink-0 w-9 h-9 rounded-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-bubble-user-ink)] flex items-center justify-center transition-all duration-200 active:scale-95"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-4 h-4"
            >
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-4 h-4 ml-0.5"
            >
              <path d="M8 5l11 7-11 7V5z" />
            </svg>
          )}
        </button>
        <div className="flex-1 min-w-0">
          {/* Static "waveform" — 14 bars, varied heights for visual interest */}
          <div className="flex items-end gap-[2px] h-6 mb-0.5">
            {Array.from({ length: 24 }).map((_, i) => {
              const seed = (i * 97 + 13) % 100;
              const baseHeight = 35 + (seed % 60);
              const isPast = (i / 24) * 100 < progress;
              return (
                <span
                  key={i}
                  className="flex-1 rounded-full transition-colors duration-200"
                  style={{
                    height: `${baseHeight}%`,
                    background: isPast
                      ? "var(--color-bubble-user-ink, #1a0d09)"
                      : "currentColor",
                    opacity: isPast ? 0.85 : 0.35,
                  }}
                />
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] tabular opacity-70">
            <span>{loading ? "…" : formatTime(playing ? time : duration || time)}</span>
            {emotion && (
              <span className="opacity-70">· {emotion}</span>
            )}
          </div>
        </div>
      </div>
      {caption && (
        <div>
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="flex items-center gap-1 text-[10.5px] opacity-50 hover:opacity-80 transition-opacity duration-150"
            aria-expanded={showTranscript}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-3 h-3 transition-transform duration-200"
              style={{ transform: showTranscript ? "rotate(90deg)" : "rotate(0deg)" }}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span>transcript</span>
          </button>
          {showTranscript && (
            <p
              className="text-[12px] opacity-80 leading-relaxed italic mt-1"
              style={{ animation: "familiar-fade-up 180ms ease-out both" }}
            >
              "{caption}"
            </p>
          )}
        </div>
      )}
      <audio ref={audioRef} src={src} preload="metadata" />
    </div>
  );
}
