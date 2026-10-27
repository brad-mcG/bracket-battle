// Draws a finished run as one PNG: title on top, mirrored bracket with a square-cropped
// cover and the name under every slot, scores on the connectors, champion in the middle.
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { dimensions, isPrivateAddress } from "./imagecheck.js";
import { layoutBracket, HEADER, CHAMP_ICON } from "./layout.js";
import { COVERS } from "./store.js";

const C = { bg: "#16171d", panel: "#22242d", line: "#3d4152", text: "#eceef4", muted: "#9298a8", win: "#6fd38a", gold: "#f0c75e", a: "#f0a63c", b: "#5aa7f0" };
const FONT = "'Segoe UI', 'DejaVu Sans', Arial, sans-serif";
const UA = "BracketBattle/0.1 (https://ddns.themcglawns.net/brackets/)";

// A pasted picture link makes the SERVER fetch it, so: public addresses only, no redirects,
// a hard byte cap while streaming (fetch inflates gzip, so content-length alone is no cap),
// and a pixel cap read from the header before anything is decoded.
const MAX_BYTES = 2e6, MAX_PIXELS = 4e6;
async function fetchCover(url) {
  const addrs = await dns.lookup(new URL(url).hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual", headers: { "user-agent": UA } });
  if (r.status !== 200 || +(r.headers.get("content-length") || 0) > MAX_BYTES) return null;
  const reader = r.body.getReader(), parts = [];
  for (let n = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((n += value.length) > MAX_BYTES) { await reader.cancel(); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// the cover as a small square canvas; the full-size bitmap is dropped right away so a
// 128-entry render never holds 128 big images at once
async function loadCover(img, size) {
  if (!img) return null;
  try {
    const buf = img.startsWith("covers/") ? await fs.promises.readFile(path.join(COVERS, img.slice(7))) : await fetchCover(img);
    if (!buf) return null;
    const dim = dimensions(buf);
    if (!dim || dim[0] * dim[1] > MAX_PIXELS) return null;
    const full = await loadImage(buf);
    const c = createCanvas(size, size), ctx = c.getContext("2d");
    const s = Math.min(full.width, full.height);
    ctx.drawImage(full, (full.width - s) / 2, (full.height - s) / 2, s, s, 0, 0, size, size);
    return c;
  } catch { return null; }
}

// greedy wrap to at most `lines` lines, ellipsis on the last
function wrap(ctx, text, maxW, lines) {
  const words = String(text).split(/\s+/), out = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { out.push(cur); cur = w; }
    if (out.length === lines) break;
  }
  if (out.length < lines) out.push(cur);
  if (out.length > lines || (out.length === lines && cur && out[lines - 1] !== cur)) {
    out.length = lines;
    let last = out[lines - 1];
    while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    out[lines - 1] = last + "…";
  } else {
    const i = out.length - 1;
    while (ctx.measureText(out[i]).width > maxW && out[i].length > 1) out[i] = out[i].slice(0, -1);
    if (out[i] !== (words.length ? cur : "") && !out[i].endsWith("…") && ctx.measureText(out[i]).width > maxW) out[i] += "…";
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.closePath();
}

// the cover (already a square canvas) into (x, y, size), or initials when there is none
function drawIcon(ctx, img, x, y, size, label) {
  roundRect(ctx, x, y, size, size, 8);
  ctx.save(); ctx.clip();
  if (img) ctx.drawImage(img, x, y, size, size);
  else {
    ctx.fillStyle = "#0e0f13"; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = C.muted; ctx.font = `bold ${Math.round(size * 0.4)}px ${FONT}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((label || "?").trim().slice(0, 2).toUpperCase(), x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

export async function renderPicture(g) {
  const L = layoutBracket(g.rounds);
  const { icon: ICON, slotW: SLOT_W, slotH: SLOT_H } = L;
  const canvas = createCanvas(L.width, L.height);
  const ctx = canvas.getContext("2d");
  // a few covers at a time: bounded memory and bounded concurrent fetches
  const images = new Map();
  for (let i = 0; i < g.entries.length; i += 4) {
    const batch = g.entries.slice(i, i + 4);
    (await Promise.all(batch.map((e) => loadCover(e.img, CHAMP_ICON)))).forEach((c, k) => images.set(i + k, c));
  }

  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, L.width, L.height);

  // header
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text; ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(g.title, L.centerX, 76); // just the category: the picture says the rest

  // connectors + scores
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.lineJoin = "round";
  for (const c of L.connectors) {
    ctx.beginPath();
    c.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    if (c.tally) {
      ctx.font = `bold 12px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const label = `${c.tally.a} – ${c.tally.b}`, w = ctx.measureText(label).width + 10;
      ctx.fillStyle = C.bg; ctx.fillRect(c.tallyAt[0] - w / 2, c.tallyAt[1] - 8, w, 16);
      ctx.fillStyle = C.muted; ctx.fillText(label, c.tallyAt[0], c.tallyAt[1] + 1);
    }
  }

  // slots
  for (const sl of L.slots) {
    const e = sl.entry === null ? null : g.entries[sl.entry];
    ctx.globalAlpha = sl.lost ? 0.45 : 1;
    roundRect(ctx, sl.x, sl.y, SLOT_W, SLOT_H, 10);
    ctx.fillStyle = C.panel; ctx.fill();
    ctx.strokeStyle = sl.final ? (sl.side === 0 ? C.a : C.b) : C.line; ctx.lineWidth = sl.final ? 3 : 1.5; ctx.stroke();
    if (!e) {
      ctx.fillStyle = C.muted; ctx.font = `italic 13px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(sl.bye ? "bye" : "", sl.x + SLOT_W / 2, sl.y + SLOT_H / 2);
      ctx.globalAlpha = 1;
      continue;
    }
    drawIcon(ctx, images.get(sl.entry), sl.x + (SLOT_W - ICON) / 2, sl.y + 7, ICON, e.name);
    ctx.fillStyle = C.text; ctx.font = `13px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    wrap(ctx, e.name, SLOT_W - 12, 2).forEach((line, i) => ctx.fillText(line, sl.x + SLOT_W / 2, sl.y + ICON + 24 + i * 15));
    ctx.globalAlpha = 1;
  }

  // champion
  if (L.champion !== null) {
    const e = g.entries[L.champion];
    const x = L.centerX - CHAMP_ICON / 2, y = L.centerY - CHAMP_ICON / 2 - 10;
    ctx.fillStyle = C.gold; ctx.font = `bold 14px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText("C H A M P I O N", L.centerX, y - 16);
    ctx.save(); ctx.shadowColor = C.gold; ctx.shadowBlur = 28;
    roundRect(ctx, x - 4, y - 4, CHAMP_ICON + 8, CHAMP_ICON + 8, 14); ctx.fillStyle = C.gold; ctx.fill();
    ctx.restore();
    drawIcon(ctx, images.get(L.champion), x, y, CHAMP_ICON, e.name);
    ctx.fillStyle = C.win; ctx.font = `bold 26px ${FONT}`;
    const nameLines = wrap(ctx, e.name, 300, 2);
    nameLines.forEach((line, i) => ctx.fillText(line, L.centerX, y + CHAMP_ICON + 44 + i * 30));
  }

  // footer
  ctx.fillStyle = C.muted; ctx.font = `12px ${FONT}`; ctx.textAlign = "right";
  ctx.fillText("Bracket Battle", L.width - 20, L.height - 14);
  return canvas.encode("png");
}
