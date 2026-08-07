// Thin wrapper around Supabase. Every Supabase-specific call lives in this
// one file - the rest of the app calls these functions instead of talking
// to `supabase` directly. If the backend ever changes, this is the only
// file that needs rewriting.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
import { initialState } from "./rules.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// crypto.randomUUID() requires a "secure context" (HTTPS, or localhost) and
// throws on plain http:// origins like a LAN IP - crypto.getRandomValues()
// has no such restriction, so build a UUID v4 from that instead.
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// Where a browser's own color/token for a room is stored, shared between
// game.html (which reads it) and index.html (which writes it after a
// matchmaking pairing, before redirecting into the game).
function identityKey(gameId) { return `chess-online:${gameId}`; }
export function saveIdentity(gameId, color, token) {
  localStorage.setItem(identityKey(gameId), JSON.stringify({ color, token }));
}
export function loadIdentity(gameId) {
  const raw = localStorage.getItem(identityKey(gameId));
  return raw ? JSON.parse(raw) : null;
}

// Security model, spelled out: `games` rows are readable by anyone who has
// the room id (the invite link), including the white/black token columns.
// The token filters below stop *accidental* conflicts - two people clicking
// "join" at once, a stale browser tab replaying an old move - not a
// determined attacker who already has the link and reads network requests.
// That's an accepted trade-off for a casual game between friends, not a
// competitive/rated platform. See supabase/schema.sql for the same note.

// Fire-and-forget usage logging. Never blocks or throws on the caller -
// losing a log entry is fine, breaking gameplay over it is not.
export async function logEvent(eventType, gameId = null) {
  const { error } = await supabase.from("events").insert({ event_type: eventType, game_id: gameId });
  if (error) console.warn("logEvent failed:", error.message);
}

// "players" is an estimate, not a precise headcount: 2 for every game in
// progress, 1 for every room waiting on a second player. Only counts games
// updated in the last 30 minutes - there's no "both players left" detection,
// so without this an abandoned game would count as "in progress" forever.
const STALE_AFTER_MS = 30 * 60 * 1000;
export async function fetchStats() {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const [{ count: active }, { count: waiting }] = await Promise.all([
    supabase.from("games").select("id", { count: "exact", head: true }).eq("status", "active").gte("updated_at", cutoff),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("status", "waiting").gte("updated_at", cutoff),
  ]);
  return {
    gamesOngoing: (active ?? 0) + (waiting ?? 0),
    playersEstimate: (active ?? 0) * 2 + (waiting ?? 0),
  };
}

// Calls onChange immediately with current stats, then again on every
// insert/update/delete to `games`. Returns an unsubscribe function.
export function subscribeStats(onChange) {
  const refresh = () => fetchStats().then(onChange);
  refresh();
  const channel = supabase
    .channel("games-stats")
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, refresh)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Nickname is stored in the browser, not tied to any account - default is
// a random "Player1234" the first time, editable afterwards.
const NICK_KEY = "chess-online:nickname";
export function getNickname() {
  let nick = localStorage.getItem(NICK_KEY);
  if (!nick) {
    nick = "Player" + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem(NICK_KEY, nick);
  }
  return nick;
}
export function setNickname(nick) {
  localStorage.setItem(NICK_KEY, nick);
}

// Rated players only (see supabase/008_players_elo.sql) - anonymous/casual
// play never appears here. Sorted highest rating first.
export async function fetchLeaderboard(limit = 50) {
  const { data, error } = await supabase.rpc("leaderboard", { p_limit: limit });
  if (error) throw error;
  return data;
}

// Creates a new room, seeded with the standard starting position. The
// creator is always white. Returns the token their browser should keep
// (e.g. in localStorage) to prove they're allowed to move white's pieces.
// timeLimitSeconds is the total clock each player gets, like a real chess
// clock (null = no clock). The clock doesn't start yet - `turn_started_at`
// is deliberately left unset here and only begins once an opponent
// actually joins (see joinRoom), so nobody's time ticks away while waiting
// alone in an empty room.
export async function createRoom(nickname, timeLimitSeconds = 180) {
  const insert = { state: initialState(), white_nickname: nickname, time_limit_seconds: timeLimitSeconds };
  if (timeLimitSeconds != null) {
    insert.white_time_remaining_ms = timeLimitSeconds * 1000;
    insert.black_time_remaining_ms = timeLimitSeconds * 1000;
  }
  const { data, error } = await supabase.from("games").insert(insert).select().single();
  if (error) throw error;
  logEvent("room_created", data.id);
  return { gameId: data.id, color: "w", token: data.white_token };
}

