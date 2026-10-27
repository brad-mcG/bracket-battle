// The streaming-style pieces shared by the front page and the browse page: category shelves,
// 16:9 tiles that pop out into a preview on hover, and the pick of brackets for the hero.
import { h, api } from "./ui.js";

// categories, read off the titles (a bracket lands in the first shelf that matches)
export const SHELVES = [
  ["Halloween", /halloween|horror|monster|witch|vampire|ghost|slasher|spooky/i], // seasonal: first shelf while it has brackets
  ["Sports", /nfl|nba|ufc|boxer|wrestler|heisman|football|dunk|super bowl|fighter|quarterback|running back/i],
  ["Music", /song|album|rapper|guitar|drummer|bass player|band|soundtrack|one-hit|taylor swift/i],
  ["Food & drink", /food|bbq|pizza|pasta|cuisine|soda|takeout|fruit|vegetable|thanksgiving|candy|cereal|dish/i],
  ["Games", /game|console|shooter|franchise|grand theft|pok[eé]mon/i],
  ["Pop Culture", /movie|tv show|anime|cartoon|character|moment|villain|superhero|dragon|harry potter|star wars|simpsons|pixar|mcu|comedian|meme/i],
];
export const shelfOf = (b) => (SHELVES.find(([, re]) => re.test(b.title)) || ["More"])[0];
export const covers = (b, n = 6) => (b.covers || []).slice(0, n).map((src) => h("img", { src, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }));
const details = new Map(); // bracket id -> promise of the full bracket (for the entry names)
export const detail = (id) => { if (!details.has(id)) details.set(id, api(`api/brackets/${id}`).catch(() => null)); return details.get(id); };
export const firstNames = (d, n = 6) => d ? d.entries.slice(0, n).map((e) => e.name).join(" · ") + (d.entries.length > n ? " · …" : "") : "";
export const runPct = (b) => (b.run.phase === "done" ? 100 : (100 * b.run.played) / b.run.total);
export const playLabel = (b) => (b.run && b.run.phase !== "done" ? "▶ Resume" : b.run ? "▶ Replay" : "▶ Host");

// what the hero shows, in order: the run you touched last, one random seasonal bracket, then the
// most played ever / this month / this week / today. A bracket earns one slide only; any slot
// that repeats one (or has no data yet) is filled at random from the rest.
const SEASON = { 9: ["Halloween", SHELVES[0][1]], 10: ["Thanksgiving", /thanksgiving/i], 11: ["Christmas", /christmas|holiday/i] }; // month index -> kicker, titles
export function heroSlides(brackets) {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const top = (key) => { const best = [...brackets].sort((x, y) => (y.plays?.[key] || 0) - (x.plays?.[key] || 0))[0]; return best && best.plays?.[key] > 0 ? best : null; };
  const started = brackets.filter((b) => b.run && b.run.phase !== "done").sort((x, y) => (y.run.updatedAt || 0) - (x.run.updatedAt || 0));
  const season = SEASON[new Date().getMonth()];
  const seasonal = season ? brackets.filter((b) => season[1].test(b.title)) : [];
  const wanted = [
    ["Continue", started[0]],
    [season ? season[0] : "Featured", seasonal.length ? pick(seasonal) : null],
    ["Most played", top("all")], ["Hot this month", top("month")], ["Hot this week", top("week")], ["Hot today", top("day")],
  ];
  const used = new Set(), out = [];
  for (let [kicker, b] of wanted) {
    if (!b || used.has(b.id)) { const rest = brackets.filter((x) => !used.has(x.id)); if (!rest.length) continue; b = pick(rest); kicker = "Featured"; }
    used.add(b.id); out.push({ ...b, kicker });
  }
  return out;
}

