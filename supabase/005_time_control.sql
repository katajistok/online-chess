-- Online Chess — traditional running chess clock.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Each player has a total time bank that only depletes on their own turn.
-- `turn_started_at` marks when the current player's turn began; combined
-- with their stored remaining time, that's enough to compute a live
-- countdown client-side without a new value on every tick. On each move,
-- the mover's remaining time is updated (their elapsed thinking time
-- subtracted) and turn_started_at resets for the next player.
-- time_limit_seconds = null means no clock at all for that game.

alter table games add column if not exists time_limit_seconds int default 180;
alter table games add column if not exists white_time_remaining_ms bigint;
alter table games add column if not exists black_time_remaining_ms bigint;
alter table games add column if not exists turn_started_at timestamptz;
