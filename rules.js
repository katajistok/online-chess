// Chess rules engine — pure functions, no UI or networking knowledge.
// Extracted from simple-chess/chess.html so the same battle-tested logic
// can be reused for local play, an AI opponent, and (via Supabase) online play.
//
// Board: 64-element array, index 0 = a8, index 63 = h1.
// Pieces are two-char codes: colour + type, e.g. "wP", "bK".
// State: { board, turn, castling:{wK,wQ,bK,bQ}, ep, halfmove, fullmove }

export const FILES = "abcdefgh";
export const rowOf = (i) => Math.floor(i / 8);
export const colOf = (i) => i % 8;
export const sqName = (i) => FILES[i % 8] + (8 - Math.floor(i / 8));

export function initialState() {
  const board = new Array(64).fill(null);
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let c = 0; c < 8; c++) {
    board[c] = "b" + back[c];
    board[8 + c] = "bP";
    board[48 + c] = "wP";
    board[56 + c] = "w" + back[c];
  }
  return { board, turn: "w", castling: { wK: true, wQ: true, bK: true, bQ: true }, ep: -1, halfmove: 0, fullmove: 1 };
}

const KD = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ND = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const RD = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BD = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

export function isAttacked(board, sq, by) {
  const r = rowOf(sq), c = colOf(sq), pr = by === "w" ? r + 1 : r - 1;
  for (const dc of [-1, 1]) if (pr >= 0 && pr < 8 && c + dc >= 0 && c + dc < 8 && board[pr * 8 + c + dc] === by + "P") return true;
  for (const [dr, dc] of ND) { const nr = r + dr, nc = c + dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr * 8 + nc] === by + "N") return true; }
  for (const [dr, dc] of KD) { const nr = r + dr, nc = c + dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr * 8 + nc] === by + "K") return true; }
  for (const [dirs, ts] of [[RD, ["R", "Q"]], [BD, ["B", "Q"]]]) {
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const p = board[nr * 8 + nc];
        if (p) { if (p[0] === by && ts.includes(p[1])) return true; break; }
        nr += dr; nc += dc;
      }
    }
  }
  return false;
}

export function findKing(board, color) {
  for (let i = 0; i < 64; i++) if (board[i] === color + "K") return i;
  return -1;
}
export const inCheck = (s, c) => isAttacked(s.board, findKing(s.board, c), c === "w" ? "b" : "w");

export function pseudoMoves(state) {
  const { board, turn, castling, ep } = state, moves = [], enemy = turn === "w" ? "b" : "w";
  const push = (from, to, ex = {}) => moves.push({ from, to, piece: board[from], captured: ex.flag === "ep" ? enemy + "P" : board[to], ...ex });
  for (let from = 0; from < 64; from++) {
    const p = board[from]; if (!p || p[0] !== turn) continue;
    const r = rowOf(from), c = colOf(from), type = p[1];
    if (type === "P") {
      const dir = turn === "w" ? -1 : 1, sr = turn === "w" ? 6 : 1, lr = turn === "w" ? 0 : 7;
      const one = (r + dir) * 8 + c;
      if (r + dir >= 0 && r + dir < 8 && !board[one]) {
        if (r + dir === lr) for (const pr of ["Q", "R", "B", "N"]) push(from, one, { promo: pr }); else push(from, one);
        const two = (r + 2 * dir) * 8 + c; if (r === sr && !board[two]) push(from, two, { flag: "double" });
      }
      for (const dc of [-1, 1]) {
        const nc = c + dc, nr = r + dir; if (nc < 0 || nc > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nc;
        if (board[to] && board[to][0] === enemy) { if (nr === lr) for (const pr of ["Q", "R", "B", "N"]) push(from, to, { promo: pr }); else push(from, to); }
        else if (to === ep) push(from, to, { flag: "ep" });
      }
    } else if (type === "N" || type === "K") {
      for (const [dr, dc] of (type === "N" ? ND : KD)) {
        const nr = r + dr, nc = c + dc; if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
        const to = nr * 8 + nc; if (!board[to] || board[to][0] === enemy) push(from, to);
      }
      if (type === "K") {
        const h = turn === "w" ? 56 : 0;
        if (from === h + 4) {
          if (castling[turn + "K"] && !board[h + 5] && !board[h + 6] && !isAttacked(board, h + 4, enemy) && !isAttacked(board, h + 5, enemy) && !isAttacked(board, h + 6, enemy)) push(from, h + 6, { flag: "castleK" });
          if (castling[turn + "Q"] && !board[h + 3] && !board[h + 2] && !board[h + 1] && !isAttacked(board, h + 4, enemy) && !isAttacked(board, h + 3, enemy) && !isAttacked(board, h + 2, enemy)) push(from, h + 2, { flag: "castleQ" });
        }
      }
    } else {
      const dirs = type === "R" ? RD : type === "B" ? BD : KD;
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const to = nr * 8 + nc;
          if (!board[to]) push(from, to); else { if (board[to][0] === enemy) push(from, to); break; }
          nr += dr; nc += dc;
        }
      }
    }
  }
  return moves;
}

