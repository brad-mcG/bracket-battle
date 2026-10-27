// Pure single-elimination bracket logic (no I/O) so it can be checked without a server.
// rounds[r][m] = { a, b, winner } where a/b/winner are entry indexes or null.
// Round 0 null = bye; later-round null = "winner not decided yet".

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Random seeding. Byes (size - n of them) each pair with one real entry and auto-advance;
// n > size/2 guarantees there are never two byes in one match.
export function buildBracket(n) {
  if (n < 2) throw new Error("need at least 2 entries");
  let size = 2;
  while (size < n) size *= 2;
  const order = shuffle([...Array(n).keys()]);
  const byes = size - n;
  // spread the byes across the bracket instead of clustering them at the top
  const byeSlots = new Set(shuffle([...Array(size / 2).keys()]).slice(0, byes));
  const first = [];
  for (let m = 0; m < size / 2; m++) {
    first.push(byeSlots.has(m)
      ? { a: order.shift(), b: null, winner: null }
      : { a: order.shift(), b: order.shift(), winner: null });
  }
  const rounds = [first];
  for (let len = size / 4; len >= 1; len /= 2) {
    rounds.push(Array.from({ length: len }, () => ({ a: null, b: null, winner: null })));
  }
  first.forEach((mt, m) => { if (mt.b === null) setWinner(rounds, 0, m, mt.a); });
  return rounds;
}

export function setWinner(rounds, r, m, winner) {
  rounds[r][m].winner = winner;
  if (r + 1 < rounds.length) rounds[r + 1][m >> 1][m % 2 ? "b" : "a"] = winner;
}

// Next playable match in bracket order, or null when the champion is decided.
export function nextMatch(rounds) {
  for (let r = 0; r < rounds.length; r++) {
    for (let m = 0; m < rounds[r].length; m++) {
      const mt = rounds[r][m];
      if (mt.winner === null && mt.a !== null && mt.b !== null) return { r, m };
    }
  }
  return null;
}

export const champion = (rounds) => rounds[rounds.length - 1][0].winner;

// "Final", "Semifinals", "Quarterfinals", else "Round of N"
export function roundName(rounds, r) {
  const left = rounds.length - r;
  return left === 1 ? "Final" : left === 2 ? "Semifinals" : left === 3 ? "Quarterfinals"
    : `Round of ${2 ** left}`;
}

// Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, music.youtube.com, or a bare id.
export function youtubeId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}
