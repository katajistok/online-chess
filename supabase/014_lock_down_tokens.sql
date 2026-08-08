-- Online Chess — stop broadcasting white_token/black_token to every
-- Realtime subscriber of a `games` row, including strangers who found the
-- game through the new public "watch a game" directory rather than a
-- private invite link.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Run `select version();` first - column lists on publications need
-- Postgres 15+.
--
-- Scope, deliberately: this closes the *passive* leak - today every
-- connected spectator's browser silently receives both tokens on every
-- single move, zero effort required, just from having the game open.
-- It does NOT touch REST/PostgREST-level column grants, because
-- resignGame/claimTimeout/respondToDraw/joinRoom all authorize their
-- writes with `.eq("white_token"/"black_token", myToken)` WHERE clauses -
-- Postgres requires SELECT privilege on a column to reference it in a
-- WHERE clause at all, even inside an UPDATE, so revoking SELECT on these
-- columns would silently break resigning/timeout-claiming/draw-responding/
-- joining for every anonymous player, not just spectators. Fixing that
-- properly means moving those four operations into SECURITY DEFINER RPCs
-- (like the *_as_player functions in 008_players_elo.sql already do for
-- registered players) - out of scope for now. Residual risk: a visitor
-- who deliberately crafts a raw REST call (`?select=white_token`) against
-- one specific game they found in the directory can still pull that
-- game's tokens. That matches the trust model schema.sql already
-- documents for "a friend with the link who opens devtools" - this
-- migration just stops handing tokens to everyone automatically.

-- No "just narrow the column list" ALTER form exists - DROP+re-ADD with
-- an explicit list is how you narrow what's replicated. Only touches
-- games' own entry in the publication; moves/lobby (also in
-- supabase_realtime) are untouched.
alter publication supabase_realtime drop table games;
alter publication supabase_realtime add table games (
  id, status, state, result, end_reason, draw_offered_by,
  white_nickname, black_nickname, time_limit_seconds,
  white_time_remaining_ms, black_time_remaining_ms, turn_started_at,
  white_player_id, black_player_id, created_at, updated_at
);
