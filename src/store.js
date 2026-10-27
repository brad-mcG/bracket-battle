// JSON-file storage. data/brackets/<id>.json = a saved bracket (topic + entries).
// data/games/<bracketId>.<hostId>.json = one host's run through that bracket.
// ponytail: flat files, fine for hundreds of brackets; move to SQLite if this goes public at scale.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// DATA_DIR lets tests (and a second copy) use their own folder instead of the real data/
export const DATA = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const COVERS = path.join(DATA, "covers");
export const PICTURES = path.join(DATA, "pictures");
const BRACKETS = path.join(DATA, "brackets");
const GAMES = path.join(DATA, "games");

export const MAX_ENTRIES = 256;
// ponytail: flat caps so strangers can't fill the disk; per-user quotas once accounts exist
export const MAX_BRACKETS = 2000;
export const MAX_GAMES = 5000;
// every id that touches a file path must pass this (ids arrive from the browser)
export const validId = (s) => typeof s === "string" && /^[\w-]{1,64}$/.test(s);
export const newId = () => crypto.randomBytes(6).toString("base64url");

const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const write = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); // tmp + rename: a crash mid-write can't corrupt the save
  fs.renameSync(file + ".tmp", file);
};

export const getBracket = (id) => (validId(id) ? read(path.join(BRACKETS, id + ".json")) : null);
export const saveBracket = (b) => write(path.join(BRACKETS, b.id + ".json"), b);
const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
export const listBrackets = () => ls(BRACKETS).filter((f) => f.endsWith(".json"))
  .map((f) => read(path.join(BRACKETS, f))).filter(Boolean)
  .sort((a, b) => b.updatedAt - a.updatedAt);

const gameFile = (bracketId, hostId) => path.join(GAMES, `${bracketId}.${hostId}.json`);
export const getGame = (bracketId, hostId) =>
  validId(bracketId) && validId(hostId) ? read(gameFile(bracketId, hostId)) : null;
export const saveGame = (g) => write(gameFile(g.bracketId, g.hostId), g);
export const bracketCount = () => ls(BRACKETS).length;
export const gameCount = () => ls(GAMES).length;

// bracket requests: what a visitor asked for, waiting for the research runner
const REQUESTS = path.join(DATA, "requests");
export const MAX_OPEN_REQUESTS = 50;
export const getRequest = (id) => (validId(id) ? read(path.join(REQUESTS, id + ".json")) : null);
export const saveRequest = (r) => write(path.join(REQUESTS, r.id + ".json"), r);
export const listRequests = () => ls(REQUESTS).filter((f) => f.endsWith(".json"))
  .map((f) => read(path.join(REQUESTS, f))).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);

// a finished run's picture: pictures/<id>.json says which run it is, pictures/<id>.png is
// the rendered result (made on first request)
export const picturePath = (id) => path.join(PICTURES, id + ".png");
export const savePictureRef = (id, ref) => write(path.join(PICTURES, id + ".json"), ref);
export const getPictureRef = (id) => (validId(id) ? read(path.join(PICTURES, id + ".json")) : null);
export const removePicture = (id) => { for (const ext of [".json", ".png"]) fs.rmSync(path.join(PICTURES, id + ext), { force: true }); };
// how often each bracket gets played: runs touched in the last day / week / month and ever,
// by game-file mtime (every action saves the run). Cached a minute; it stats every game file.
let playsCache = { at: 0, counts: {} };
export function playCounts() {
  if (Date.now() - playsCache.at < 60_000) return playsCache.counts;
  const now = Date.now(), DAY = 86_400_000, counts = {};
  for (const f of ls(GAMES)) {
    if (!f.endsWith(".json")) continue;
    let m; try { m = fs.statSync(path.join(GAMES, f)).mtimeMs; } catch { continue; }
    const id = f.split(".")[0];
    const c = (counts[id] ||= { all: 0, month: 0, week: 0, day: 0 });
    c.all++;
    if (now - m < 30 * DAY) c.month++;
    if (now - m < 7 * DAY) c.week++;
    if (now - m < DAY) c.day++;
  }
  playsCache = { at: now, counts };
  return counts;
}

// all of one host's saved runs, keyed by bracket id
export function gamesForHost(hostId) {
  if (!validId(hostId)) return {};
  const out = {};
  for (const f of ls(GAMES)) {
    const [bracketId, h] = f.split(".");
    if (h === hostId && f.endsWith(".json")) out[bracketId] = read(path.join(GAMES, f));
  }
  return out;
}
