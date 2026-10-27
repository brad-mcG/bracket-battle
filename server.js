// Static client + bracket API + Colyseus game rooms on one port.
// Share http://<your-ddns>:3002 with friends.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express from "express";
import { GameRoom } from "./src/GameRoom.js";
import { youtubeId } from "./src/bracket.js";
import fs from "node:fs";
import { renderPicture } from "./src/picture.js";
import { getBracket, saveBracket, listBrackets, gamesForHost, playCounts, bracketCount, getGame, getPictureRef, picturePath, getRequest, saveRequest, listRequests, validId, newId, MAX_ENTRIES, MAX_BRACKETS, MAX_OPEN_REQUESTS, COVERS, PICTURES } from "./src/store.js";

const require = createRequire(import.meta.url);
const { Server, matchMaker } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.set("trust proxy", "loopback"); // Caddy on the same box passes the real client IP
app.use(express.json({ limit: "200kb" }));

// per-IP cap on writes (bracket saves and room joins). ponytail: in-memory sliding window,
// fine for one process; a real store if this ever runs on more than one.
const POST_LIMIT = 60, POST_WINDOW = 60_000;
const postLog = new Map(); // ip -> [timestamps]
app.use((req, res, next) => {
  if (req.method !== "POST" && !req.path.startsWith("/pictures/") && !req.path.startsWith("/api/join/")) return next(); // writes, renders, join-code lookups (a four-letter code must not be guessable at speed)
  const now = Date.now();
  const hits = (postLog.get(req.ip) || []).filter((t) => now - t < POST_WINDOW);
  if (hits.length >= POST_LIMIT) return res.status(429).json({ error: "Slow down." });
  hits.push(now);
  postLog.set(req.ip, hits);
  if (postLog.size > 10_000) postLog.clear(); // crude, but bounded
  next();
});

// every saved bracket, plus how far the asking host got in each one
app.get("/api/brackets", (req, res) => {
  const mine = gamesForHost(req.query.me);
  const plays = playCounts();
  res.json(listBrackets().map((b) => {
    const run = mine[b.id];
    return {
      id: b.id, title: b.title, count: b.entries.length, creatorName: b.creatorName,
      covers: b.entries.filter((e) => e.img).slice(0, 6).map((e) => e.img), // for the front page collages (3 x 2)
      mine: b.createdBy === req.query.me, updatedAt: b.updatedAt,
      plays: plays[b.id] || { all: 0, month: 0, week: 0, day: 0 }, // runs by anyone, for the front page's "most played"
      run: run && {
        phase: run.phase,
        played: run.rounds.flat().filter((m) => m.tally).length,
        total: run.entries.length - 1,
        updatedAt: run.updatedAt || run.startedAt || 0,
      },
    };
  }));
});