// the hero: a few brackets as full-width slides, crossfading, with chevrons and dots; auto-advances
// overlay: an extra element laid over the top of the slides (the front page puts its pitch there)
export function hero(slides, open, { kickers = true, overlay = null } = {}) {
  let i = -1, timer = null;
  const stage = h("div", { className: "stage" });
  const dots = slides.map((_, k) => h("button", { className: "dot", title: slides[k].title, onclick: () => show(k) }));
  const slide = (b) => {
    const blurb = h("p", { className: "blurb" }, " ");
    detail(b.id).then((d) => { if (blurb.isConnected) blurb.textContent = firstNames(d, 7); });
    return h("div", { className: "slide" },
      h("div", { className: "bg" }, h("img", { src: (b.covers || [])[0] || "", alt: "" })),
      h("div", { className: "shade" }),
      h("div", { className: "art", onclick: () => open(b) }, h("div", { className: "collage" }, covers(b))),
      h("div", { className: "copy" },
        kickers && h("div", { className: "kicker" }, b.kicker || "Featured"),
        h("h2", { className: "ht" }, b.title),
        h("div", { className: "meta" }, `${b.count} entries · ${shelfOf(b)}` + (b.run && b.run.phase !== "done" ? ` · ${b.run.played} of ${b.run.total} played` : "")),
        blurb,
        h("div", { className: "row" }, h("button", { className: "primary cta", onclick: () => open(b) }, playLabel(b)))));
  };
  function show(k) {
    const next = (k + slides.length) % slides.length;
    if (next === i) return;
    i = next;
    const old = stage.firstChild, s = slide(slides[i]);
    stage.append(s);
    requestAnimationFrame(() => s.classList.add("in"));
    if (old) setTimeout(() => old.remove(), 700);
    dots.forEach((d, j) => d.classList.toggle("on", j === i));
    arm();
  }
  function arm() { clearInterval(timer); timer = setInterval(() => show(i + 1), 9000); }
  const el = h("section", { className: "carousel", onmouseenter: () => clearInterval(timer), onmouseleave: arm },
    stage,
    slides.length > 1 && h("button", { className: "hnav prev", title: "Previous", onclick: () => show(i - 1) }, "‹"),
    slides.length > 1 && h("button", { className: "hnav next", title: "Next", onclick: () => show(i + 1) }, "›"),
    slides.length > 1 && h("div", { className: "dots" }, dots),
    overlay);
  show(0);
  return el;
}

// a row you page with the chevrons at its edges (no scrollbar); the strip itself still swipes
export function shelf(name, items, render) {
  if (!items.length) return null;
  const strip = h("div", { className: "strip" }, items.map(render));
  const page = (dir) => strip.scrollBy({ left: dir * strip.clientWidth * 0.9, behavior: "smooth" });
  const prev = h("button", { className: "nav prev", title: "Back", onclick: () => page(-1) }, "‹");
  const next = h("button", { className: "nav next", title: "More", onclick: () => page(1) }, "›");
  const edges = () => { prev.hidden = strip.scrollLeft < 8; next.hidden = strip.scrollLeft + strip.clientWidth > strip.scrollWidth - 8; };
  strip.addEventListener("scroll", edges, { passive: true });
  addEventListener("resize", edges);
  requestAnimationFrame(edges);
  return h("section", { className: "shelf" }, h("h2", {}, name), h("div", { className: "stripwrap" }, prev, strip, next));
}

// hover a tile for a moment and it pops out into a larger preview with the first entries and a play button
let peek = null, peekTimer = null;
function showPeek(tileEl, b, open, edit) {
  const r = tileEl.getBoundingClientRect();
  const W = Math.min(Math.round(r.width * 1.45), innerWidth - 32);
  const left = Math.max(16, Math.min(innerWidth - W - 16, r.left + r.width / 2 - W / 2));
  const top = r.top - Math.round((W / r.width - 1) * r.height) / 2 - 8;
  hidePeek(true);
  const names = h("div", { className: "names" }, " ");
  peek = h("div", { className: "peek", style: `left:${left + scrollX}px; top:${top + scrollY}px; width:${W}px`, onmouseleave: () => hidePeek() },
    h("div", { className: "collage", onclick: () => open(b) }, covers(b), h("span", { className: "count" }, String(b.count))),
    b.run && h("div", { className: "progress" + (b.run.phase === "done" ? " done" : "") }, h("div", { style: `width:${runPct(b)}%` })),
    h("div", { className: "pbody" },
      h("div", { className: "row" },
        h("button", { className: "primary", onclick: () => open(b) }, playLabel(b)),
        edit && h("button", { className: "icon", title: "Edit this bracket", onclick: () => edit(b) }, "✎")),
      h("div", { className: "tt" }, b.title),
      names));
  document.body.append(peek);
  requestAnimationFrame(() => peek && peek.classList.add("in"));
  detail(b.id).then((d) => { if (names.isConnected) names.textContent = firstNames(d); });
}
function hidePeek(now) {
  clearTimeout(peekTimer);
  const p = peek; peek = null;
  if (!p) return;
  if (now) return p.remove();
  p.classList.remove("in"); setTimeout(() => p.remove(), 200);
}
// the preview goes away as soon as the pointer is off it or the page moves
document.addEventListener("mousemove", (e) => { if (peek && !peek.contains(e.target)) hidePeek(); }, { passive: true });
addEventListener("scroll", () => hidePeek(true), { passive: true });

// a tile is the whole action: click it to open the bracket; hover it and it opens up
export function tile(b, open, edit) {
  const el = h("div", { className: "tile", onclick: () => open(b),
    onmouseenter: () => { clearTimeout(peekTimer); peekTimer = setTimeout(() => showPeek(el, b, open, edit), 380); },
    onmouseleave: () => clearTimeout(peekTimer) },
    h("div", { className: "collage" }, covers(b), h("span", { className: "count" }, String(b.count))),
    b.run && h("div", { className: "progress" + (b.run.phase === "done" ? " done" : "") }, h("div", { style: `width:${runPct(b)}%` })),
    h("div", { className: "tt" }, b.title));
  return el;
}
