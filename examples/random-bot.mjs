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
// Usage: node random-bot.mjs <name> [w|b|either]

import { initialState, legalMoves, applyMove, toSAN, gameStatus, posKey } from "../rules.js";

const SUPABASE_URL = "https://ulewbiwfvvhigxpuvqss.supabase.co";
const SUPABASE_KEY = "sb_publishable_rAM-oAxs-_XOp7_OaKHKFA_1axig43n";

const name = process.argv[2] ?? `Bot${Math.floor(Math.random() * 9000 + 1000)}`;
const wantsColor = process.argv[3] ?? "either";

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

async function main() {
  console.log(`[${name}] registering...`);
  const [reg] = await rpc("register_player", { p_name: name });
  const apiKey = reg.api_key;
  console.log(`[${name}] registered, rating ${reg.rating}. Looking for an opponent (wants: ${wantsColor})...`);

  let match = (await rpc("match_lobby_as_player", { p_api_key: apiKey, p_wants_color: wantsColor }))[0];
  let gameId, myColor, myToken;

  if (match.matched) {
    ({ game_id: gameId, color: myColor } = match);
    console.log(`[${name}] matched instantly as ${myColor === "w" ? "white" : "black"} in game ${gameId}`);
    // We matched an already-waiting opponent, so OUR token is whatever we
    // generated - but match_lobby_as_player doesn't hand it back (it's
    // stored server-side against the game row via the api-key-verified
    // insert). Fetch our own token from the game row via player_id match.
    const [game] = await api(`games?id=eq.${gameId}&select=white_token,black_token,white_player_id`);
    myToken = myColor === "w" ? game.white_token : game.black_token;
  } else {
    console.log(`[${name}] waiting for an opponent (lobby id ${match.lobby_id})...`);
    // Poll our own lobby row rather than using Realtime (WebSocket support
    // varies by runtime/language - polling works everywhere).
    while (true) {
      await sleep(1000);
      const [row] = await api(`lobby?id=eq.${match.lobby_id}&select=status,matched_game_id,matched_color`);
      if (row.status === "matched") {
        gameId = row.matched_game_id;
        myColor = row.matched_color;
        console.log(`[${name}] matched as ${myColor === "w" ? "white" : "black"} in game ${gameId}`);
        const [game] = await api(`games?id=eq.${gameId}&select=white_token,black_token`);
        myToken = myColor === "w" ? game.white_token : game.black_token;
        break;
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
      const san = toSAN(state, move);
      const newState = applyMove(state, move);
      history.push(newState);
      moveCount++;

      const reps = history.filter((s) => posKey(s) === posKey(newState)).length;
      const stat = gameStatus(newState, reps);
      console.log(`[${name}] playing ${san}`);
      const tokenColumn = myColor === "w" ? "white_token" : "black_token";
      await api(`games?id=eq.${gameId}&${tokenColumn}=eq.${myToken}`, {
        method: "PATCH",
        body: {
          state: newState,
          updated_at: new Date().toISOString(),
          ...(stat.over ? { status: "finished", result: stat.result } : {}),
        },
      });
      await api("moves", { method: "POST", body: { game_id: gameId, ply: moveCount, san, move } });
    }

    await sleep(1000); // poll interval
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(`[${name}] fatal:`, e.message); process.exit(1); });
