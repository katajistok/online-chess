// Server-side move validation. Deployed with --no-verify-jwt (see
// supabase/DEPLOY.md) since our actual authorization model is the
// per-game token, not a platform-level JWT - the anon/publishable key
// system has been evolving and this avoids any ambiguity about which key
// formats the platform gateway's own JWT check accepts.
//
// This is the only thing allowed to write games.state or insert into
// moves - see supabase/010_lock_down_state.sql, which revokes that
// directly from anon after this function is confirmed working. Runs with
// the service role key (auto-injected by the platform), which bypasses
// RLS entirely - that's what lets this function do so after the lockdown
// while clients can't do it themselves.
//
// Reuses rules.js as-is (imported straight from the repo, not copied) -
// one source of truth for chess rules, shared with the browser UI and
// every bot.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { legalMoves, applyMove, toSAN, gameStatus, posKey, initialState } from "../../../rules.js";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const { gameId, color, token, from, to, promo } = await req.json();
    if (!gameId || (color !== "w" && color !== "b") || !token || from == null || to == null) {
      return json({ error: "gameId, color ('w'|'b'), token, from, to are required" }, 400);
    }

    const { data: game, error: gameErr } = await supabase.from("games").select("*").eq("id", gameId).maybeSingle();
    if (gameErr || !game) return json({ error: "game not found" }, 404);
    if (game.status !== "active") return json({ error: "game is not active" }, 409);

    const tokenColumn = color === "w" ? "white_token" : "black_token";
    if (game[tokenColumn] !== token) return json({ error: "invalid token" }, 403);

    const { data: priorMoves, error: movesErr } = await supabase
      .from("moves").select("move").eq("game_id", gameId).order("ply", { ascending: true });
    if (movesErr) return json({ error: "failed to load move history" }, 500);

    // Rebuild the position from the authoritative starting state by
    // replaying every recorded move - this is also what gives correct
    // threefold-repetition data, which needs the full history, not just
    // the current board.
    const history = [initialState()];
    for (const { move } of priorMoves) history.push(applyMove(history[history.length - 1], move));
    const current = history[history.length - 1];

    if (current.turn !== color) return json({ error: "not your turn" }, 409);

    const options = legalMoves(current);
    const match = options.find((m) => m.from === from && m.to === to && (promo ? m.promo === promo : !m.promo));
    if (!match) return json({ error: "illegal move" }, 400);

    const san = toSAN(current, match);
    const newState = applyMove(current, match);
    history.push(newState);
    const reps = history.filter((s) => posKey(s) === posKey(newState)).length;
    const stat = gameStatus(newState, reps);

    // Bank the mover's clock server-side too - trusting a client-reported
    // elapsed time would let a player quietly lie about how long they took.
    const patch: Record<string, unknown> = { state: newState, updated_at: new Date().toISOString(), draw_offered_by: null };
    if (game.time_limit_seconds != null && game.turn_started_at) {
      const elapsed = Date.now() - new Date(game.turn_started_at).getTime();
      const before = color === "w" ? game.white_time_remaining_ms : game.black_time_remaining_ms;
      patch[color === "w" ? "white_time_remaining_ms" : "black_time_remaining_ms"] = Math.max(0, Math.round(before - elapsed));
      patch.turn_started_at = new Date().toISOString();
    }
    if (stat.over) { patch.status = "finished"; patch.result = stat.result; }

    const { data: updated, error: updateErr } = await supabase.from("games").update(patch).eq("id", gameId).select().single();
    if (updateErr) return json({ error: "failed to update game: " + updateErr.message }, 500);

    const ply = priorMoves.length + 1;
    const { error: insertErr } = await supabase.from("moves").insert({ game_id: gameId, ply, san, move: match });
    if (insertErr) return json({ error: "failed to record move: " + insertErr.message }, 500);

    return json({ ok: true, san, move: match, game: updated });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