// Attempts to claim the black seat in an existing room. Uses a conditional
// update (`black_token is null`) so that if two people click "join" at the
// same moment, only one of them actually wins the seat - the other gets
// joined:false and can fall back to spectating. This is also the moment
// white's clock genuinely starts (turn_started_at = now), not whenever the
// room happened to be created.
export async function joinRoom(gameId, nickname) {
  const token = randomToken();
  const { data, error } = await supabase
    .from("games")
    .update({ black_token: token, black_nickname: nickname, status: "active", turn_started_at: new Date().toISOString() })
    .eq("id", gameId)
    .is("black_token", null)
    .select()
    .single();

  if (error) {
    const { data: existing } = await supabase.from("games").select("id").eq("id", gameId).maybeSingle();
    return { joined: false, reason: existing ? "full" : "not_found" };
  }
  logEvent("player_joined", gameId);
  return { joined: true, gameId: data.id, color: "b", token, game: data };
}

// Random-opponent matchmaking. Generates this browser's own move-token
// up front (same token used later in the matched game) and asks the
// server to either pair it with someone already waiting, or register it
// as the new waiting entry. See supabase/004_lobby.sql for the atomic
// pairing logic - this just calls it.
export async function enterLobby(nickname, wantsColor) {
  const token = randomToken();
  const { data, error } = await supabase.rpc("match_lobby", { p_nickname: nickname, p_wants_color: wantsColor, p_token: token });
  if (error) throw error;
  const row = data[0];
  logEvent("lobby_entered");
  if (row.matched) {
    logEvent("lobby_matched", row.game_id);
    return { matched: true, gameId: row.game_id, color: row.color, token };
  }
  return { matched: false, lobbyId: row.lobby_id, token };
}