app.get("/api/brackets/:id", (req, res) => {
  const b = getBracket(req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  const { createdBy, ...pub } = b; // the creator's id is what lets them edit: never send it out
  res.json({ ...pub, mine: createdBy === req.query.me });
});

// an entry picture is either a cover saved on this server or an https link to a named host
// (players' browsers fetch it, so no plain http and no raw IP addresses). Saved covers are
// stored as the relative "covers/x.jpg" so they resolve under any path prefix.
// a Wikipedia article title; a pasted article URL (desktop or mobile, percent-encoded) is accepted too
const wikiTitle = (s) => {
  let w = String(s || "").trim().replace(/^https?:\/\/en\.(m\.)?wikipedia\.org\/wiki\//, "");
  try { w = decodeURIComponent(w); } catch {}
  return w.replace(/_/g, " ").slice(0, 200) || null;
};
const imageUrl = (s) => {
  s = String(s || "").trim();
  const local = s.match(/^\/?covers\/([\w-]+(?:\.[\w-]+)*)$/);
  if (local) return `covers/${local[1]}`;
  if (!/^https:\/\/\S+$/.test(s) || s.length > 500) return null;
  try {
    const host = new URL(s).hostname;
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host) ? s : null;
  } catch { return null; }
};

// create (no id) or update (id, creator only)
app.post("/api/brackets", (req, res) => {
  const { id, title, entries, userId, name } = req.body || {};
  if (!validId(userId)) return res.status(400).json({ error: "missing user" });
  const clean = (Array.isArray(entries) ? entries : [])
    .map((e) => ({
      name: String(e?.name || "").trim().slice(0, 100), yt: youtubeId(e?.yt), img: imageUrl(e?.img),
      // one line of credentials and a 2-4 sentence case for winning this bracket
      stats: String(e?.stats || "").trim().slice(0, 140) || null,
      case: String(e?.case || "").trim().slice(0, 700) || null,
      wiki: wikiTitle(e?.wiki),
    }))
    .filter((e) => e.name);
  if (!String(title || "").trim()) return res.status(400).json({ error: "Give the bracket a topic." });
  if (clean.length < 2) return res.status(400).json({ error: "Need at least 2 entries." });
  if (clean.length > MAX_ENTRIES) return res.status(400).json({ error: `Max ${MAX_ENTRIES} entries.` });

  let b = id ? getBracket(id) : null;
  if (id && !b) return res.status(404).json({ error: "not found" });
  if (!b && bracketCount() >= MAX_BRACKETS) return res.status(507).json({ error: "The server is full." });
  if (b && b.createdBy !== userId) return res.status(403).json({ error: "Only the creator can edit this bracket." });
  b = b || { id: newId(), createdBy: userId, creatorName: String(name || "?").slice(0, 40), createdAt: Date.now() };
  Object.assign(b, { title: String(title).trim().slice(0, 80), entries: clean, updatedAt: Date.now() });
  saveBracket(b);
  res.json({ id: b.id });
});

// ---- bracket requests: the form collects intent; the research runner (on the maintainer's PC,
// every 8 hours) builds the bracket, imports it, and marks the request done with ADMIN_TOKEN.
const SIZES = ["auto", "small", "medium", "big", "max"];
const MEDIA = ["auto", "none", "songs", "trailers", "highlights", "openings", "moments", "scenes", "commercials", "gameplay", "standup"];
const linkIn = (text) => { const m = String(text).match(/https?:\/\/\S+/g) || []; return m.map(youtubeId).find(Boolean) || null; };
// "Best Anime Series" ~ "anime series": the same normalisation the form uses to spot duplicates
const normTitle = (s) => String(s).toLowerCase().replace(/\b(the|best|greatest|top|of all time|all time|ever)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

app.get("/api/requests", (_req, res) => {
  res.json(listRequests().filter((r) => r.status !== "done" && r.status !== "rejected").map((r) => ({
    id: r.id, title: r.title, requesterName: r.requesterName, status: r.status, createdAt: r.createdAt, count: r.entries.length,
  })));
});

app.post("/api/requests", (req, res) => {
  const { title, size, media, entries, notes, userId, name, relatedTo } = req.body || {};
  if (!validId(userId)) return res.status(400).json({ error: "missing user" });
  const t = String(title || "").trim().slice(0, 80);
  if (!t) return res.status(400).json({ error: "Name the bracket." });
  const clean = (Array.isArray(entries) ? entries : []).slice(0, 40).map((e) => {
    const comment = String(e?.comment || "").trim().slice(0, 600);
    return { name: String(e?.name || "").trim().slice(0, 100), must: !!e?.must, comment: comment || null, yt: linkIn(comment) };
  }).filter((e) => e.name);
  const open = listRequests().filter((r) => r.status === "pending" || r.status === "building");
  if (open.length >= MAX_OPEN_REQUESTS) return res.status(507).json({ error: "The build queue is full. Try again in a day or two." });
  if (open.some((r) => normTitle(r.title) === normTitle(t))) return res.status(409).json({ error: "That bracket is already being built." });
  // a request that matches an existing bracket is a set of suggestions for it, not a new bracket
  const existing = (validId(relatedTo) && getBracket(relatedTo)) || listBrackets().find((b) => normTitle(b.title) === normTitle(t)) || null;
  const r = {
    relatedTo: existing ? existing.id : null,
    id: newId(), title: t, size: SIZES.includes(size) ? size : "auto", media: MEDIA.includes(media) ? media : "auto",
    entries: clean, notes: String(notes || "").trim().slice(0, 600) || null,
    requesterId: userId, requesterName: String(name || "?").slice(0, 40), status: "pending", createdAt: Date.now(),
  };
  saveRequest(r);
  res.json({ id: r.id });
});

// the runner reports progress: building -> done (with the bracket id) or rejected (with why)
app.post("/api/requests/:id/status", (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get("x-admin-token") !== token) return res.status(403).json({ error: "forbidden" });
  const r = getRequest(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  const { status, bracketId, reason } = req.body || {};
  if (!["pending", "building", "done", "rejected"].includes(status)) return res.status(400).json({ error: "bad status" });
  Object.assign(r, { status, bracketId: validId(bracketId) ? bracketId : r.bracketId || null, reason: String(reason || "").slice(0, 300) || null, updatedAt: Date.now() });
  saveRequest(r);
  res.json({ ok: true });
});
// full detail for the runner (comments included); public, nothing secret in it
app.get("/api/requests/:id", (req, res) => {
  const r = getRequest(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: "not found" });
});

// YouTube title for a pasted link (the builder uses it when no name is typed)
app.get("/api/title/:yt", async (req, res) => {
  const yt = youtubeId(req.params.yt);
  if (!yt) return res.status(400).json({ error: "bad id" });
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://youtu.be/${yt}`);
    res.json({ title: r.ok ? (await r.json()).title : null });
  } catch { res.json({ title: null }); }
});

