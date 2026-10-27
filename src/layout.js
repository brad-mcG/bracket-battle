// Pure geometry for the result picture (no drawing): where every slot, connector and the
// champion go. Mirrored bracket: both halves work inwards, the final and champion sit in
// the middle. Round r of a side has one slot per entry still in it; each slot sits at the
// vertical midpoint of the two slots that fed it.
export const CENTER_W = 620, MARGIN = 40, HEADER = 150, CHAMP_ICON = 176;

export function layoutBracket(rounds) {
  const R = rounds.length;      // rounds including the final
  const side = R - 1;           // columns per side
  // compact slots for the biggest brackets (256 entries = 128 slots per side) so the picture
  // stays under ~12,000px tall
  const k = R >= 8 ? 0.78 : 1;
  const ICON = Math.round(64 * k), SLOT_W = Math.round(124 * k), SLOT_H = Math.round(110 * k), PITCH = Math.round(120 * k), COL_W = Math.round(176 * k);
  const width = 2 * side * COL_W + CENTER_W + 2 * MARGIN;
  const centerX = width / 2;
  const slotX = (s, r) => (s === 0 ? MARGIN + r * COL_W : width - MARGIN - SLOT_W - r * COL_W);
  const slots = [], connectors = [];
  const pos = {}; // "side:round:j" -> slot top y

  for (const s of [0, 1]) {
    for (let r = 0; r < side; r++) {
      const perSide = rounds[r].length / 2; // matches of this round on this side
      for (let j = 0; j < perSide * 2; j++) {
        const m = s * perSide + (j >> 1);
        const field = j % 2 ? "b" : "a";
        const y = r === 0 ? HEADER + j * PITCH : (pos[`${s}:${r - 1}:${2 * j}`] + pos[`${s}:${r - 1}:${2 * j + 1}`]) / 2;
        pos[`${s}:${r}:${j}`] = y;
        const mt = rounds[r][m];
        slots.push({ side: s, r, j, x: slotX(s, r), y, entry: mt[field], lost: mt.winner !== null && mt[field] !== mt.winner, bye: r === 0 && mt[field] === null });
      }
    }
  }

  const slotsPerSide = side ? rounds[0].length : 0; // round 0 has n matches = n slots per side
  let centerY = side ? (pos[`0:${side - 1}:0`] + pos[`0:${side - 1}:1`]) / 2 : 0;
  // the champion card (label above it) must clear the header; small brackets would sit
  // too high, so everything moves down together
  const minCenterY = HEADER + CHAMP_ICON / 2 + 26;
  const shift = Math.max(0, minCenterY - centerY);
  if (shift) { centerY += shift; for (const sl of slots) sl.y += shift; }
  const height = Math.max(HEADER + shift + slotsPerSide * PITCH, centerY + CHAMP_ICON + 40) + MARGIN;
  const final = rounds[R - 1][0];
  const finalSlots = [
    { side: 0, x: centerX - CENTER_W / 2 + 24, y: centerY, entry: final.a, lost: final.winner !== null && final.a !== final.winner, final: true },
    { side: 1, x: centerX + CENTER_W / 2 - 24 - SLOT_W, y: centerY, entry: final.b, lost: final.winner !== null && final.b !== final.winner, final: true },
  ];

  // connectors: each pair of slots joins a vertical bus, which runs on to the next slot
  const cy = (sl) => sl.y + SLOT_H / 2;
  for (const s of [0, 1]) {
    for (let r = 0; r < side; r++) {
      const mine = slots.filter((sl) => sl.side === s && sl.r === r);
      for (let k = 0; k < mine.length / 2; k++) {
        const a = mine[2 * k], b = mine[2 * k + 1];
        const next = r + 1 < side ? slots.find((sl) => sl.side === s && sl.r === r + 1 && sl.j === k) : finalSlots[s];
        const x1 = s === 0 ? a.x + SLOT_W : a.x;
        const xb = s === 0 ? x1 + (COL_W - SLOT_W) / 2 : x1 - (COL_W - SLOT_W) / 2;
        const x2 = s === 0 ? next.x : next.x + SLOT_W;
        const mt = rounds[r][s * (rounds[r].length / 2) + k];
        connectors.push({ points: [[x1, cy(a)], [xb, cy(a)], [xb, cy(b)], [x1, cy(b)]], tally: mt.tally, tallyAt: [xb, (cy(a) + cy(b)) / 2] });
        connectors.push({ points: [[xb, (cy(a) + cy(b)) / 2], [x2, (cy(a) + cy(b)) / 2]] });
      }
    }
  }
  if (!side) { // 2 entries: the final slots are the whole bracket
    finalSlots[0].x = MARGIN; finalSlots[1].x = width - MARGIN - SLOT_W;
  }

  return { width, height, centerX, centerY, slots: [...slots, ...finalSlots], connectors, finalTally: final.tally, champion: final.winner, icon: ICON, slotW: SLOT_W, slotH: SLOT_H };
}
