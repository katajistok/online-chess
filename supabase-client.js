// Thin wrapper around Supabase. Every Supabase-specific call lives in this
// one file - the rest of the app calls these functions instead of talking
// to `supabase` directly. If the backend ever changes, this is the only
// file that needs rewriting.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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
