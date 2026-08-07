-- Online Chess — give matched (random-opponent) games a working clock too.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Redefines match_lobby() (same signature, from 004_lobby.sql) to also set
-- time_limit_seconds/white_time_remaining_ms/black_time_remaining_ms/
-- turn_started_at on the game it creates. Matched games start 'active'
-- immediately (both players are already present), so unlike the
-- invite-link flow, the clock can start right at creation - no separate
-- "waiting for opponent" phase to worry about.
--
-- Fixed at 3 minutes per side for now (matchmaking doesn't let the two
-- strangers negotiate a time control - the invite-link flow, where you're
-- creating a room for a specific friend, is where that's configurable).

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
  v_time_limit int := 180;
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

    insert into games (
      state, white_token, black_token, white_nickname, black_nickname, status,
      time_limit_seconds, white_time_remaining_ms, black_time_remaining_ms, turn_started_at
    )
    values (
      v_start_state, v_white_token, v_black_token, v_white_nick, v_black_nick, 'active',
      v_time_limit, v_time_limit * 1000, v_time_limit * 1000, now()
    )
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
