// A minimal reference bot: registers as a rated player, finds an opponent,
// and plays random legal moves until the game ends. Meant to be read, not
// just run - see ../AGENT.md for the full walkthrough this implements.
//
// Uses plain fetch() to Supabase's REST/RPC API (no @supabase/supabase-js
// import) so it works in bare Node with zero dependencies, and so the
// approach is trivially portable to any language. The one local import is
// ../rules.js - the actual chess engine - since it has zero dependencies
// of its own and there's no reason to reimplement move generation.
//
// Usage:
//   node random-bot.mjs <name> [w|b|either]                 find a random opponent
//   node random-bot.mjs <name> <room-id-or-invite-link>      join a specific room
//                                                              directly (paste the
//                                                              whole invite link or
//                                                              just its room id) -
//                                                              you'll join as black,
//                                                              same as any human
//                                                              joining that link

import { initialState, legalMoves, applyMove } from "../rules.js";

const SUPABASE_URL = "https://ulewbiwfvvhigxpuvqss.supabase.co";
const SUPABASE_KEY = "sb_publishable_rAM-oAxs-_XOp7_OaKHKFA_1axig43n";

const name = process.argv[2] ?? `Bot${Math.floor(Math.random() * 9000 + 1000)}`;
const arg = process.argv[3] ?? "either";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const joinGameId = arg.match(UUID_RE)?.[0] ?? null;
const wantsColor = joinGameId ? null : arg;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
const rpc = (fn, args) => api(`rpc/${fn}`, { method: "POST", body: args });

// The move itself is validated server-side (see
// ../supabase/functions/submit-move) - we send the intent (from/to/promo)
// and get back the authoritative resulting game row, not the other way
// around. This is the only path that can change a game's board state.
async function submitMove(gameId, color, token, move) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, color, token, from: move.from, to: move.to, promo: move.promo }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `submit-move -> ${res.status}`);
  return data;
}

async function main() {
  console.log(`[${name}] registering...`);
  const [reg] = await rpc("register_player", { p_name: name });
  const apiKey = reg.api_key;
  console.log(`[${name}] registered, rating ${reg.rating}.`);

  let gameId, myColor, myToken;

  if (joinGameId) {
    console.log(`[${name}] joining room ${joinGameId} directly...`);
    const [joined] = await rpc("join_room_as_player", { p_game_id: joinGameId, p_api_key: apiKey });
    if (!joined.joined) throw new Error("Could not join that room - it's already full, or doesn't exist.");
    gameId = joinGameId; myColor = joined.color; myToken = joined.token;
    console.log(`[${name}] joined as ${myColor === "w" ? "white" : "black"}`);
  } else {
    console.log(`[${name}] looking for an opponent (wants: ${wantsColor})...`);
    const [match] = await rpc("match_lobby_as_player", { p_api_key: apiKey, p_wants_color: wantsColor });

    if (match.matched) {
      ({ game_id: gameId, color: myColor, token: myToken } = match);
      console.log(`[${name}] matched instantly as ${myColor === "w" ? "white" : "black"} in game ${gameId}`);
    } else {
      console.log(`[${name}] waiting for an opponent (lobby id ${match.lobby_id})...`);
      myToken = match.token;
      // Poll our own lobby row rather than using Realtime (WebSocket support
      // varies by runtime/language - polling works everywhere).
      while (true) {
        await sleep(1000);
        const [row] = await api(`lobby?id=eq.${match.lobby_id}&select=status,matched_game_id,matched_color`);
        if (row.status === "matched") {
          gameId = row.matched_game_id;
          myColor = row.matched_color;
          console.log(`[${name}] matched as ${myColor === "w" ? "white" : "black"} in game ${gameId}`);
          break;
        }
      }
    }
  }

  await playGame({ gameId, myColor, myToken });
  const [stats] = await rpc("my_player_stats", { p_api_key: apiKey });
  console.log(`[${name}] final rating: ${stats.rating} (${stats.wins}W ${stats.losses}L ${stats.draws}D)`);
}

async function playGame({ gameId, myColor, myToken }) {
  let history = [initialState()];
  let moveCount = 0;

  while (true) {
    const [game] = await api(`games?id=eq.${gameId}&select=status,result`);
    if (game.status === "finished") {
      console.log(`[${name}] game over: ${game.result}`);
      return;
    }

    const moves = await api(`moves?game_id=eq.${gameId}&order=ply.asc&select=move`);
    if (moves.length > moveCount) {
      // Replay any moves we haven't applied locally yet (ours or theirs).
      for (const { move } of moves.slice(moveCount)) {
        history.push(applyMove(history[history.length - 1], move));
      }
      moveCount = moves.length;
    }

    const state = history[history.length - 1];
    if (state.turn === myColor) {
      const options = legalMoves(state);
      if (!options.length) { await sleep(1000); continue; } // checkmate/stalemate - status will flip to finished shortly
      const move = options[Math.floor(Math.random() * options.length)];
      const result = await submitMove(gameId, myColor, myToken, move);
      console.log(`[${name}] playing ${result.san}`);
      history.push(applyMove(state, result.move));
      moveCount++;
    }

    await sleep(1000); // poll interval
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(`[${name}] fatal:`, e.message); process.exit(1); });
