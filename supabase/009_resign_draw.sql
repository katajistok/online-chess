-- Online Chess — resignation and draw offers.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.

alter table games add column if not exists end_reason text;
alter table games add column if not exists draw_offered_by text check (draw_offered_by in ('w', 'b'));