// the invite link: a run's random join key -> the open room, if the host has it open
app.get("/api/join/:key", async (req, res) => {
  const key = String(req.params.key).toUpperCase();
  const rooms = /^[\w-]{1,64}$/.test(key) ? await matchMaker.query({ name: "game" }) : [];
  const r = rooms.find((x) => String(x.metadata?.joinKey).toUpperCase() === key && x.clients > 0);
  if (!r) return res.status(404).json({ error: "No game with that code right now. Ask the host to open it, then try again." });
  res.json({ roomId: r.roomId, title: r.metadata.title });
});

// games happening right now, so friends can join from the home page. The room id is enough
// to join; the host's id stays private (it's what grants host control).
// there is no public list of open rooms: a game is joined by the host's invite link only (/api/join/:key)

// the result picture of a finished run, drawn on first request and kept. Renders run one at
// a time (a 128-entry picture is ~30 megapixels), and only the newest MAX_PICTURES stay on
// disk; an evicted one is simply drawn again next time it's asked for.
const MAX_PICTURES = 500;
const rendering = new Map(); // id -> pending render, so a burst of requests draws it once
let renderQueue = Promise.resolve();
const evictOldPictures = () => {
  const pngs = fs.readdirSync(PICTURES).filter((f) => f.endsWith(".png"))
    .map((f) => ({ f, t: fs.statSync(path.join(PICTURES, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const p of pngs.slice(0, Math.max(0, pngs.length - MAX_PICTURES + 1))) fs.rmSync(path.join(PICTURES, p.f), { force: true });
};
app.get("/pictures/:id.png", async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(404).json({ error: "not found" });
  const file = picturePath(id);
  if (!fs.existsSync(file)) {
    const ref = getPictureRef(id);
    const g = ref && getGame(ref.bracketId, ref.hostId);
    if (!g || g.pictureId !== id || g.phase !== "done") return res.status(404).json({ error: "not found" });
    // ponytail: drawing blocks the event loop for up to ~1s per picture, so the queue stays short;
    // a worker thread if that ever shows during games
    if (!rendering.has(id) && rendering.size >= 4) return res.status(503).json({ error: "Busy drawing other pictures. Try again in a moment." });
    try {
      if (!rendering.has(id)) {
        const job = renderQueue.then(() => renderPicture(g)).then((png) => {
          fs.mkdirSync(PICTURES, { recursive: true });
          evictOldPictures();
          fs.writeFileSync(file + ".tmp", png);
          fs.renameSync(file + ".tmp", file);
        }).finally(() => rendering.delete(id));
        rendering.set(id, job);
        renderQueue = job.catch(() => {});
      }
      await rendering.get(id);
    } catch (e) {
      console.error("[picture]", e);
      return res.status(500).json({ error: "Could not draw the picture." });
    }
  }
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(file);
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store"), // always serve the latest build
}));
// entry pictures saved on this server (lives in data/ so it moves with the brackets)
app.use("/covers", express.static(COVERS, { maxAge: "7d" }));

const gameServer = new Server({ transport: new WebSocketTransport({ server: http.createServer(app) }) });
gameServer.define("game", GameRoom).filterBy(["bracketId", "hostId"]);
// same-origin app: no CORS headers (colyseus would otherwise reflect any Origin with credentials)
matchMaker.controller.getCorsHeaders = () => ({});
// "create" would open a second room on a run that is already open; joinOrCreate reuses it
matchMaker.controller.exposedMethods = ["joinOrCreate", "joinById", "reconnect"];
// colyseus 0.17 registers /matchmake routes inside listen() — never call server.listen() directly
await gameServer.listen(PORT, HOST);
console.log(`[bracket] http + colyseus on ${HOST}:${PORT}`);
