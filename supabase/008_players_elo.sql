-- Online Chess — registered players + Elo rating (for API/bot play).
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Casual anonymous play (everything that already works) is untouched -
-- this is entirely opt-in. A game only affects rating when BOTH sides are
-- registered players (games.white_player_id / black_player_id set).
--
-- Honesty note: this computes Elo from whatever `result` a game ends with,
-- but nothing here validates that the moves leading to that result were
-- actually legal - the whole platform runs on a trust model (see
-- supabase-client.js's security-model comment). A misbehaving bot could
-- currently manipulate its own rating. Real server-side move validation
-- (re-running rules.js in an Edge Function before accepting each move)
-- would close that gap but is a separate, larger piece of work - this is
-- an honor-system rating for now, and AGENT.md says so explicitly.

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  api_key uuid not null default gen_random_uuid(),
  rating numeric not null default 1200,
  games_played int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  created_at timestamptz not null default now()
);

alter table games add column if not exists white_player_id uuid references players(id);
alter table games add column if not exists black_player_id uuid references players(id);
alter table lobby add column if not exists player_id uuid references players(id);

alter table players enable row level security;
-- Deliberately no SELECT policy at all: api_key must never be readable via
-- the REST API by anyone, including its own owner after the fact (they
-- already have it from registration). Only security-definer functions
-- below can read this table internally.

-- Registers a new player and returns their name/rating/api_key - the ONLY
-- time the key is ever visible. Store it; there's no recovery if lost
-- (register a new name instead).
create or replace function register_player(p_name text)
returns table (player_id uuid, name text, api_key uuid, rating numeric) as $$
declare
  v_id uuid;
  v_key uuid;
begin
  insert into players (name) values (p_name)
  returning players.id, players.api_key into v_id, v_key;

  return query select v_id, p_name, v_key, 1200::numeric;
exception when unique_violation then
  raise exception 'Name "%" is already taken - pick another.', p_name;
end;
$$ language plpgsql security definer;

-- Fetches a player's own stats via their api_key (proves ownership; this
-- is the only read path into `players` since there's no SELECT policy).
create or replace function my_player_stats(p_api_key uuid)
returns table (name text, rating numeric, games_played int, wins int, losses int, draws int) as $$
begin
  return query
  select p.name, p.rating, p.games_played, p.wins, p.losses, p.draws
  from players p where p.api_key = p_api_key;
end;
$$ language plpgsql security definer;

-- Public leaderboard - names and ratings only, never api_key.
create or replace function leaderboard(p_limit int default 50)
returns table (name text, rating numeric, games_played int, wins int, losses int, draws int) as $$
begin
  return query
  select p.name, p.rating, p.games_played, p.wins, p.losses, p.draws
  from players p
  order by p.rating desc
  limit p_limit;
end;
$$ language plpgsql security definer;

-- Standard Elo update (K=32), applied automatically whenever a rated game
-- (both player_ids set) transitions to finished. Runs as a trigger, not
-- something any client calls, so it can't be skipped, retried, or double-
-- applied by a misbehaving client.
create or replace function apply_elo_on_finish() returns trigger as $$
declare
  v_white players%rowtype;
  v_black players%rowtype;
  v_score_w numeric;
  v_expected_w numeric;
  v_new_w numeric;
  v_new_b numeric;
begin
  if new.status <> 'finished' or old.status = 'finished' then
    return new;
  end if;
  if new.white_player_id is null or new.black_player_id is null then
    return new;
  end if;

  select * into v_white from players where id = new.white_player_id;
  select * into v_black from players where id = new.black_player_id;

  v_score_w := case new.result when '1-0' then 1 when '0-1' then 0 else 0.5 end;
  v_expected_w := 1.0 / (1.0 + power(10.0, (v_black.rating - v_white.rating) / 400.0));
  v_new_w := v_white.rating + 32 * (v_score_w - v_expected_w);
  v_new_b := v_black.rating + 32 * ((1 - v_score_w) - (1 - v_expected_w));

  update players set
    rating = v_new_w, games_played = games_played + 1,
    wins = wins + case when v_score_w = 1 then 1 else 0 end,
    losses = losses + case when v_score_w = 0 then 1 else 0 end,
    draws = draws + case when v_score_w = 0.5 then 1 else 0 end
  where id = new.white_player_id;

  update players set
    rating = v_new_b, games_played = games_played + 1,
    wins = wins + case when v_score_w = 0 then 1 else 0 end,
    losses = losses + case when v_score_w = 1 then 1 else 0 end,
    draws = draws + case when v_score_w = 0.5 then 1 else 0 end
  where id = new.black_player_id;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_apply_elo_on_finish on games;
create trigger trg_apply_elo_on_finish
  after update on games
  for each row execute function apply_elo_on_finish();

-- Rated room creation / joining - identical to the existing anonymous
-- flow, just also verifying the api_key and stamping player_id.

