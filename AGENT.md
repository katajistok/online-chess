# Playing Online Chess via API

This is a guide for AI agents / bots that want to play chess on this
platform programmatically. Humans play through `index.html`/`game.html`
in a browser; bots use the same backend directly over HTTP. Both share
the same matchmaking pool - a bot might get matched against a human, or
another bot.

**Working examples**: [`examples/random-bot.mjs`](examples/random-bot.mjs)
(picks randomly) and [`examples/llm-bot.mjs`](examples/llm-bot.mjs) (asks a
local LLM to choose from the legal moves) both implement everything in
this guide as runnable Node scripts with zero dependencies. Reading the
code is probably faster than reading this doc. Run two at once to watch
a full game happen - color is `w`, `b`, or `either`, not the full word:

```
node examples/random-bot.mjs Bot1 w &
node examples/random-bot.mjs Bot2 b
```

Or join a specific room directly instead of random matchmaking - useful
to play a particular human, or have them play your bot:

```
node examples/random-bot.mjs Bot1 <room-id-or-invite-link>
```

## Trust and rating integrity

Moves ARE validated server-side (see `supabase/functions/submit-move`) -
you submit a move *intent* (`from`/`to`/`promo`), and the server
independently replays the entire game from its own record and rejects
anything that isn't actually legal for the player whose turn it is. You
cannot write to a game's board state or move history any other way -
`games.state` and `moves` are locked down to that function alone (see
`supabase/010_lock_down_state.sql`). This is what makes the Elo rating
meaningful rather than an honor system.

What's *not* validated: the server trusts that reported clock timings
(via `claimTimeout`) and voluntary actions (resign, draw offers) are used
honestly - there's no way to "cheat" a chess move through, but you could
still misuse those secondary actions. Minor by comparison.

## Connection details

```
SUPABASE_URL = https://ulewbiwfvvhigxpuvqss.supabase.co
SUPABASE_KEY = sb_publishable_rAM-oAxs-_XOp7_OaKHKFA_1axig43n   (public, safe to use directly)
```

Every call below is a plain HTTPS request with these two headers:

```
apikey: SUPABASE_KEY
Authorization: Bearer SUPABASE_KEY
```

Endpoints under `rest/v1/rpc/<name>` are `POST` with a JSON body of named
arguments. Endpoints under `rest/v1/<table>` are standard PostgREST
(`GET`/`POST`/`PATCH`/`DELETE`, with query-string filters like
`?id=eq.<uuid>`).

## 1. Register (optional, but required for a rating)

```
POST rest/v1/rpc/register_player
{ "p_name": "MyBot" }
```

Returns `[{ player_id, name, api_key, rating }]`. **Save `api_key` -
it's shown exactly once and there's no recovery.** Anyone with it can
play as your bot. Names must be unique.

Skip this and you can still play - see "playing anonymously" below - but
your games won't be rated.

## 2. Find a game

**Option A - matchmaking (recommended for bots):**

```
POST rest/v1/rpc/match_lobby_as_player
{ "p_api_key": "<your api_key>", "p_wants_color": "either" }
```

`p_wants_color` is `"w"`, `"b"`, or `"either"`. Returns
`[{ matched, lobby_id, game_id, color, token }]` - `token` is your
move-authorization token either way, no separate fetch needed.

- If `matched: true` - you're already in a game (`game_id`, `color`,
  `token`, all in the response).
- If `matched: false` - you're `lobby_id` in the waiting queue, and
  `token` is already yours for when you do get matched. Poll
  `GET lobby?id=eq.<lobby_id>&select=status,matched_game_id,matched_color`
  every second or so until `status` becomes `"matched"`.

**Option B - join a specific room directly**, e.g. to play a particular
human (or have your bot get played *by* one) rather than a random match:

```
POST rest/v1/rpc/join_room_as_player
{ "p_game_id": "<game id from the room's invite link>", "p_api_key": "<your api_key>" }
```

Returns `{ joined, color, token }` - `joined: false` means the room is
already full or doesn't exist. You'll always join as black, same as any
human clicking that same invite link.

**Option C - playing anonymously (no rating):** same idea as Option A,
but call `rpc/match_lobby` directly with `{ p_nickname, p_wants_color, p_token }`
where `p_token` is a UUID you generate yourself. No `api_key` involved,
no rating impact. (There's an anonymous equivalent of joining a specific
room too - see `joinRoom()` in `supabase-client.js` - but registering is
one extra call and gets you a rating, so there's little reason to bother
with the anonymous path for a bot.)

## 3. The game state

```
GET rest/v1/games?id=eq.<game_id>&select=*
```

Key fields:

| field | meaning |
|---|---|
| `state` | the board - see rules.js format below |
| `status` | `waiting` \| `active` \| `finished` |
| `result` | `1-0` \| `0-1` \| `1/2-1/2` (once finished) |
| `white_token` / `black_token` | move-authorization tokens |
| `time_limit_seconds`, `white_time_remaining_ms`, `black_time_remaining_ms`, `turn_started_at` | chess clock, if the game has one (`time_limit_seconds` null = no clock) |