// Waits for a lobby entry to be matched by someone else joining later.
// Calls onMatched({ gameId, color, token }) once, then auto-unsubscribes.
export function subscribeLobby(lobbyId, token, onMatched) {
  const channel = supabase
    .channel(`lobby-${lobbyId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "lobby", filter: `id=eq.${lobbyId}` }, (payload) => {
      if (payload.new.status === "matched") {
        onMatched({ gameId: payload.new.matched_game_id, color: payload.new.matched_color, token });
        supabase.removeChannel(channel);
      }
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Gives up waiting in the lobby (e.g. user navigates away or clicks cancel).
export async function cancelLobby(lobbyId, token) {
  await supabase.from("lobby").update({ status: "cancelled" }).eq("id", lobbyId).eq("token", token).eq("status", "waiting");
}

// Fetches the current row for a room - used on initial load / reconnect.
export async function getGame(gameId) {
  const { data, error } = await supabase.from("games").select("*").eq("id", gameId).maybeSingle();
  if (error) throw error;
  return data;
}

// Full ordered move history for a room - used to replay a game from scratch
// on initial load, on reconnect, or to catch up after a missed realtime event.
export async function getMoves(gameId) {
  const { data, error } = await supabase.from("moves").select("*").eq("game_id", gameId).order("ply", { ascending: true });
  if (error) throw error;
  return data;
}

// Pushes a move: the caller has already validated it and computed the new
// state via rules.js (this file has no chess knowledge). `token` must match
// the games.<color>_token column server-side or the update silently matches
// zero rows and this throws - that's what stops a stale/other-color tab
// from pushing a move for the wrong side.
//
// timeRemainingMs (when the game has a clock) is the mover's own remaining
// time AFTER this move, computed client-side as
// (their time before this turn) - (elapsed time they just spent thinking).
// Banking it here, and resetting turn_started_at, is what makes the clock
// hand off to the other player.
export async function sendMove({ gameId, color, token, ply, san, move, state, status, result, timeRemainingMs }) {
  const tokenColumn = color === "w" ? "white_token" : "black_token";
  // A move implicitly answers any pending draw offer - either you just
  // declined it by playing on, or you're the offerer moving anyway, which
  // withdraws it. Either way it shouldn't linger.
  const patch = { state, updated_at: new Date().toISOString(), draw_offered_by: null };
  if (status) patch.status = status;
  if (result) patch.result = result;
  if (timeRemainingMs != null) {
    patch[color === "w" ? "white_time_remaining_ms" : "black_time_remaining_ms"] = Math.max(0, Math.round(timeRemainingMs));
    patch.turn_started_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("games")
    .update(patch)
    .eq("id", gameId)
    .eq(tokenColumn, token)
    .select()
    .single();
  if (error) throw new Error("Move rejected (wrong token or game not found): " + error.message);

  const { error: moveError } = await supabase.from("moves").insert({ game_id: gameId, ply, san, move });
  if (moveError) console.warn("Failed to log move to history:", moveError.message);

  logEvent(status === "finished" ? "game_finished" : "move_made", gameId);
  return data;
}

// Declares a loss by timeout. Any client (whichever notices the deadline
// has passed first - usually the player who's about to win, since they're
// the one still actively watching the clock) can call this using its own
// token; `.eq("status", "active")` means only the first caller actually
// changes anything if both clients notice at once.
export async function claimTimeout({ gameId, myColor, myToken, loserColor }) {
  const tokenColumn = myColor === "w" ? "white_token" : "black_token";
  const result = loserColor === "w" ? "0-1" : "1-0";
  const { data, error } = await supabase
    .from("games")
    .update({ status: "finished", result, end_reason: "timeout" })
    .eq("id", gameId)
    .eq(tokenColumn, myToken)
    .eq("status", "active")
    .select()
    .maybeSingle();
  if (error || !data) return null;
  logEvent("game_finished", gameId);
  return data;
}

// Voluntary resignation. The other color wins immediately.
export async function resignGame({ gameId, myColor, myToken }) {
  const tokenColumn = myColor === "w" ? "white_token" : "black_token";
  const result = myColor === "w" ? "0-1" : "1-0";
  const { data, error } = await supabase
    .from("games")
    .update({ status: "finished", result, end_reason: "resignation" })
    .eq("id", gameId)
    .eq(tokenColumn, myToken)
    .eq("status", "active")
    .select()
    .maybeSingle();
  if (error || !data) return null;
  logEvent("game_finished", gameId);
  return data;
}

// Offers a draw - only sets your OWN color as the offerer, gated by your
// own token like every other write here.
export async function offerDraw({ gameId, myColor, myToken }) {
  const tokenColumn = myColor === "w" ? "white_token" : "black_token";
  const { error } = await supabase
    .from("games")
    .update({ draw_offered_by: myColor })
    .eq("id", gameId)
    .eq(tokenColumn, myToken)
    .eq("status", "active");
  if (error) throw error;
}

// Responds to a pending draw offer. Accepting is gated by
// `draw_offered_by=eq.<opponent's color>` in addition to your own token -
// that's what stops a player from "accepting" an offer they made
// themselves. Declining just clears the offer so play continues.
export async function respondToDraw({ gameId, myColor, myToken, accept }) {
  const tokenColumn = myColor === "w" ? "white_token" : "black_token";
  const opponentColor = myColor === "w" ? "b" : "w";
  const patch = accept
    ? { status: "finished", result: "1/2-1/2", end_reason: "agreement", draw_offered_by: null }
    : { draw_offered_by: null };
  const { data, error } = await supabase
    .from("games")
    .update(patch)
    .eq("id", gameId)
    .eq(tokenColumn, myToken)
    .eq("draw_offered_by", opponentColor)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (accept && data) logEvent("game_finished", gameId);
  return data;
}

// Subscribes to both the game row (board state) and new rows in `moves`
// (scoresheet) for one room. Returns an unsubscribe function.
export function subscribeGame(gameId, onGameChange, onMove) {
  const channel = supabase
    .channel(`game-${gameId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` }, (payload) => onGameChange(payload.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "moves", filter: `game_id=eq.${gameId}` }, (payload) => onMove?.(payload.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
}