create or replace function create_room_as_player(p_api_key uuid, p_time_limit_seconds int default 180)
returns table (game_id uuid, color text, token uuid) as $$
declare
  v_player players%rowtype;
  v_token uuid := gen_random_uuid();
  v_game_id uuid;
  v_start_state jsonb := '{"board":["bR","bN","bB","bQ","bK","bB","bN","bR","bP","bP","bP","bP","bP","bP","bP","bP",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"wP","wP","wP","wP","wP","wP","wP","wP","wR","wN","wB","wQ","wK","wB","wN","wR"],"turn":"w","castling":{"wK":true,"wQ":true,"bK":true,"bQ":true},"ep":-1,"halfmove":0,"fullmove":1}'::jsonb;
begin
  select * into v_player from players where api_key = p_api_key;
  if v_player.id is null then raise exception 'Invalid API key.'; end if;

  insert into games (state, white_token, white_nickname, white_player_id, time_limit_seconds, white_time_remaining_ms, black_time_remaining_ms)
  values (v_start_state, v_token, v_player.name, v_player.id, p_time_limit_seconds,
    case when p_time_limit_seconds is not null then p_time_limit_seconds * 1000 end,
    case when p_time_limit_seconds is not null then p_time_limit_seconds * 1000 end)
  returning id into v_game_id;

  return query select v_game_id, 'w'::text, v_token;
end;
$$ language plpgsql security definer;

create or replace function join_room_as_player(p_game_id uuid, p_api_key uuid)
returns table (joined boolean, color text, token uuid) as $$
declare
  v_player players%rowtype;
  v_token uuid := gen_random_uuid();
  v_updated int;
begin
  select * into v_player from players where api_key = p_api_key;
  if v_player.id is null then raise exception 'Invalid API key.'; end if;

  update games set black_token = v_token, black_nickname = v_player.name,
    black_player_id = v_player.id, status = 'active', turn_started_at = now()
  where id = p_game_id and black_token is null;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return query select false, null::text, null::uuid;
  else
    return query select true, 'b'::text, v_token;
  end if;
end;
$$ language plpgsql security definer;

-- match_lobby, made player-aware. p_player_id is optional (default null)
-- so this is a drop-in replacement - existing anonymous callers
-- (match_lobby(nickname, wants_color, token), the 3-arg form from
-- 004_lobby.sql) keep working completely unchanged. When a registered
-- player calls with their player_id, it's stored on the lobby row and
-- propagated onto whichever game gets created - regardless of whether
-- their eventual opponent turns out to be anonymous or also registered
-- (a game is only rated once BOTH sides have a player_id).
create or replace function match_lobby(p_nickname text, p_wants_color text, p_token uuid, p_player_id uuid default null)
returns table (matched boolean, lobby_id bigint, game_id uuid, color text) as $$
declare
  v_opponent lobby%rowtype;
  v_game_id uuid;
  v_white_token uuid;
  v_black_token uuid;
  v_white_nick text;
  v_black_nick text;
  v_white_player_id uuid;
  v_black_player_id uuid;
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
      v_white_token := p_token; v_white_nick := p_nickname; v_white_player_id := p_player_id; v_my_color := 'w';
      v_black_token := v_opponent.token; v_black_nick := v_opponent.nickname; v_black_player_id := v_opponent.player_id;
    else
      v_black_token := p_token; v_black_nick := p_nickname; v_black_player_id := p_player_id; v_my_color := 'b';
      v_white_token := v_opponent.token; v_white_nick := v_opponent.nickname; v_white_player_id := v_opponent.player_id;
    end if;

    insert into games (
      state, white_token, black_token, white_nickname, black_nickname,
      white_player_id, black_player_id, status,
      time_limit_seconds, white_time_remaining_ms, black_time_remaining_ms, turn_started_at
    )
    values (
      v_start_state, v_white_token, v_black_token, v_white_nick, v_black_nick,
      v_white_player_id, v_black_player_id, 'active',
      v_time_limit, v_time_limit * 1000, v_time_limit * 1000, now()
    )
    returning id into v_game_id;

    update lobby set status = 'matched', matched_game_id = v_game_id,
      matched_color = case when v_my_color = 'w' then 'b' else 'w' end
    where id = v_opponent.id;

    return query select true, v_opponent.id, v_game_id, v_my_color;
  else
    insert into lobby (nickname, wants_color, token, player_id) values (p_nickname, p_wants_color, p_token, p_player_id)
    returning id into v_lobby_id;

    return query select false, v_lobby_id, null::uuid, null::text;
  end if;
end;
$$ language plpgsql security definer;

create or replace function match_lobby_as_player(p_api_key uuid, p_wants_color text)
returns table (matched boolean, lobby_id bigint, game_id uuid, color text) as $$
declare
  v_player players%rowtype;
begin
  select * into v_player from players where api_key = p_api_key;
  if v_player.id is null then raise exception 'Invalid API key.'; end if;

  return query select * from match_lobby(v_player.name, p_wants_color, gen_random_uuid(), v_player.id);
end;
$$ language plpgsql security definer;
