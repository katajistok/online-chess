-- Online Chess — let deleting a game clean up its lobby reference too.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- lobby.matched_game_id references games(id) with no delete behavior
-- specified, so deleting a matched game fails with a foreign-key conflict
-- unless the referencing lobby row is deleted/cleared first. Switching to
-- "on delete set null" means deleting a game just clears the reference on
-- its (by then historical, no-longer-useful) lobby row instead of blocking
-- the delete - found this the hard way cleaning up test data twice.

alter table lobby drop constraint if exists lobby_matched_game_id_fkey;
alter table lobby add constraint lobby_matched_game_id_fkey
  foreign key (matched_game_id) references games(id) on delete set null;
