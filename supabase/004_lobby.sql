-- Online Chess — nicknames + random-opponent matchmaking.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.

alter table games add column if not exists white_nickname text;
alter table games add column if not exists black_nickname text;

create table if not exists lobby (
  id bigint generated always as identity primary key,
  nickname text not null,
  wants_color text not null check (wants_color in ('w', 'b', 'either')),
  token uuid not null,                              -- the waiting player's own move-token, generated client-side
  status text not null default 'waiting' check (status in ('waiting', 'matched', 'cancelled')),
  matched_game_id uuid references games(id),
  matched_color text check (matched_color in ('w', 'b')),
  created_at timestamptz not null default now()
);

create index if not exists idx_lobby_waiting on lobby (wants_color, created_at) where status = 'waiting';

alter table lobby enable row level security;
create policy "anon full access lobby" on lobby for all using (true) with check (true);

alter publication supabase_realtime add table lobby;

-- Atomically pairs a new arrival with a compatible waiting entry, if one
-- exists, and creates their game in the same transaction - two people
-- clicking "find opponent" at the same instant can't both claim the same
-- waiting entry (`for update skip locked` on the select).
--
-- If a match is found: creates the game (seeding both tokens/nicknames
-- directly - each client already knows its own token, since it generated
-- it itself before calling this), marks the opponent's lobby row 'matched'
-- so their already-open Realtime subscription picks it up, and returns the
-- match directly to the caller (no need for the caller to wait/subscribe).
--
-- If no match: inserts this caller as a new waiting entry and returns
-- matched = false; the caller then subscribes to its own lobby row and
-- waits for a future caller to match it.
create or replace function match_lobby(p_nickname text, p_wants_color text, p_token uuid)
returns table (matched boolean, lobby_id bigint, game_id uuid, color text) as $$
declare
  v_opponent lobby%rowtype;
  v_game_id uuid;
  v_white_token uuid;
  v_black_token uuid;
  v_white_nick text;
  v_black_nick text;
  v_my_color text;
  v_lobby_id bigint;
  v_start_state jsonb := '{"board":["bR","bN","bB","bQ","bK","bB","bN","bR","bP","bP","bP","bP","bP","bP","bP","bP",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"wP","wP","wP","wP","wP","wP","wP","wP","wR","wN","wB","wQ","wK","wB","wN","wR"],"turn":"w","castling":{"wK":true,"wQ":true,"bK":true,"bQ":true},"ep":-1,"halfmove":0,"fullmove":1}'::jsonb;
begin
  select * into v_opponent
  from lobby
  where status = 'waiting'
    and (
      (p_wants_color = 'w' and wants_color in ('b', 'either')) or
      (p_wants_color = 'b' and wants_color in ('w', 'either')) or
      (p_wants_color = 'either' and wants_color in ('w', 'b', 'either'))
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if v_opponent.id is not null then
    if p_wants_color = 'w' or (p_wants_color = 'either' and v_opponent.wants_color = 'b') then
      v_white_token := p_token; v_white_nick := p_nickname; v_my_color := 'w';
      v_black_token := v_opponent.token; v_black_nick := v_opponent.nickname;
    else
      v_black_token := p_token; v_black_nick := p_nickname; v_my_color := 'b';
      v_white_token := v_opponent.token; v_white_nick := v_opponent.nickname;
    end if;

    insert into games (state, white_token, black_token, white_nickname, black_nickname, status)
    values (v_start_state, v_white_token, v_black_token, v_white_nick, v_black_nick, 'active')
    returning id into v_game_id;

    update lobby set status = 'matched', matched_game_id = v_game_id,
      matched_color = case when v_my_color = 'w' then 'b' else 'w' end
    where id = v_opponent.id;

    return query select true, v_opponent.id, v_game_id, v_my_color;
  else
    insert into lobby (nickname, wants_color, token) values (p_nickname, p_wants_color, p_token)
    returning id into v_lobby_id;

    return query select false, v_lobby_id, null::uuid, null::text;
  end if;
end;
$$ language plpgsql security definer;
