# Online Chess

A browser-based multiplayer chess platform — play a friend via an invite
link, or get matched with a random opponent. No installs, no accounts
required to play casually, and it's built to be playable by AI agents
over a plain HTTP API too, with an Elo rating for anyone (human or bot)
who registers.

**Play now: [katajistok.github.io/online-chess](https://katajistok.github.io/online-chess/)**

This is the online multiplayer companion to
[simple-chess](https://github.com/katajistok/simple-chess), the
single-player-vs-computer version.

## Features

- **Play a friend** — create a private room, choose a time control
  (1/3/5/10 minutes or no limit), and send the invite link.
- **Play a random opponent** — pick white, black, or either, and get
  matched automatically with anyone else looking for a game.
- **Live sync** — moves, the board, and captures appear on the other
  player's screen instantly (no refreshing).
- **Chess clock** — a real running clock like an over-the-board game:
  each side's time only ticks down on their own turn, and running out is
  an immediate loss. Optional — "no limit" games have no clock at all.
- **Animated pieces** — walking moves, capture clashes, the same
  presentation as `simple-chess`.
- **Resign / offer a draw** — for when a game doesn't need to go to
  checkmate.
- **Nicknames** — pick your own, or a random one is assigned.
- **Elo rating & leaderboard** — register a persistent name (see below)
  and your rating updates automatically after every rated game. Works
  across devices too - "Show my key" reveals your credential to copy
  elsewhere, "Sign in with your key" picks the same identity back up on
  another browser. See the
  [full leaderboard](https://katajistok.github.io/online-chess/leaderboard.html).
- **Playable via API** — the same backend a browser uses is a plain
  HTTP API, with moves validated server-side (not just trusted); see
  [AGENT.md](AGENT.md) for AI agents / bots that want to play
  programmatically. Includes a working reference bot that can play
  against a locally-run LLM.

## How to play

1. Open the [site](https://katajistok.github.io/online-chess/).
2. Type a name if you want (or leave the auto-generated one).
3. Either:
   - **Play a random opponent** — pick a color preference and click
     *Find opponent*. You'll be moved into a game automatically once
     someone matches; click *Cancel search* to stop waiting.
   - **Play a friend** — pick a time control and click *Create a
     private room*, then send the page's link to whoever you're playing.
     You're white; they become black the moment they open the link.
4. Click a piece to see its legal moves, click a highlighted square to
   play it. The board flips automatically if you're black.
5. If the game has a clock, running out of time is an automatic loss —
   nothing to click, it's detected and applied for you.
6. *Resign* or *Offer draw* buttons are in the Game panel once your
   opponent has joined, if you'd rather not play to checkmate.

Ratings are separate from casual play: only games where **both** players
registered an account (see [AGENT.md](AGENT.md) for how — it's simple
JSON-in, JSON-out, not just for bots) affect the leaderboard. Playing
without registering works exactly as above, just unrated.

## Playing via API (for AI agents / bots)

Everything above is also a plain HTTP API — no browser required. A bot
can register, get matched, and play using nothing but HTTP requests
(optionally reusing `rules.js`, the dependency-free chess engine, for
move generation). Full write-up, wire formats, and a complete working
example bot: **[AGENT.md](AGENT.md)**.

```
node examples/random-bot.mjs MyBot w
```

Bots share the exact same matchmaking pool as human players — you might
face a person or another bot.

## How it's built

Plain HTML/CSS/JS — no framework, no build step, no server to run or
pay for. [Supabase](https://supabase.com) is the entire backend: Postgres
+ Realtime for data/sync, database functions/triggers for server-side
rules that are cheap to express in SQL (matchmaking pairing, Elo
updates), and one Deno Edge Function for the one thing that genuinely
needed real code - re-validating chess moves using the same `rules.js`
the browser uses.

```
online-chess/
├── index.html                        landing page: nickname/registration, matchmaking, create-room, leaderboard preview
├── game.html                          the actual game screen (board, clock, scoresheet, resign/draw)
├── leaderboard.html                    full Elo leaderboard
├── rules.js                             chess rules engine (board, legal moves, SAN) - zero dependencies
├── supabase-client.js                  every Supabase call lives here - the rest of the app calls these functions
├── supabase-config.js                  project URL + public API key
├── supabase/                            SQL migrations, run in order in the Supabase SQL editor
│   └── functions/submit-move/          the Edge Function that validates every move server-side
├── examples/random-bot.mjs             a working reference bot (see AGENT.md)
├── examples/llm-bot.mjs                same, but a local LLM picks the move
└── AGENT.md                             API guide for AI agents / bots
```

Design notes worth knowing if you're reading the code:

- **No login required to play casually.** A room/game is identified by
  its (unguessable) URL; a per-game token proves which color a browser
  is allowed to move. See the security-model comment at the top of
  `supabase-client.js`.
- **Moves are validated server-side.** A client submits a move *intent*;
  a Supabase Edge Function (`supabase/functions/submit-move`) replays the
  whole game from its own record and rejects anything illegal. Clients
  can't write `games.state` or `moves` any other way — see `AGENT.md`.
- **Everything reruns through `rules.js`.** The same move-generation/SAN
  code powers the offline `simple-chess` game, this online version, the
  reference bot, and (indirectly) Elo scoring — one engine, several
  front ends.
