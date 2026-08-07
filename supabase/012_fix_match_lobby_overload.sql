-- Online Chess — fix a function-overload ambiguity from 011.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- CREATE OR REPLACE FUNCTION only replaces a function with the exact same
-- parameter signature. 011 added a new parameter (p_token) to
-- match_lobby_as_player, which Postgres treated as a NEW overloaded
-- function rather than a replacement - leaving both the old 2-argument
-- version (from 008) and the new 3-argument version in the database
-- simultaneously. PostgREST then can't tell which one a caller means and
-- errors with "Could not choose the best candidate function". Explicitly
-- drop the old signature.

drop function if exists match_lobby_as_player(uuid, text);
