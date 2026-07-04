-- Familiar bridge schema.
-- One row per (Letta agent_id) — the relationship between a user and their agent
-- in this product is one-to-one, so we key on agent_id.

CREATE TABLE IF NOT EXISTS chat_state (
  agent_id           TEXT PRIMARY KEY,
  client_token       TEXT NOT NULL,        -- app-side auth (random, generated on init)
  mcp_secret         TEXT NOT NULL,        -- Letta-side auth for MCP tool calls
  user_status_text   TEXT,
  user_status_emoji  TEXT,
  user_presence      TEXT,                 -- "online" | "away" | "asleep" | null
  agent_status_text  TEXT,
  agent_status_emoji TEXT,
  agent_presence     TEXT,
  -- BYO ElevenLabs creds for voice features. Stored per-agent; updatable
  -- at runtime via the Settings page (no redeploy needed).
  elevenlabs_api_key TEXT,
  elevenlabs_voice_id TEXT,
  -- BYO KLIPY key for GIF search (Tenor's API shut down — new clients can't
  -- sign up, full EOL 2026-06-30). Get one free at klipy.com → Partner Panel.
  klipy_api_key TEXT,
  -- Legacy columns from the old bridge-cron autonomous flow. Autonomous
  -- check-ins now use Letta's native scheduling (POST /v1/agents/{id}/schedule),
  -- driven entirely from the browser, so nothing reads these anymore. Left in
  -- place on existing deployments; harmless. New deployments don't need them
  -- but creating them keeps old and new schemas aligned.
  autonomous_frequency_minutes INTEGER,
  last_autonomous_at INTEGER,
  dnd_until          INTEGER,
  letta_api_key      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_state_updated ON chat_state(updated_at);

-- Media messages — agent-pushed media that isn't part of Letta's text history.
-- kind = 'audio' → a voice note from send_voice_note; the mp3 lives in R2 under
--   storage_key, served via GET /audio/:id; `text` is the transcript.
-- kind = 'gif'   → a GIF from send_gif; `url` is the (Klipy CDN) image URL the
--   app renders directly; `text` is an optional caption; storage_key is ''.
-- The app polls /api/agents/:id/media/messages, dedupes by id, and slots each
-- bubble into the timeline by created_at. (`delivered_at` is vestigial — the
-- endpoint returns recent rows regardless; kept so old rows don't break.)
CREATE TABLE IF NOT EXISTS media_messages (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'audio',  -- 'audio' | 'gif'
  text         TEXT NOT NULL,             -- transcript (audio) / caption (gif, may be '')
  storage_key  TEXT NOT NULL,             -- R2 object key (audio); '' for gif
  url          TEXT,                      -- direct media URL (gif); null for audio
  emotion      TEXT,                      -- optional emotion label (audio)
  duration_ms  INTEGER,                   -- approximate duration if known (audio)
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES chat_state(agent_id)
);

CREATE INDEX IF NOT EXISTS idx_media_agent ON media_messages(agent_id, created_at);

-- Reactions on chat messages. One row per (agent, message, emoji, reactor)
-- — so the same reactor can add multiple distinct emojis to the same message,
-- but tapping the same emoji twice toggles it off rather than duplicating.
-- `message_id` is either the Letta message id (for text messages) or our own
-- media_messages.id (for voice/GIF bubbles); we don't care to distinguish on
-- this table since both id spaces are unique.
-- `reactor` is "user" for v1; reserved for agent ids in v2 when agents can
-- react back via an MCP tool.
CREATE TABLE IF NOT EXISTS reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  reactor     TEXT NOT NULL,                -- "user" | agent_id (v2)
  created_at  INTEGER NOT NULL,
  UNIQUE (agent_id, message_id, emoji, reactor),
  FOREIGN KEY (agent_id) REFERENCES chat_state(agent_id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(agent_id, message_id);
