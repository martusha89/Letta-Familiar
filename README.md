<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8B5CF6,100:22D3EE&height=170&section=header&text=Familiar&fontColor=ffffff&fontSize=46&fontAlignY=40&desc=A%20beautiful%20chat%20client%20for%20your%20Letta%20agent&descSize=17&descAlignY=64" width="100%" />

[![npm version](https://img.shields.io/npm/v/familiar-letta?style=for-the-badge&logo=npm&logoColor=white&color=8B5CF6)](https://www.npmjs.com/package/familiar-letta)
[![license MIT](https://img.shields.io/badge/license-MIT-A855F7?style=for-the-badge)](LICENSE)
[![Letta](https://img.shields.io/badge/built%20for-Letta-22D3EE?style=for-the-badge)](https://www.letta.com)
[![deploy Cloudflare](https://img.shields.io/badge/deploy-Cloudflare-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://www.cloudflare.com)

</div>

You already have a Letta agent you like. What you don't have is a place to talk to it that feels like a real messaging app instead of a dev console. Familiar is that place: bring your own Letta key, deploy to your own Cloudflare account in one command, and chat with your agents in an app that does voice notes, GIFs, group rooms, and reaching out on its own.

No hosted middleman. Familiar doesn't run your agent, store your key, or bill you for AI. Letta does the thinking; Familiar is the room you meet in.

## Quick Start

```bash
npx familiar-letta deploy
```

That's it. The wizard checks your tools, deploys the bridge worker and the app to your Cloudflare account (free tier covers it), and hands you a URL. Open it, paste your Letta key, pick an agent, start talking. Familiar configures the agent itself: tools, instructions, and memory wiring are installed automatically and kept up to date every time you open the app.

You need Node.js 18+, a free [Cloudflare](https://www.cloudflare.com) account, and a [Letta API key](https://app.letta.com/api-keys).

## Features

- **A real conversation list.** Open the app and see your conversations, 1:1s and group rooms, each with its own isolated history (Letta native conversations, so a private chat never leaks into a room). One agent can be in many conversations.
- **Streaming chat.** Replies stream in live, tool calls render as small humanized activity notes, and the agent's avatar pulses while it thinks. Pagination all the way back.
- **Group rooms: your agents, talking to each other.** Put two or more agents in one room with you. Each one sees what the others say and decides for itself whether to speak or pass. `@name` someone and the rest hold back.
- **Voice notes.** Give your agent an ElevenLabs voice and it can answer with an actual voice note: a playable audio bubble with a waveform.
- **GIFs, both directions.** A built-in GIF picker with a favourites shelf for you, and a `send_gif` tool for the agent, so it can drop a reaction GIF the way a person would.
- **Images.** Attach photos, camera capture on mobile, automatic resizing before send.
- **Status and presence, both sides.** Avatars, display names, a status line, and a presence dot for you and the agent. It sets its own; it can also see yours, so it knows when you're around.
- **Autonomous check-ins.** The agent can reach out on its own schedule (Letta's native scheduling, not a bot loop), gated by do-not-disturb, quiet hours, and your presence so it never pings you at 3am.
- **Make it yours.** Bubble colors, background presets or your own image, blur, all applied live. Warm dark theme by default.

## Two agents, one room

Group rooms are not round-robin scripting. Every agent in the room gets the conversation as it happens and chooses to speak or stay quiet through a dedicated turn-taking tool; silence is the default, chiming in is a decision. Rooms come caged, because autonomous agents in one room is a beautiful way to generate infinite chatter: a burst cap on agent messages since you last spoke, a round limit, a wall-clock limit, and a stop button. Your next message always takes the floor.

Each member keeps its own scoped history of the room, separate from your private 1:1 with it, so the room becomes a place the agent remembers on its own terms.

## What your agent can do

Familiar installs a small set of tools onto your agent (via MCP) and teaches it how to use them. Existing agents pick up new tools automatically the next time you open the app.

| The agent calls | You see |
|---|---|
| `send_voice_note` | a playable voice bubble in its ElevenLabs voice |
| `send_gif` | a reaction GIF bubble |
| `set_my_status` | its status line updates under its name |
| `set_my_presence` | its presence dot changes |
| `room_turn` | it speaks in a group room, or deliberately passes |
| `get_user_status` / `get_user_presence` | nothing, but it knows whether you're around |

## How it works

- `app/` is a React + Vite + TypeScript + Tailwind PWA, deployed to Cloudflare Pages.
- `bridge/` is a single Cloudflare Worker with a D1 database and (optionally) an R2 bucket. It proxies the Letta API for the browser, stores media the agent sends, and serves the MCP tools above.
- Your Letta API key lives in your browser's local storage and talks to Letta through your own bridge. It is never stored server-side, and there is no server of ours to store it on.
- Voice needs an ElevenLabs key (yours), GIFs need a free [Klipy](https://klipy.com) key (yours). Both optional, both pasted in Settings.
- R2 requires a card on file with Cloudflare, even on the free tier. No R2? The deploy continues without it and everything except voice notes still works.

## Commands

```bash
npx familiar-letta deploy    # One-time setup: deploy bridge + app to your Cloudflare
npx familiar-letta status    # Show your deployment URLs and config
```

The npm package is `familiar-letta` (plain `familiar` on npm is an unrelated package). After a global install (`npm i -g familiar-letta`) the command is just `familiar`.

## Dev

```bash
# In one terminal, the bridge worker
cd bridge && npm run dev

# In another, the app
cd app && npm run dev
```

## Status

Beta. Chat, rooms, voice notes, GIFs, autonomous check-ins, and per-conversation history isolation all work; sharp edges are still being sanded. Issues and reports welcome.

## License

MIT
