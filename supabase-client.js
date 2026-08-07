// Thin wrapper around Supabase. Every Supabase-specific call lives in this
// one file - the rest of the app calls these functions instead of talking
// to `supabase` directly. If the backend ever changes, this is the only
// file that needs rewriting.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";
import { initialState } from "./rules.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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
// progress, 1 for every room waiting on a second player.
export async function fetchStats() {
  const [{ count: active }, { count: waiting }] = await Promise.all([
    supabase.from("games").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("status", "waiting"),
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

// Creates a new room, seeded with the standard starting position. The
// creator is always white. Returns the token their browser should keep
// (e.g. in localStorage) to prove they're allowed to move white's pieces.
export async function createRoom() {
  const { data, error } = await supabase.from("games").insert({ state: initialState() }).select().single();
  if (error) throw error;
  logEvent("room_created", data.id);
  return { gameId: data.id, color: "w", token: data.white_token };
}

// Attempts to claim the black seat in an existing room. Uses a conditional
// update (`black_token is null`) so that if two people click "join" at the
// same moment, only one of them actually wins the seat - the other gets
// joined:false and can fall back to spectating.
export async function joinRoom(gameId) {
  const token = crypto.randomUUID();
  const { data, error } = await supabase
    .from("games")
    .update({ black_token: token, status: "active" })
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
export async function sendMove({ gameId, color, token, ply, san, move, state, status, result }) {
  const tokenColumn = color === "w" ? "white_token" : "black_token";
  const patch = { state, updated_at: new Date().toISOString() };
  if (status) patch.status = status;
  if (result) patch.result = result;

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
