// Sorts a hand on a board into the groups players talk about: sets, top pair, flush draws and so on.
// Card ids: 4 * rank + suit (rank 0 = deuce .. 12 = ace).
import { score } from "../equity.js";

// made hands, strongest first (exactly one per hand)
export const MADE = ["Straight flush", "Quads", "Full house", "Flush", "Straight", "Set", "Trips", "Two pair",
  "Overpair", "Top pair", "Second pair", "Weak pair", "Ace high", "No made hand", "Board plays"];
// draws, best first (at most one per hand; only for hands weaker than a straight, before the river)
export const DRAWS = ["Combo draw", "Flush draw", "Open-ender", "Gutshot"];

function straightTop(mask) {
  const m = (mask << 1) | ((mask >> 12) & 1);
  for (let h = 13; h >= 4; h--) if (((m >> (h - 4)) & 31) === 31) return h - 1;
  return -1;
}

// returns {made: index into MADE, draw: index into DRAWS or -1}
export function classify(a, b, board) {
  const all = board.concat([a, b]);
  const s = score(all), cat = s >> 20;
  const br = new Array(13).fill(0); let bmask = 0;
  for (const c of board) { br[c >> 2]++; bmask |= 1 << (c >> 2); }
  const ra = a >> 2, rb = b >> 2;
  let made;
  if (board.length === 5 && score(board) === s) made = 14;
  else if (cat === 8) made = 0;
  else if (cat === 7) made = 1;
  else if (cat === 6) made = 2;
  else if (cat === 5) made = 3;
  else if (cat === 4) made = 4;
  else {
    const D = []; for (let r = 12; r >= 0; r--) if (br[r]) D.push(r); // board ranks, high to low
    const pairRank = r => r === D[0] ? 9 : r === D[1] ? 10 : 11;
    if (ra === rb) {
      if (br[ra] === 1) made = 5;
      else made = ra > D[0] ? 8 : ra > D[1] || D.length < 2 ? 10 : 11;
    } else {
      const hit = [ra, rb].filter(r => br[r] > 0);
      if (hit.some(r => br[r] >= 2)) made = 6;
      else if (hit.length === 2) made = 7;
      else if (hit.length === 1) made = pairRank(hit[0]);
      else made = ra === 12 || rb === 12 ? 12 : 13;
    }
  }
  let draw = -1;
  if (board.length < 5 && made > 4) {
    // flush draw: four of a suit, at least one of them ours
    let fd = false;
    for (let su = 0; su < 4; su++) {
      let n = 0; for (const c of all) if ((c & 3) === su) n++;
      if (n === 4 && ((a & 3) === su || (b & 3) === su)) fd = true;
    }
    // straight draw: how many ranks would make a straight that the board alone doesn't
    const mask = bmask | (1 << ra) | (1 << rb);
    let outs = 0;
    for (let r = 0; r < 13; r++) {
      if (mask & (1 << r)) continue;
      if (straightTop(mask | (1 << r)) >= 0 && straightTop(bmask | (1 << r)) < 0) outs++;
    }
    const sd = outs >= 2 ? 2 : outs === 1 ? 3 : -1;
    draw = fd && sd >= 0 ? 0 : fd ? 1 : sd;
  }
  return { made, draw };
}
