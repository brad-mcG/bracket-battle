// One live room per (bracket, host). The run is saved to data/games/ after every action,
// so the host can stop halfway and pick it back up just by hosting that bracket again.
// State goes to each client as a personal view so votes stay hidden until the reveal.
import { createRequire } from "node:module";
import { buildBracket, nextMatch, setWinner, youtubeId } from "./bracket.js";
import crypto from "node:crypto";
import { getBracket, getGame, saveGame, validId, gameCount, newId, savePictureRef, removePicture, MAX_GAMES } from "./store.js";

// a join code: four letters with no look-alikes (no I or O), easy to read out on a stream or type on a phone
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const joinCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");

const require = createRequire(import.meta.url);
const { Room } = require("colyseus");

// (bracketId.hostId) -> the room that owns that save file. A second room for the same run
// would save a stale copy over the live one.
const openRuns = new Map();

function newRun(bracket, hostId, hostName) {
  const g = {
    bracketId: bracket.id, hostId, hostName, title: bracket.title,
    entries: bracket.entries, // snapshot: editing the bracket later can't scramble a run in progress
    rounds: buildBracket(bracket.entries.length), phase: "voting",
    current: null, votes: {}, revealed: false, nowPlaying: null, startedAt: Date.now(),
  };
  advanceTo(g);
  return g;
}

function advanceTo(g) {
  g.current = nextMatch(g.rounds);
  g.votes = {};
  g.revealed = false;
  g.nowPlaying = null;
  g.coin = null;
  g.phase = g.current ? "voting" : "done";
  // a finished run gets a result picture under a random id (so its link gives away nothing)
  if (g.phase === "done" && !g.pictureId) {
    g.pictureId = newId();
    savePictureRef(g.pictureId, { bracketId: g.bracketId, hostId: g.hostId });
  }
}

const tally = (g) => {
  const t = { a: 0, b: 0 };
  for (const v of Object.values(g.votes)) t[v.side]++;
  return t;
};

