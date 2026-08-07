-- Online Chess — Supabase schema
-- Paste this into the Supabase dashboard: SQL Editor -> New query -> Run.

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  state jsonb not null,               -- rules.js state object: {board, turn, castling, ep, halfmove, fullmove}
  white_token uuid not null default gen_random_uuid(),  -- room creator's "credential", kept in their browser only
  black_token uuid,                                      -- assigned when the second player joins
  result text,                        -- '1-0' | '0-1' | '1/2-1/2', set when status = 'finished'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists moves (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  ply int not null,                   -- 1-indexed half-move number
  san text not null,                  -- e.g. "Nf3", "exd5=Q+", "O-O"
  move jsonb not null,                -- raw move object from rules.js (from/to/flag/promo/...)
  created_at timestamptz not null default now()
);

create index if not exists idx_moves_game on moves (game_id, ply);
create index if not exists idx_games_status on games (status) where status <> 'finished';

alter table games enable row level security;
alter table moves enable row level security;

-- MVP policy: anyone holding the publishable key can read/write any row.
-- There's no per-player enforcement in the database yet - the room id (a UUID,
-- shared only via the invite link) and the white/black tokens are what keep
-- games private in practice. This is an acceptable trade-off for a casual,
-- non-competitive game between friends; it is NOT suitable if this ever needs
-- real anti-cheat or private data. Revisit with token-scoped policies if so.
create policy "anon full access games" on games for all using (true) with check (true);
create policy "anon full access moves" on moves for all using (true) with check (true);

-- Push realtime updates whenever a game row changes (used to sync moves live).
alter publication supabase_realtime add table games;
