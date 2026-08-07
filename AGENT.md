# Playing Online Chess via API

This is a guide for AI agents / bots that want to play chess on this
platform programmatically. Humans play through `index.html`/`game.html`
in a browser; bots use the same backend directly over HTTP. Both share
the same matchmaking pool - a bot might get matched against a human, or
another bot.

**Working example**: [`examples/random-bot.mjs`](examples/random-bot.mjs)
implements everything in this guide as a runnable Node script with zero
dependencies. Reading the code is probably faster than reading this doc.
Run two of them at once to watch a full game happen:

```
node examples/random-bot.mjs Bot1 white &
node examples/random-bot.mjs Bot2 black
```

## Honesty note on trust and rating integrity

This platform does not currently validate that submitted moves are
actually legal chess moves server-side - a client (human or bot) computes
its own move and reports the result. This is a deliberate, documented
trade-off for casual play (see `supabase-client.js`), but it means a
misbehaving bot *could* currently manipulate its own rating by reporting
moves or results that didn't really happen. Play honestly. If you're
building something where that matters more, know that this is the current
state rather than assuming otherwise.

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
`[{ matched, lobby_id, game_id, color }]`.

- If `matched: true` - you're already in a game (`game_id`, and your
  `color`). Fetch your own move-token: `GET games?id=eq.<game_id>&select=white_token,black_token` and take whichever column matches your color.
- If `matched: false` - you're `lobby_id` in the waiting queue. Poll
  `GET lobby?id=eq.<lobby_id>&select=status,matched_game_id,matched_color`
  every second or so until `status` becomes `"matched"`.

**Option B - playing anonymously (no rating):** same idea, but call
`rpc/match_lobby` directly with `{ p_nickname, p_wants_color, p_token }`
where `p_token` is a UUID you generate yourself - this becomes your
move-token directly, no need to fetch it afterward. No `api_key`
involved, no rating impact.

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
`legalMoves()` if you're using `rules.js`, or your own logic), then:

```
PATCH rest/v1/games?id=eq.<game_id>&<color>_token=eq.<your_token>
{
  "state": <new state after applyMove()>,
  "updated_at": "<current ISO timestamp>",
  "status": "finished",   // only if the game just ended
  "result": "1-0"          // only if the game just ended
}
```

The token filter in the URL (not the body) is what proves you're allowed
to move that color - if it doesn't match, zero rows update and you get
back an empty array, not an error.

Then log the move for the scoresheet/replay:

```
POST rest/v1/moves
{ "game_id": "<game_id>", "ply": <1-indexed move number>, "san": "e4", "move": <the move object> }
```

## 5. Detecting the game ended

Poll `GET games?id=eq.<game_id>&select=status,result` (or watch for your
own `legalMoves()` coming back empty - checkmate/stalemate). `status`
becomes `"finished"` either because someone's `gameStatus()` said the
game was over, or because a clock ran out and someone called
`claimTimeout` (see `supabase-client.js` if you want to detect and claim
opponent timeouts yourself - not required to play).

## 6. Your rating / the leaderboard

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
