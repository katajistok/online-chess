// Same as random-bot.mjs, but a local LLM (via an NVIDIA NIM container,
// OpenAI-compatible API) picks the move instead of Math.random(). The LLM
// is only ever asked to CHOOSE from rules.js's own list of legal moves,
// never to invent a move itself - small models are unreliable at actually
// knowing chess rules, but picking one option from a given list is a much
// easier, more reliable task. If the model's reply doesn't cleanly match
// one of the offered moves, we fall back to a random legal move rather
// than getting stuck.
//
// Expects a NIM (or any OpenAI-chat-compatible server) at NIM_URL below.
//
// Usage:
//   node llm-bot.mjs <name> [w|b|either]                 find a random opponent
//   node llm-bot.mjs <name> <room-id-or-invite-link>      join a specific room
//                                                           directly (paste the
//                                                           whole invite link or
//                                                           just its room id) -
//                                                           you'll join as black,
//                                                           same as any human
//                                                           joining that link

import { initialState, legalMoves, applyMove, toSAN } from "../rules.js";

const SUPABASE_URL = "https://ulewbiwfvvhigxpuvqss.supabase.co";
const SUPABASE_KEY = "sb_publishable_rAM-oAxs-_XOp7_OaKHKFA_1axig43n";
const NIM_URL = process.env.NIM_URL ?? "http://localhost:8000/v1/chat/completions";
const NIM_MODEL = process.env.NIM_MODEL ?? "google/gemma-3-1b-it";

const name = process.argv[2] ?? `LLMBot${Math.floor(Math.random() * 9000 + 1000)}`;
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
// and get back the authoritative resulting game row.
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

async function chooseMoveViaLLM(options, sanList) {
  try {
    const res = await fetch(NIM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [
          { role: "system", content: "You are a chess engine. You will be given a list of legal moves in SAN notation. Reply with ONLY the exact text of one move from the list - no explanation, no punctuation, nothing else." },
          { role: "user", content: `Legal moves: ${sanList.join(", ")}\nWhich move do you play?` },
        ],
        max_tokens: 10,
        temperature: 0.7,
      }),
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    const idx = sanList.findIndex((san) => san.toLowerCase() === reply?.toLowerCase());
    if (idx >= 0) return { move: options[idx], san: sanList[idx], fromModel: true };
  } catch (e) {
    console.warn(`[${name}] LLM call failed (${e.message}), falling back to random`);
  }
  const idx = Math.floor(Math.random() * options.length);
  return { move: options[idx], san: sanList[idx], fromModel: false };
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
      for (const { move } of moves.slice(moveCount)) {
        history.push(applyMove(history[history.length - 1], move));
      }
      moveCount = moves.length;
    }

    const state = history[history.length - 1];
    if (state.turn === myColor) {
      const options = legalMoves(state);
      if (!options.length) { await sleep(1000); continue; }

      const sanList = options.map((m) => toSAN(state, m));
      const { move, fromModel } = await chooseMoveViaLLM(options, sanList);
      const result = await submitMove(gameId, myColor, myToken, move);
      console.log(`[${name}] playing ${result.san}${fromModel ? "" : " (fallback: random)"}`);
      history.push(applyMove(state, result.move));
      moveCount++;
    }

    await sleep(1000);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(`[${name}] fatal:`, e.message); process.exit(1); });
