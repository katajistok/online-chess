-- Online Chess — usage logging (run this after schema.sql, once).
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Append-only log of what's happening (room created, player joined, move
-- made, game finished) so you can see usage over time via the SQL editor
-- or Table Editor - not shown to visitors. Separate from the live
-- front-page counters, which read directly from `games`.

create table if not exists events (
  id bigint generated always as identity primary key,
  event_type text not null,   -- 'room_created' | 'player_joined' | 'move_made' | 'game_finished'
  game_id uuid references games(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_type_time on events (event_type, created_at desc);

alter table events enable row level security;

-- Append-only from the client's point of view: anyone can log an event or
-- read the log, nobody can edit/delete past entries via the public key.
create policy "anon insert events" on events for insert with check (true);
create policy "anon read events" on events for select using (true);