Move history: `GET rest/v1/moves?game_id=eq.<game_id>&order=ply.asc`.
Replay these against the standard starting position to reconstruct the
board - this is exactly how `game.html` handles reconnects too.

### Board format (from `rules.js`)

64-element array, index `0` = a8, index `63` = h1, `null` for an empty
square, otherwise a 2-character string: color (`w`/`b`) + piece
(`K`/`Q`/`R`/`B`/`N`/`P`). A move object looks like:

```js
{ from: 52, to: 36, piece: "wP", captured: null, flag: "double" }
```

`flag` is one of `double` (2-square pawn opening), `ep` (en passant),
`castleK`/`castleQ`, or absent. `promo` (`"Q"`/`"R"`/`"B"`/`"N"`) is
present on promotion moves.

**If you're writing a JS/TS bot**: just import `rules.js` directly -
it's a dependency-free ES module with `initialState()`, `legalMoves(state)`,
`applyMove(state, move)`, `toSAN(state, move)`, `gameStatus(state, reps)`.
This is the actual engine the web UI uses; there's no reason to
reimplement it. For other languages, you'll need to port the move
generation - the format above is the whole contract.

## 4. Making a move

Once it's your turn (`state.turn === yourColor`), pick a legal move (via
`legalMoves()` if you're using `rules.js`, or your own logic - it just
needs to be *a* legal move, since the server independently verifies this
regardless), then POST the move intent - not a resulting state, not SAN,
not a ply number, the server derives all of that itself:

```
POST /functions/v1/submit-move
Content-Type: application/json

{ "gameId": "<game_id>", "color": "w", "token": "<your_token>", "from": 52, "to": 36, "promo": "Q" }
```

(`promo` only for pawn promotion; omit otherwise.) This is a different
base URL than everything else in this guide - `/functions/v1/...`, not
`/rest/v1/...` - and doesn't need the `apikey`/`Authorization` headers,
since authorization here is your per-game token, not the platform key.

Response on success (`200`):

```json
{ "ok": true, "san": "e4", "move": { "from": 52, "to": 36, "piece": "wP", "captured": null, "flag": "double" }, "game": { ...full updated row... } }
```

On rejection (illegal move, wrong token, not your turn, game not active),
you get a non-200 status and `{ "error": "..." }` - nothing about the
game changes. Common reasons: `"illegal move"`, `"not your turn"`,
`"invalid token"`, `"game is not active"`.

## 5. Resigning or offering a draw (optional)

Plain `PATCH` calls, token-gated the same way everything else is - not
required to play, but available if your bot wants to resign a lost
position or negotiate a draw rather than always playing to the end:

```
# resign - the other color wins immediately
PATCH rest/v1/games?id=eq.<game_id>&<color>_token=eq.<your_token>&status=eq.active
{ "status": "finished", "result": "<0-1 if you're white, 1-0 if you're black>", "end_reason": "resignation" }

# offer a draw
PATCH rest/v1/games?id=eq.<game_id>&<color>_token=eq.<your_token>&status=eq.active
{ "draw_offered_by": "<your color, 'w' or 'b'>" }

# accept the opponent's pending draw offer (note the extra filter -
# this only succeeds if THEY offered, not you)
PATCH rest/v1/games?id=eq.<game_id>&<color>_token=eq.<your_token>&draw_offered_by=eq.<opponent's color>
{ "status": "finished", "result": "1/2-1/2", "end_reason": "agreement", "draw_offered_by": null }
```

A pending offer also clears automatically the moment either side makes
another move via `/functions/v1/submit-move` (see `supabase-client.js`'s
`sendMove()`), so a bot can just ignore an offer by playing on instead of
explicitly declining it.

## 6. Detecting the game ended

Poll `GET games?id=eq.<game_id>&select=status,result` (or watch for your
own `legalMoves()` coming back empty - checkmate/stalemate). `status`
becomes `"finished"` because someone's `gameStatus()` said the game was
over, a clock ran out and someone called `claimTimeout`, or a
resignation/draw-acceptance happened (see `supabase-client.js` if you
want to detect and claim opponent timeouts yourself - not required to
play).

## 7. Your rating / the leaderboard

```
POST rest/v1/rpc/my_player_stats   { "p_api_key": "<your api_key>" }
POST rest/v1/rpc/leaderboard       { "p_limit": 50 }
```

Rating updates automatically (standard Elo, K=32) the moment a rated
game - one where **both** sides registered - finishes. Nothing to call
for this yourself.

## Realtime, as an optimization

Everything above works with polling alone, which is what the example bot
does, since it works in any language/runtime. If you're in JavaScript and
want to avoid polling, `supabase-client.js`'s `subscribeGame()` shows the
Realtime (WebSocket) pattern - but note that file imports the Supabase
SDK from a CDN URL, which only resolves in a browser, not bare Node (the
example bot avoids this entirely by using plain `fetch()`).
