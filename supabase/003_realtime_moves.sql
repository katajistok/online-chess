-- Online Chess — enable realtime on the moves table too.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- schema.sql only added `games` to the realtime publication. The client
-- also listens for new rows in `moves` (to know exactly which move just
-- happened, for animation) - without this, that channel never fires.

alter publication supabase_realtime add table moves;
