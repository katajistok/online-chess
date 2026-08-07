# Admin / maintenance

Reference SQL for resetting things. Not part of the app, not run
automatically - paste into the Supabase dashboard's SQL Editor whenever
you actually want to do one of these. **Everything here is destructive
and permanent** - there's no undo, no automatic backup, no confirmation
step. Read what a query does before running it.

## Clear all game history

Wipes every game and its move history. Also clears `lobby`, since old
lobby rows can reference a game via `matched_game_id`. Registered
players (names, ratings, W/L/D) are untouched - this only clears played
games, not who's registered.

```sql
delete from moves;
delete from lobby;
delete from games;
```

## Reset the scoreboard (clear all registered players)

Wipes every registered player - name, rating, win/loss/draw record, and
their `api_key`. This also **invalidates every previously-issued key**,
including bots' (like the LLM opponent) - anyone who was registered
needs to register again under a (possibly new, since names must stay
unique - the old name is freed up once its row is gone) name next time,
starting fresh at the default 1200 rating.

```sql
delete from players;
```

Casual/anonymous play (anyone who never registered) is unaffected either
way - there's no player row tied to them to reset.

## Clear just the usage log

The `events` table (`room_created`/`move_made`/`game_finished`/etc.) is
purely for your own visibility into usage over time via the SQL Editor -
safe to clear independently of everything else, no effect on gameplay.

```sql
delete from events;
```

## Full reset - everything above, in one go

Back to a genuinely empty database (schema/tables stay - only rows are
removed):

```sql
delete from moves;
delete from lobby;
delete from games;
delete from players;
delete from events;
```

After any of these, the front page's live "games in progress" / "players
active" counters and the leaderboard immediately reflect the change -
both are computed live from the tables above, nothing else to reset.
