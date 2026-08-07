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
- **Nicknames** — pick your own, or a random one is assigned.
- **Elo rating & leaderboard** — register a persistent name (see below)
  and your rating updates automatically after every rated game. See the
  [full leaderboard](https://katajistok.github.io/online-chess/leaderboard.html).
- **Playable via API** — the same backend a browser uses is a plain
  HTTP API; see [AGENT.md](AGENT.md) for AI agents / bots that want to
  play programmatically.

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
pay for. [Supabase](https://supabase.com) (Postgres + Realtime) is the
entire backend; every "server-side" rule (matchmaking pairing, Elo
updates) is a Postgres function or trigger, called directly from the
browser or a bot's HTTP client.

```
online-chess/
├── index.html            landing page: nickname, matchmaking, create-room, leaderboard preview
├── game.html              the actual game screen (board, clock, scoresheet)
├── leaderboard.html        full Elo leaderboard
├── rules.js                 chess rules engine (board, legal moves, SAN) - zero dependencies
├── supabase-client.js      every Supabase call lives here - the rest of the app calls these functions
├── supabase-config.js      project URL + public API key
├── supabase/                SQL migrations, run in order in the Supabase SQL editor
├── examples/random-bot.mjs  a working reference bot (see AGENT.md)
└── AGENT.md                 API guide for AI agents / bots
```

Design notes worth knowing if you're reading the code:

- **No login required to play casually.** A room/game is identified by
  its (unguessable) URL; a per-game token proves which color a browser
  is allowed to move. See the security-model comment at the top of
  `supabase-client.js`.
- **Trust model.** Moves aren't validated server-side — a client
  computes and reports its own move. Fine for casual play; the honesty
  trade-off this creates for rated games is spelled out in `AGENT.md`.
- **Everything reruns through `rules.js`.** The same move-generation/SAN
  code powers the offline `simple-chess` game, this online version, the
  reference bot, and (indirectly) Elo scoring — one engine, several
  front ends.
