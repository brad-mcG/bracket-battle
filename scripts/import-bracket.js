// Importer: turns a researched entry list into a saved bracket.
//   node scripts/import-bracket.js <entries.json> "<Topic>" "<Owner name>" [--owner <id>] [--repair <bracketId>] [--base <url>]
// entries.json: [{ name, wikiTitle?, coverUrl?, yt? }]. A wikiTitle is resolved to the article's
// lead image through the Wikipedia API (SVG logos become a PNG rendering). Covers are downloaded
// into data/covers/, checked to really be an image, shrunk to at most 800px, and every trailer is
// re-checked against YouTube oEmbed (401 = embedding disabled, so it's dropped).
// --repair <id>: keep what the saved bracket already has and only fetch what's missing.
// Without --owner, a fresh owner id is made and its one-time ?claim= link printed.
// Needs the server running.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { COVERS, getBracket } from "../src/store.js"; // honours DATA_DIR like the server

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const owner = opt("--owner", null);
const repair = opt("--repair", null);
const base = opt("--base", "http://localhost:3002");
const [file, title, ownerName] = args;
if (!file || !title || !ownerName) { console.error("usage: import-bracket.js <entries.json> <topic> <owner name> [--owner <id>] [--repair <bracketId>] [--base <url>]"); process.exit(1); }

fs.mkdirSync(COVERS, { recursive: true });
const UA = "BracketBattle/0.1 (https://github.com/brad-mcG/bracket-battle)"; // a contact URL in the UA lifts Wikimedia's limit from 10 to 200 req/min
const MAX_SIDE = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

function imageExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.subarray(0, 4).toString("hex") === "89504e47") return "png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "gif";
  return null;
}

// Wikimedia throttles bursts hard: pace every request and back off on 429
let last = 0;
async function fetchPaced(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    const wait = last + 600 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(url, { ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
    if ((r.status !== 429 && r.status < 500) || i === tries - 1) return r;
    await sleep(5000 * (i + 1));
  }
}

// the article's lead image, as the API's rendered thumbnail
async function wikiImage(wikiTitle) {
  const q = new URLSearchParams({ action: "query", prop: "pageimages", piprop: "original|thumbnail", pithumbsize: String(MAX_SIDE), pilicense: "any", redirects: "1", format: "json", titles: wikiTitle });
  const r = await fetchPaced(`https://en.wikipedia.org/w/api.php?${q}`);
  if (!r.ok) throw new Error(`wikipedia HTTP ${r.status}`);
  const page = Object.values((await r.json()).query?.pages || {})[0];
  if (!page || page.missing !== undefined) throw new Error("no such article");
  const orig = page.original?.source, thumb = page.thumbnail?.source;
  if (!orig && !thumb) throw new Error("article has no image");
  // thumb.wikimedia.org serves scripts; upload.wikimedia.org originals answer 429. The thumbnail
  // is already our target size, and SVG logos only exist as a rendering anyway.
  let url = thumb || orig;
  // a small original comes back "unscaled" on upload.wikimedia.org, which answers 429 to
  // scripts, and only pre-rendered sizes exist on thumb.wikimedia.org: fall back to the
  // page summary's 330px thumbnail, which is always rendered
  if (/^https:\/\/upload\.wikimedia\.org\//.test(url)) {
    const rs = await fetchPaced(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title.replace(/ /g, "_"))}`);
    const sum = rs.ok ? await rs.json() : null;
    if (sum?.thumbnail?.source) url = sum.thumbnail.source;
  }
  return url;
}

// shrink to MAX_SIDE on the long edge; png stays png (logos need transparency), the rest become jpeg
async function shrink(buf, ext) {
  const img = await loadImage(buf);
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (k === 1 && ext !== "webp") return { buf, ext };
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = createCanvas(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return ext === "png" || ext === "gif" ? { buf: await c.encode("png"), ext: "png" } : { buf: await c.encode("jpeg", 88), ext: "jpg" };
}

async function fetchCover(e) {
  const url = e.coverUrl || (e.wikiTitle ? await wikiImage(e.wikiTitle) : null);
  if (!url) throw new Error("no cover url or wikiTitle");
  const r = await fetchPaced(url);
  let buf = Buffer.from(await r.arrayBuffer());
  let ext = r.ok && imageExt(buf);
  if (!ext) throw new Error(`HTTP ${r.status}, ${r.headers.get("content-type") || "no type"}, not an image`);
  ({ buf, ext } = await shrink(buf, ext));
  // the url hash keeps same-named entries in different brackets from overwriting each other
  const name = `${slug(e.name)}-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 6)}.${ext}`;
  fs.writeFileSync(path.join(COVERS, name), buf);
  return `covers/${name}`;
}

const entries = JSON.parse(fs.readFileSync(file, "utf8"));
const existing = repair ? getBracket(repair) : null;
if (repair && !existing) { console.error("no saved bracket", repair); process.exit(1); }
const out = [], problems = [];
for (const e of entries) {
  const had = existing?.entries.find((x) => x.name === e.name);
  let img = had?.img || null, yt = had?.yt || null;
  if (!img) {
    try { img = await fetchCover(e); }
    catch (err) { problems.push(`${e.name}: cover failed (${err.message})`); }
  }
  if (!yt && e.yt) {
    const r = await fetchPaced(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${e.yt}`);
    if (r.status === 200) yt = e.yt;
    else problems.push(`${e.name}: trailer ${e.yt} dropped (oEmbed ${r.status})`);
  }
  out.push({ name: e.name, yt, img, stats: e.stats || had?.stats || null, case: e.case || had?.case || null, wiki: e.wiki || e.wikiTitle || had?.wiki || null });
  process.stdout.write(img ? "." : "x");
}

const userId = owner || existing?.createdBy || crypto.randomBytes(16).toString("hex");
const r = await fetch(`${base}/api/brackets`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: repair || undefined, title, entries: out, userId, name: ownerName }),
});
const res = await r.json();
if (!r.ok) { console.error("\nsave failed:", res); process.exit(1); }

console.log(`\nsaved bracket ${res.id}: ${out.length} entries, ${out.filter((e) => e.img).length} covers, ${out.filter((e) => e.yt).length} trailers`);
if (problems.length) console.log("problems:\n  " + problems.join("\n  "));
if (!owner && !existing) console.log(`owner id: ${userId}\nclaim link: ${base}/?claim=${userId}&name=${encodeURIComponent(ownerName)}`);
