-- Online Chess — stop clients from writing the board state directly.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- ONLY run this after confirming supabase/functions/submit-move works
-- (test a real move through it first) - this is the point where direct
-- client writes to games.state / moves stop working entirely, so
-- everything must go through the validated path from here on.
--
-- What stays exactly as before (none of these touch games.state, so none
-- of them need the validator): creating a room, joining, resigning,
-- offering/accepting/declining a draw, claiming a timeout, matchmaking.
-- Only the "submit an actual chess move" path changes.

revoke update (state) on games from anon;

drop policy if exists "anon full access moves" on moves;
create policy "anon read moves" on moves for select using (true);
-- Deliberately no insert/update/delete policy left for anon on moves -
-- only the submit-move function (running as service_role, which bypasses
-- RLS and column grants entirely) can write move history now.
