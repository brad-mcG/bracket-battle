// End-to-end:  node test-room.js
// Starts its OWN server on port 3003 with a throwaway data folder, so it never touches the
// real data/ (an earlier version wrote into it, and cleaning up after it cost a real save).
// Covers: building brackets via the API, the 128 cap, creator-only edits, picture-url
// filtering, playing part of a game, leaving, and resuming exactly where the host left off.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@colyseus/sdk";

const PORT = 3003;
const base = `127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bracket-test-"));
const srv = spawn(process.execPath, ["server.js"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin" },
  stdio: "ignore",
});
process.on("exit", () => {
  srv.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows may still hold a file; it's in temp anyway
});
for (let i = 0; ; i++) {
  try { await fetch(`http://${base}/api/requests`); break; } // not /api/brackets: that primes the 60 s play-count cache before the game below is played
  catch { if (i > 600) throw new Error("test server didn't start"); await sleep(100); }
}
const post = async (body) => {
  const r = await fetch(`http://${base}/api/brackets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const names = (n) => Array.from({ length: n }, (_, i) => ({ name: `Song ${i + 1}` }));
const host = "test-host-" + Date.now(), bob = "test-bob", cat = "test-cat";

assert.equal((await post({ title: "too big", entries: names(257), userId: host })).status, 400, "257 rejected");
const big = await post({ title: "test 256", entries: names(256), userId: host, name: "Host" });
assert.ok(big.id, "256 accepted");
const odd = await post({ title: "test 37", entries: names(37), userId: host, name: "Host" });
assert.equal((await post({ id: odd.id, title: "hijack", entries: names(3), userId: bob })).status, 403, "only creator edits");
const pubView = await (await fetch(`http://${base}/api/brackets/${odd.id}`)).json();
assert.equal(pubView.createdBy, undefined, "creator id never leaves the server");
assert.equal(pubView.mine, false);
assert.equal((await (await fetch(`http://${base}/api/brackets/${odd.id}?me=${host}`)).json()).mine, true, "creator sees mine");
const pics = await post({ title: "test pics", userId: host, entries: [
  { name: "local", img: "covers/doom.jpg" }, { name: "legacy", img: "/covers/quake.png" },
  { name: "web", img: "https://upload.wikimedia.org/x.png" },
  { name: "evil", img: "javascript:alert(1)" }, { name: "sneaky", img: "/covers/../server.js" },
  { name: "dots", img: "covers/..jpg" }] });
const withCase = await post({ title: "test case", userId: host, entries: [
  { name: "a", stats: " 1982 Heisman · 3× All-American ", case: "Won it all. Twice. " + "x".repeat(900) }, { name: "b" }] });
const wc = await (await fetch(`http://${base}/api/brackets/${withCase.id}`)).json();
assert.equal(wc.entries[0].stats, "1982 Heisman · 3× All-American", "stats line kept and trimmed");
assert.equal(wc.entries[0].case.length, 700, "case capped at 700 chars");
assert.equal(wc.entries[1].case, null, "missing case is null");
const saved = await (await fetch(`http://${base}/api/brackets/${pics.id}`)).json();
assert.deepEqual(saved.entries.map((e) => e.img),
  ["covers/doom.jpg", "covers/quake.png", "https://upload.wikimedia.org/x.png", null, null, null], "picture urls filtered");

const join = async (userId, bracketId, hostId = host) => {
  const room = await new Client(`ws://${base}`).joinOrCreate("game", { userId, name: userId, bracketId, hostId });
  room.onMessage("state", (s) => (room.S = s));
  return room;
};
await assert.rejects(join(host, odd.id, "../../etc"), "path-ish host id refused");

// wait for a state instead of sleeping a fixed time (saves can take 100ms+ on a busy disk)
const until = async (f, label, ms = 5000) => {
  for (const t0 = Date.now(); !f(); await sleep(5)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${label}`);
};
const playedCount = (S) => S.rounds.flat().filter((m) => m.tally).length;

async function playMatches(rooms, n) {
  const [H, B, C] = rooms;
  for (let i = 0; i < n; i++) {
    const played = playedCount(H.S);
    H.send("vote", { side: "a" }); B.send("vote", { side: "a" }); C.send("vote", { side: "b" });
    await until(() => C.S.tally.a + C.S.tally.b === 3, "3 votes");
    assert.deepEqual(B.S.tally, { a: 2, b: 1 }, "tally is live while voting");
    assert.equal(B.S.votes, undefined, "who voted which way is never sent");
    B.send("reveal"); B.send("advance", { side: "a" }); // non-host: both ignored
    await sleep(300); // proving a negative needs a wait
    assert.equal(H.S.revealed, false, "non-host can't end voting");
    H.send("reveal");
    await until(() => C.S.revealed, "end voting");
    assert.deepEqual(C.S.tally, { a: 2, b: 1 });
    assert.equal(C.S.votes, undefined, "no voter names even after voting ends"); assert.equal(C.S.tally.a + C.S.tally.b, 3, "totals stay");
    H.send("advance", { side: "a" });
    await until(() => rooms.every((r) => playedCount(r.S) === played + 1), "everyone sees the advance");
  }
}

// play 10 of 36 matches, everyone leaves, host comes back: same run continues
let rooms = [await join(host, odd.id), await join(bob, odd.id), await join(cat, odd.id)];
await until(() => rooms.every((r) => r.S) && rooms[0].S.here === 3, "everyone joined");
assert.equal(rooms[1].S.hostId, undefined, "host id not broadcast");
assert.ok(!("players" in rooms[1].S), "no roster, names or ids broadcast");
// the invite link joins by the run's random key, never the host id
assert.match(rooms[1].S.joinKey, /^[A-Z]{4}$/, "four-letter join code");
assert.equal((await fetch(`http://${base}/api/join/${rooms[1].S.joinKey.toLowerCase()}`)).status, 200, "code is case-insensitive");
assert.equal(rooms[1].S.joinKey.includes(host), false);
const joinInfo = await (await fetch(`http://${base}/api/join/${rooms[1].S.joinKey}`)).json();
assert.equal(joinInfo.title, "test 37", "join key resolves to the open room");
assert.equal((await fetch(`http://${base}/api/join/nope`)).status, 404, "unknown join key refused");

// junk messages must not take the process down (a null vote used to). Colyseus kicks the
// sender of an unknown message type, so the junk comes from a throwaway client.
const junk = await join("test-junk", odd.id);
let junkClosed = null;
junk.onLeave((code) => (junkClosed = code));
await until(() => rooms[0].S.here === 4, "junk joined");
junk.send("vote", null); junk.send("vote", "a"); junk.send("vote", { side: { a: 1 } }); junk.send("nonsense", 1);
rooms[0].send("advance", null); rooms[0].send("play", null);
await until(() => junkClosed !== null, "junk client kicked for the unknown message type");
await until(() => rooms[0].S.here === 3, "junk gone");
assert.equal((await fetch(`http://${base}/api/requests`)).status, 200, "server survived junk messages");

// host-controlled playback: play starts everyone at 0, the host's player reports pause/seek,
// viewers get where the host is now; only the host can drive it
rooms[0].send("play", { yt: "dQw4w9WgXcQ" });
await until(() => rooms[1].S.nowPlaying && rooms[1].S.nowPlaying.yt === "dQw4w9WgXcQ", "song started for viewers");
assert.equal(rooms[1].S.nowPlaying.paused, false);
assert.ok(rooms[1].S.nowPlaying.offset < 2, "starts near 0");
const started = rooms[1].S.nowPlaying.started;
rooms[0].send("video", { pos: 30, paused: true });
await until(() => rooms[1].S.nowPlaying.paused === true, "viewers see the pause");
assert.equal(rooms[1].S.nowPlaying.offset, 30, "paused offset is exact");
assert.equal(rooms[1].S.nowPlaying.started, started, "pause does not restart the song");
rooms[0].send("video", { pos: 40, paused: false });
await until(() => rooms[1].S.nowPlaying.paused === false, "viewers see the resume");
assert.ok(rooms[1].S.nowPlaying.offset >= 40 && rooms[1].S.nowPlaying.offset < 42, "resumed offset runs from the seek");
rooms[1].send("video", { pos: 999, paused: true }); rooms[0].send("video", { pos: "x" }); rooms[0].send("video", { pos: -1 });
await sleep(200);
assert.equal(rooms[1].S.nowPlaying.paused, false, "viewers and junk can't drive the player");
rooms[0].send("play", { yt: null });
await until(() => rooms[1].S.nowPlaying === null, "stopped");
await sleep(1100); // let the host's 20-messages-a-second bucket reset before the match burst below

// no public room list: the only way to a room id is the host's invite key
assert.equal((await fetch(`http://${base}/api/live`)).status, 404, "no live-room list");
const dan = await new Client(`ws://${base}`).joinById(joinInfo.roomId, { userId: "test-dan", name: "dan" });
dan.onMessage("state", () => {});
await until(() => rooms[0].S.here === 4, "joined by room id");
dan.leave();
await until(() => rooms[0].S.here === 3, "dan left");
// a stage client (a streamer's capture) sees the game but is not a player and cannot vote
let stS = null;
const st = await new Client(`ws://${base}`).joinById(joinInfo.roomId, { stage: true });
st.onMessage("state", (s) => { stS = { ...stS, ...s }; });
await until(() => stS && stS.title === "test 37", "stage gets state");
assert.equal(rooms[0].S.here, 3, "stage is not a player");
assert.equal(stS.isHost, false, "stage is not the host"); assert.equal(stS.drives, false, "stage does not drive playback");
const tallyBefore = rooms[0].S.tally.a + rooms[0].S.tally.b;
st.send("vote", { side: "a" });
await sleep(400);
assert.equal(rooms[0].S.tally.a + rooms[0].S.tally.b, tallyBefore, "stage votes are ignored");
st.leave();
// a second room on the same run is refused ("create" is not exposed; joinOrCreate reuses)
await assert.rejects(new Client(`ws://${base}`).create("game", { userId: host, name: "x", bracketId: odd.id, hostId: host }), "create refused");
const pairs = (S) => JSON.stringify(S.rounds[0].map((m) => [m.a, m.b]));
const firstRound = pairs(rooms[0].S);
await playMatches(rooms, 10);
rooms.forEach((r) => r.leave());
await sleep(300);
const list = await (await fetch(`http://${base}/api/brackets?me=${host}`)).json();
const { updatedAt: _u, ...runSummary } = list.find((b) => b.id === odd.id).run;
assert.deepEqual(runSummary, { phase: "voting", played: 10, total: 36 });
assert.ok(list.find((b) => b.id === odd.id).plays.all >= 1, "play counts reported");

rooms = [await join(host, odd.id), await join(bob, odd.id), await join(cat, odd.id)];
await until(() => rooms.every((r) => r.S) && rooms[0].S.here === 3, "everyone joined");
assert.equal(pairs(rooms[0].S), firstRound, "same seeding after resume");
assert.equal(rooms[0].S.rounds.flat().filter((m) => m.tally).length, 10, "progress kept");
await playMatches(rooms, 26);
assert.equal(rooms[0].S.phase, "done", "37 entries = 36 matchups");
// the finished run has a result picture under a random id
const picId = rooms[0].S.pictureId;
assert.ok(picId && picId !== host, "picture id assigned");
const pic = await fetch(`http://${base}/pictures/${picId}.png`);
assert.equal(pic.status, 200);
assert.equal(pic.headers.get("content-type"), "image/png");
const png = Buffer.from(await pic.arrayBuffer());
assert.equal(png.subarray(1, 4).toString(), "PNG", "really a png");
assert.ok(png.length > 20_000, `picture has content (${png.length} bytes)`);
assert.equal((await fetch(`http://${base}/pictures/nope.png`)).status, 404);
assert.equal((await fetch(`http://${base}/pictures/${host}.png`)).status, 404, "host id is not a picture id");
// Start over retires the old run's picture and link
rooms[0].send("restart");
await until(() => rooms[0].S.phase === "voting", "restarted");
assert.equal((await fetch(`http://${base}/pictures/${picId}.png`)).status, 404, "old picture link dies with the run");
// before these rooms leave (it ends the current match's voting): the host's countdown ends voting on its own; nobody else can start one
if (rooms[0].S.phase === "voting" && !rooms[0].S.revealed) {
  rooms[1].send("timer", { secs: 1 });
  await sleep(300);
  assert.ok(!rooms[0].S.timer, "only the host can start the countdown");
  rooms[0].send("timer", { secs: 1 });
  await until(() => rooms[0].S.timer && rooms[0].S.timer.secs === 1, "countdown broadcast");
  await until(() => rooms[0].S.revealed, "countdown ended voting");
  // 0-0 is a tie: one player is picked to call the coin, and the coin, not the host, decides
  await until(() => rooms[0].S.coin && rooms[0].S.coin.pending, "coin offered");
  const caller = rooms.find((r) => r.S.coin && r.S.coin.mine), bystander = rooms.find((r) => !(r.S.coin && r.S.coin.mine));
  assert.ok(caller, "one player holds the call");
  bystander.send("call", { call: "heads" }); await sleep(300);
  assert.ok(rooms[0].S.coin.pending, "only the caller can call it");
  caller.send("call", { call: "tails" });
  await until(() => rooms[0].S.coin && rooms[0].S.coin.result, "coin flipped");
  const c = rooms[0].S.coin;
  assert.equal(c.winner, c.result === "tails" ? c.side : (c.side === "a" ? "b" : "a"), "the winner follows the call");
  rooms[0].send("advance", { side: c.winner === "a" ? "b" : "a" }); await sleep(300);
  assert.ok(rooms[0].S.coin, "the host cannot advance the coin's loser");
  rooms[0].send("advance", { side: c.winner });
  await until(() => !rooms[0].S.coin && !rooms[0].S.revealed, "the coin's winner advanced");
}
rooms.forEach((r) => r.leave());

// a different host gets their own fresh run of the same bracket
const other = await join(bob, odd.id, bob);
await until(() => other.S, "other host joined");
assert.equal(other.S.phase, "voting");
assert.equal(other.S.isHost, true);
other.leave();

// 256-entry bracket: full 8 rounds, no byes
const r128 = await join(host, big.id);
await until(() => r128.S, "128 joined");
assert.equal(r128.S.rounds.length, 8);
assert.equal(r128.S.rounds[0].filter((m) => m.b === null).length, 0);
r128.leave();

// bracket requests: form -> queue -> runner marks it done
const postJ = async (path, body, headers = {}) => { const r = await fetch(`http://${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const req = await postJ("/api/requests", { title: "Best 90s R&B Song", size: "big", media: "songs", userId: host, name: "Host", notes: "US releases only",
  entries: [{ name: "No Diggity", must: true, comment: "Peaked at #1 for 4 weeks. https://www.youtube.com/watch?v=3KL9mRus19o is the video" }, { name: "" }, { name: "Poison", comment: "" }] });
assert.ok(req.id, "request accepted");
assert.equal((await postJ("/api/requests", { title: "best 90s r&b song", userId: bob, name: "Bob", entries: [] })).status, 409, "duplicate title in queue refused");
const queue = await (await fetch(`http://${base}/api/requests`)).json();
assert.deepEqual(queue.map((r) => [r.title, r.status, r.count]), [["Best 90s R&B Song", "pending", 2]]);
const detail = await (await fetch(`http://${base}/api/requests/${req.id}`)).json();
assert.equal(detail.entries[0].yt, "3KL9mRus19o", "youtube link pulled out of the comment");
assert.equal(detail.entries[0].must, true);
assert.equal((await postJ(`/api/requests/${req.id}/status`, { status: "done" })).status, 403, "status change needs the admin token");
assert.equal((await postJ(`/api/requests/${req.id}/status`, { status: "done", bracketId: odd.id }, { "x-admin-token": "test-admin" })).status, 200);
assert.deepEqual(await (await fetch(`http://${base}/api/requests`)).json(), [], "done requests leave the queue");
// a request worded like an existing bracket is tagged as suggestions for it
const dupReq = await postJ("/api/requests", { title: "The Best TEST 37 of all time!", userId: bob, name: "Bob", entries: [{ name: "Song 99", must: true, comment: "" }] });
assert.equal((await (await fetch(`http://${base}/api/requests/${dupReq.id}`)).json()).relatedTo, odd.id, "duplicate title linked to the existing bracket");
await postJ(`/api/requests/${dupReq.id}/status`, { status: "done" }, { "x-admin-token": "test-admin" });

// write flood from one address gets throttled
let throttled = 0;
for (let i = 0; i < 70; i++) if ((await post({ title: "", entries: [], userId: host })).status === 429) throttled++;
assert.ok(throttled > 0 && throttled < 70, `rate limit kicked in (${throttled} throttled)`);

console.log("room ok");
process.exit(0); // open sockets would otherwise keep the process (and the test server) alive