export function applyMove(state, m) {
  const board = state.board.slice(), turn = state.turn, castling = { ...state.castling };
  let ep = -1, halfmove = state.halfmove + 1;
  board[m.to] = m.promo ? turn + m.promo : m.piece; board[m.from] = null;
  if (m.flag === "ep") board[m.to + (turn === "w" ? 8 : -8)] = null;
  if (m.flag === "double") ep = (m.from + m.to) / 2;
  if (m.flag === "castleK") { const h = turn === "w" ? 56 : 0; board[h + 5] = board[h + 7]; board[h + 7] = null; }
  if (m.flag === "castleQ") { const h = turn === "w" ? 56 : 0; board[h + 3] = board[h + 0]; board[h + 0] = null; }
  if (m.piece[1] === "P" || m.captured) halfmove = 0;
  if (m.piece[1] === "K") { castling[turn + "K"] = false; castling[turn + "Q"] = false; }
  for (const [sq, key] of [[56, "wQ"], [63, "wK"], [0, "bQ"], [7, "bK"]]) if (m.from === sq || m.to === sq) castling[key] = false;
  return { board, turn: turn === "w" ? "b" : "w", castling, ep, halfmove, fullmove: state.fullmove + (turn === "b" ? 1 : 0) };
}

export const legalMoves = (state) => pseudoMoves(state).filter((m) => !inCheck(applyMove(state, m), state.turn));
export const posKey = (s) => s.board.map((p) => p || ".").join("") + s.turn + (s.castling.wK ? "K" : "") + (s.castling.wQ ? "Q" : "") + (s.castling.bK ? "k" : "") + (s.castling.bQ ? "q" : "") + s.ep;

export function insuffMat(board) {
  let m = 0;
  for (const p of board) {
    if (!p || p[1] === "K") continue;
    if (p[1] === "B" || p[1] === "N") { m++; if (m > 1) return false; } else return false;
  }
  return true;
}

// `reps` = how many times the current position has occurred in the game's history
// (caller tracks this, since only the game loop knows the full move history).
export function gameStatus(state, reps) {
  const moves = legalMoves(state);
  if (!moves.length) {
    if (inCheck(state, state.turn)) return { over: true, result: state.turn === "w" ? "0-1" : "1-0", reason: "checkmate" };
    return { over: true, result: "1/2-1/2", reason: "stalemate" };
  }
  if (state.halfmove >= 100) return { over: true, result: "1/2-1/2", reason: "fifty-move rule" };
  if (insuffMat(state.board)) return { over: true, result: "1/2-1/2", reason: "insufficient material" };
  if (reps >= 3) return { over: true, result: "1/2-1/2", reason: "threefold repetition" };
  return { over: false, moves };
}

export function toSAN(state, m) {
  const sfx = (str) => {
    const n = applyMove(state, m);
    if (inCheck(n, n.turn)) return str + (legalMoves(n).length === 0 ? "#" : "+");
    return str;
  };
  if (m.flag === "castleK") return sfx("O-O");
  if (m.flag === "castleQ") return sfx("O-O-O");
  const type = m.piece[1]; let s = "";
  if (type === "P") {
    if (m.captured) s += FILES[colOf(m.from)] + "x";
    s += sqName(m.to);
    if (m.promo) s += "=" + m.promo;
  } else {
    s += type;
    const others = legalMoves(state).filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
    if (others.length) {
      const sf = others.some((o) => colOf(o.from) === colOf(m.from)), sr = others.some((o) => rowOf(o.from) === rowOf(m.from));
      if (!sf) s += FILES[colOf(m.from)]; else if (!sr) s += String(8 - rowOf(m.from)); else s += sqName(m.from);
    }
    if (m.captured) s += "x";
    s += sqName(m.to);
  }
  return sfx(s);
}