export class GameRoom extends Room {
  onCreate({ bracketId, hostId } = {}) {
    const bracket = getBracket(bracketId);
    if (!validId(hostId)) throw new Error("bad host id");
    if (!bracket || bracket.entries.length < 2) throw new Error("bracket not found");
    this.key = `${bracketId}.${hostId}`;
    if (openRuns.has(this.key)) throw new Error("game already open");
    const saved = getGame(bracketId, hostId);
    if (!saved && gameCount() >= MAX_GAMES) throw new Error("server full");
    this.g = saved || newRun(bracket, hostId, "");
    if (this.g.phase === "done" && !this.g.pictureId) advanceTo(this.g); // runs finished before pictures existed
    if (this.g.nowPlaying) this.g.nowPlaying.started ||= this.g.nowPlaying.at; // runs saved before host control existed
    // the run keeps its own entry snapshot (so an edit can't scramble a game in progress), but
    // fields added to the bracket since (wiki, stats, case, a picture) are welcome
    for (const e of this.g.entries) {
      const cur = bracket.entries.find((x) => x.name === e.name);
      if (cur) for (const k of ["wiki", "stats", "case", "img"]) if (!e[k] && cur[k]) e[k] = cur[k];
    }
    // the invite link carries this random key, never the host's id (which grants host control)
    if (!/^[A-Z]{4}$/.test(this.g.joinKey || "")) { // older runs had a long key: they get a code the first time they open
      const taken = new Set([...openRuns.values()].map((r) => r.g.joinKey));
      do this.g.joinKey = joinCode(); while (taken.has(this.g.joinKey));
    }
    openRuns.set(this.key, this);
    this.armTimer(); // a countdown that was running when the room last closed picks up where it was
    this.armCoin(); // and a coin still waiting for its call gets its 20 seconds again

    this.maxClients = 500;
    this.maxMessagesPerSecond = 20; // past this colyseus closes the sender's connection; every message costs a save + broadcast
    this.players = new Map(); // sessionId -> { id, name }
    this.driver = null; // the host session whose player drives playback (the newest host tab)
    this.setMetadata({ bracketId, hostId, joinKey: this.g.joinKey, title: this.g.title, hostName: this.g.hostName });

    const host = (fn) => (client, msg) => {
      if (this.players.get(client.sessionId)?.id !== this.g.hostId) return;
      fn(msg || {});
      this.sync();
    };

    this.onMessage("vote", (client, msg) => {
      const side = msg && msg.side;
      const me = this.players.get(client.sessionId);
      if (this.g.phase !== "voting" || this.g.revealed || !me || (side !== "a" && side !== "b")) return;
      if (this.g.votes[me.id]?.side === side) return; // unchanged: nothing to save or send
      this.g.votes[me.id] = { side, name: me.name };
      this.sync();
    });

    this.onMessage("reveal", host(() => { if (this.g.phase === "voting") this.endVoting(); }));

    // the coin's caller calls it; the server flips
    this.onMessage("call", (client, msg) => {
      const me = this.players.get(client.sessionId), c = this.g.coin, call = msg && msg.call;
      if (!me || !c || c.call || me.id !== c.caller || (call !== "heads" && call !== "tails")) return;
      this.flip(call);
      this.sync();
    });

    // the host starts a countdown for each match (clips run different lengths, so it never starts itself); 0 cancels
    this.onMessage("timer", host(({ secs }) => {
      if (this.g.phase !== "voting" || this.g.revealed) return;
      const s = Math.min(600, Math.max(0, Math.round(Number(secs) || 0)));
      this.g.timerEnds = s ? Date.now() + s * 1000 : null;
      this.g.timerSecs = s || null;
      this.armTimer();
    }));

    // host advances the leader; on a tie the host breaks it by picking either side
    this.onMessage("advance", host(({ side }) => {
      if (this.g.phase !== "voting" || !this.g.revealed || (side !== "a" && side !== "b")) return;
      const t = tally(this.g);
      if (this.g.coin) { if (side !== this.g.coin.winner) return; } // a tie is the coin's call, not the host's
      else if (t.a !== t.b && side !== (t.a > t.b ? "a" : "b")) return;
      const { r, m } = this.g.current;
      const mt = this.g.rounds[r][m];
      mt.tally = t;
      setWinner(this.g.rounds, r, m, mt[side]);
      advanceTo(this.g);
      this.g.timerEnds = null; clearTimeout(this.timerT); // a new match starts with no countdown
    }));

    this.onMessage("play", host(({ yt }) => {
      const id = youtubeId(yt);
      this.g.nowPlaying = id ? { yt: id, started: Date.now(), at: Date.now(), pos: 0, paused: false } : null;
    }));

    // the driving host tab's player reports play, pause and seeks; every other player follows
    this.onMessage("video", (client, msg) => {
      const np = this.g.nowPlaying, { pos, paused } = msg || {};
      if (client.sessionId !== this.driver || !np || typeof pos !== "number" || !(pos >= 0 && pos < 86400)) return;
      Object.assign(np, { pos, paused: !!paused, at: Date.now() });
      this.sync();
    });

    // fresh shuffle from the bracket's current entries
    this.onMessage("restart", host(() => {
      const b = getBracket(this.g.bracketId);
      if (!b || b.entries.length < 2) return;
      if (this.g.pictureId) removePicture(this.g.pictureId); // the old result and its link go with the run
      this.g = { ...newRun(b, this.g.hostId, this.g.hostName), joinKey: this.g.joinKey }; // the invite link survives a restart
      clearTimeout(this.timerT); clearTimeout(this.coinT);
      for (const c of this.clients) c.userData = {}; // the entries may have been edited: send them again
    }));
  }

  // with this defined, colyseus wraps every handler in try/catch; without it one bad
  // message from anyone takes the whole process down
  onUncaughtException(err, method) {
    console.error("[room]", method, err);
  }

