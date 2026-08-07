-- Online Chess — let match_lobby_as_player callers know their own token
-- even while still waiting for a match.
-- Paste into the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Previously the token was generated server-side and only discoverable
-- afterward by fetching the game row - fine for a bot that just polls and
-- re-fetches once matched, but the browser's live "waiting" flow needs to
-- know its own token upfront (same as the anonymous enterLobby already
-- does) so it can act the instant a match arrives via Realtime. p_token
-- is optional so existing callers that don't pass one still work - the
-- function generates one itself in that case, and now always returns it.

create or replace function match_lobby_as_player(p_api_key uuid, p_wants_color text, p_token uuid default null)
returns table (matched boolean, lobby_id bigint, game_id uuid, color text, token uuid) as $$
declare
  v_player players%rowtype;
  v_token uuid := coalesce(p_token, gen_random_uuid());
begin
  select * into v_player from players where api_key = p_api_key;
  if v_player.id is null then raise exception 'Invalid API key.'; end if;

  return query
  select r.matched, r.lobby_id, r.game_id, r.color, v_token
  from match_lobby(v_player.name, p_wants_color, v_token, v_player.id) r;
end;
$$ language plpgsql security definer;