  // voting ends: by the host's click or by the countdown. A tie goes to a coin: one voter (any player when
  // nobody voted) is picked to call heads or tails for their side; the flip decides
  endVoting() {
    this.g.revealed = true; this.g.timerEnds = null; clearTimeout(this.timerT);
    const t = tally(this.g);
    if (t.a !== t.b) return;
    const voters = Object.keys(this.g.votes);
    const pool = voters.length ? voters : [...new Set([...this.players.values()].map((p) => p.id))];
    const caller = pool[Math.floor(Math.random() * pool.length)] || this.g.hostId;
    this.g.coin = { caller, side: this.g.votes[caller]?.side || "a", call: null, result: null, winner: null };
    this.armCoin();
  }
  flip(call) {
    const c = this.g.coin;
    if (!c || c.call) return;
    c.call = call; c.result = Math.random() < 0.5 ? "heads" : "tails";
    c.winner = c.result === c.call ? c.side : (c.side === "a" ? "b" : "a");
    clearTimeout(this.coinT);
  }
  armCoin() { // nobody waits on a silent caller: after 20 s the server calls heads for them
    clearTimeout(this.coinT);
    if (!this.g.coin || this.g.coin.call) return;
    this.coinT = setTimeout(() => { if (this.g.coin && !this.g.coin.call) { this.flip("heads"); this.sync(); } }, 20000);
  }
  armTimer() {
    clearTimeout(this.timerT);
    if (!this.g.timerEnds) return;
    this.timerT = setTimeout(() => { if (this.g.phase === "voting" && !this.g.revealed) { this.endVoting(); this.sync(); } }, Math.max(0, this.g.timerEnds - Date.now()) + 30);
  }

  onDispose() {
    clearTimeout(this.syncTimer); clearTimeout(this.timerT); clearTimeout(this.coinT);
    if (openRuns.get(this.key) === this) openRuns.delete(this.key);
  }

  onJoin(client, { userId, name, stage } = {}) {
    if (stage) { client.userData = { stage: true }; this.sync(); return; } // a stream capture: watches the game, is not a player, cannot vote
    const id = String(userId || client.sessionId).slice(0, 64);
    const me = { id, name: String(name || "guest").slice(0, 40) };
    this.players.set(client.sessionId, me);
    if (id === this.g.hostId) {
      this.driver = client.sessionId;
      if (me.name !== this.g.hostName) {
        this.g.hostName = me.name;
        this.setMetadata({ hostName: me.name });
      }
    }
    this.sync();
  }

  onLeave(client) {
    this.players.delete(client.sessionId);
    if (this.driver === client.sessionId) this.driver = [...this.players].find(([, p]) => p.id === this.g.hostId)?.[0] || null;
    this.sync();
  }

  // a burst of votes (a big audience) becomes one save and one broadcast every 120 ms
  sync() {
    this.syncTimer ||= setTimeout(() => { this.syncTimer = null; this.flush(); }, 120);
  }

  flush() {
    this.g.updatedAt = Date.now();
    try { saveGame(this.g); } catch (e) { console.error("[save]", e.message); }

    const people = [...new Map([...this.players.values()].map((p) => [p.id, p])).values()];
    // ids stay on the server: the host's id is what grants host control
    const { votes, revealed, nowPlaying, hostId, entries, timerEnds, timerSecs, coin, ...rest } = this.g;
    for (const client of this.clients) {
      const me = this.players.get(client.sessionId);
      const u = (client.userData ||= {});
      const first = !u.gotEntries; // the entry list never changes mid-run: send it once per client
      u.gotEntries = true;
      client.send("state", {
        ...rest,
        ...(first ? { entries } : {}),
        revealed,
        isHost: me?.id === hostId,
        drives: client.sessionId === this.driver, // this tab's player sets playback for the room
        joinKey: this.g.joinKey,
        hostHere: people.some((p) => p.id === hostId),
        here: people.length, // heads in the room (a stage capture is not one); names never leave the server
        myVote: me && votes[me.id]?.side,
        tally: tally(this.g), // live: the cards fight in real time; totals are all anyone sees
        timer: timerEnds ? { left: Math.max(0, timerEnds - Date.now()), secs: timerSecs } : null, // the host's countdown
        // the tie coin: who holds the call stays on the server; each client only learns whether it is them
        coin: coin && { pending: !coin.call, mine: me?.id === coin.caller, side: coin.side, call: coin.call, result: coin.result, winner: coin.winner },
        // where the host's player is right now, so late joiners and followers land in sync
        nowPlaying: nowPlaying && {
          yt: nowPlaying.yt, started: nowPlaying.started, at: nowPlaying.at, paused: !!nowPlaying.paused,
          offset: (nowPlaying.pos || 0) + (nowPlaying.paused ? 0 : (Date.now() - nowPlaying.at) / 1000),
        },
      });
    }
  }
}
