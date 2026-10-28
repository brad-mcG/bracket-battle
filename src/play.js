// Live game: join the (bracket, host) room and render whatever state the server sends.
// All rules live on the server; the host's buttons just send messages.
import { Client } from "@colyseus/sdk";
import { $, h, fill, go, openYouTube, api, store } from "./ui.js";
import { roundName } from "./bracket.js";

let room = null, S = null, stage = false; // stage: the read-only view a streamer captures (no player, no buttons, the join link on screen)
const send = (type, msg) => room.send(type, msg);

// article title -> URL; keeps "#Section" anchors and "/" (list articles use them), encodes the rest
const wikiUrl = (t) => "https://en.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_")).replace(/%23/g, "#").replace(/%2F/g, "/");

// two clicks instead of confirm(), so a stray click can't wipe a run
const armed = (label, armedLabel, fn) => h("button", { onclick: (e) => {
  if (e.target.dataset.armed) fn();
  else { e.target.dataset.armed = 1; e.target.textContent = armedLabel; }
} }, label);

// One YouTube player for everyone, driven by the host: the host's player has the normal
// controls and reports play/pause/seek to the room; viewers' players have no controls and
// follow the state the server sends (nowPlaying.offset = where the host is right now).
let yt = null, ytReady = false, ytApi = null, playing = null; // playing = { started, at, received, np }

// each listener's own level, kept per browser: the clip plays on their device, so no volume the host sets could reach them
const vol = () => { const v = Number(store.get("vol") ?? 100); return v >= 0 && v <= 100 ? v : 100; };
const setVol = (v) => { store.set("vol", v); if (!ytReady) return; yt.setVolume(v); v ? yt.unMute() : yt.mute(); }; // 0 also mutes: phones ignore setVolume, not mute

function loadYT() {
  ytApi ||= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.append(h("script", { src: "https://www.youtube.com/iframe_api" }));
  });
  return ytApi;
}

// scrubbing fires a burst of play/pause events; the room only needs the last one
let reportTimer = null;
const report = (paused) => {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => yt && send("video", { pos: yt.getCurrentTime(), paused }), 250);
};

// the host's position now, from the last state message
const hostPos = () => playing.np.offset + (playing.np.paused ? 0 : (Date.now() - playing.received) / 1000);

function follow() {
  if (!ytReady) return;
  if (Math.abs(yt.getCurrentTime() - hostPos()) > 1.5) yt.seekTo(hostPos(), true);
  if (playing.np.paused) yt.pauseVideo(); else yt.playVideo();
}

// browsers block autoplay with sound until the page has been clicked: offer a tap to catch up
function offerTap() {
  if (!ytReady || !playing || playing.np.paused || yt.getPlayerState() === 1) return;
  const el = $("player");
  if (el.querySelector(".tap")) return;
  el.append(h("button", { className: "primary tap", onclick: (e) => { e.target.remove(); follow(); } }, "▶ Tap to join the playback"));
}

async function renderPlayer() {
  const np = S && S.nowPlaying;
  if (stage) return; // the stage never shows video: the room hears it in their own browsers, the stream stays clean
  const el = $("player");
  if (!np) {
    if (yt) yt.destroy();
    yt = null; ytReady = false; playing = null;
    el.hidden = true; el.replaceChildren();
    return;
  }
  if (playing && playing.started === np.started && playing.drives === S.drives) { // same song: followers apply the host's latest action
    const changed = np.at !== playing.at;
    playing.at = np.at; playing.np = np; playing.received = Date.now();
    if (changed && !S.drives) { follow(); setTimeout(offerTap, 1500); }
    return;
  }
  // a new song (or this tab just became / stopped being the driver): build a fresh player
  if (yt) yt.destroy();
  yt = null; ytReady = false;
  playing = { started: np.started, at: np.at, np, received: Date.now(), drives: S.drives };
  el.hidden = false;
  fill(el,
    h("div", { className: "vid" }, h("div", { id: "yt" }), !S.drives && h("div", { className: "shield", title: "The host controls playback" })),
    !S.drives && h("div", { className: "row centered vol" }, "🔈",
      h("input", { type: "range", min: 0, max: 100, value: vol(), title: "My volume", oninput: (e) => setVol(+e.target.value) })));
  const YT = await loadYT();
  if (!playing || playing.started !== np.started || playing.drives !== S.drives) return; // changed while the API loaded
  yt = new YT.Player("yt", {
    host: "https://www.youtube-nocookie.com", videoId: np.yt,
    // a paused song is cued, not played: autoplay would report "playing" and resume it for everyone
    playerVars: { autoplay: np.paused ? 0 : 1, start: Math.floor(hostPos()), controls: S.drives ? 1 : 0, disablekb: S.drives ? 0 : 1, rel: 0, playsinline: 1 },
    events: {
      // everyone lands where the host is (the driver too, after a reload) and gets the tap if autoplay was blocked
      onReady: () => { ytReady = true; if (!S.drives) setVol(vol()); follow(); setTimeout(offerTap, 1500); },
      onStateChange: (e) => {
        if (!S.drives) { // a follower: a local pause (background tab) gets the tap to catch up
          if (e.data === 1) el.querySelector(".tap")?.remove();
          else if (e.data === 2 && playing && !playing.np.paused) offerTap();
          return;
        }
        if (e.data === 1 || e.data === 2) report(e.data === 2); // 1 = playing, 2 = paused
        else if (e.data === 0) { clearTimeout(reportTimer); send("video", { pos: yt.getDuration(), paused: true }); } // ended: late joiners land on the end screen, not a replay
      },
    },
  });
}

// a side's share of the vote: 0.5 with no votes, 1 when it has them all
const share = (side) => { const t = S.tally, n = t.a + t.b; return n ? t[side] / n : 0.5; };

function entryCard(side, idx) {
  const e = S.entries[idx];
  const mine = S.myVote === side, s = share(side);
  const t = S.revealed ? S.tally : null;
  // voting over and this side took it (a tie: once the coin has landed, the coin's winner)
  const won = S.coin ? coinDone() && S.coin.winner === side : !!t && t.a !== t.b && (t.a > t.b ? "a" : "b") === side;
  const lost = S.coin ? coinDone() && S.coin.winner !== side : !!t && t.a !== t.b && !won;
  // the stage's hit plays once per match; later state updates re-render the cards in their end position
  const hitKey = `${S.current.r}-${S.current.m}`, fresh = hitShown !== hitKey;
  const hit = stage && (won || lost) ? (won ? (fresh ? " win" : " win-done") : (fresh ? " lose" : " lose-done")) : "";
  // the cards fight: the leader grows and glows, the trailer shrinks, as the votes come in
  return h("div", { className: `card ${side}${mine ? " mine" : ""}${s > 0.5 ? " lead" : ""}${hit}`, style: `transform: scale(${(0.96 + 0.07 * s).toFixed(3)})` }, // the leader grows 3% at most: enough to read, never onto its neighbours
    e.img && h("img", { className: "cover", src: e.img, alt: "", referrerPolicy: "no-referrer" }),
    won && h("div", { className: "stamp", title: "Advances" }, "✓"), // the winner's beat, until the host moves on
    h("div", { className: "name" }, e.name),
    !stage && e.stats && h("div", { className: "stats" }, e.stats), // the stage is a scoreboard: title only
    !stage && e.case && h("p", { className: "case" }, e.case), // the stage keeps picture and name big; the case is on the voters' screens
    // the links and the vote sit at the foot of the card, level across both cards
    h("div", { className: "foot" },
      !stage && (e.yt || e.wiki) && h("div", { className: "row" },
        e.yt && S.isHost && h("button", { title: "Plays for everyone in the room", onclick: () => send("play", { yt: e.yt }) }, "▶ Play"),
        e.yt && h("button", { onclick: () => openYouTube(e.yt) }, "YouTube ↗"),
        e.wiki && h("button", { className: "wiki", onclick: () => window.open(wikiUrl(e.wiki), "_blank") }, "Wikipedia ↗")),
      !S.revealed && !stage && h("button", { className: mine ? "primary" : "", onclick: () => !mine && send("vote", { side }) }, mine ? "Your pick ✓" : "Vote")));
}

// the tie coin: the caller gets the two buttons, everyone else waits; then the flip plays once and the result holds
function coinView(mt) {
  const c = S.coin;
  if (c.pending) return c.mine
    ? h("div", { className: "coin-call" }, h("div", { className: "muted" }, `Tie. Call it for ${S.entries[mt[c.side]].name}:`),
        h("div", { className: "row centered" }, h("button", { className: "primary", onclick: () => send("call", { call: "heads" }) }, "Heads"), h("button", { className: "primary", onclick: () => send("call", { call: "tails" }) }, "Tails")))
    : h("div", { className: "coin-call muted" }, "Tie. A player is calling the coin…");
  const key = `${S.current.r}-${S.current.m}`, animate = coinFlipped !== key;
  if (animate) { coinFlipped = key; setTimeout(() => { coinLanded = key; render(); }, 2400); } // the cards react once it lands
  return h("div", { className: "coin-wrap" },
    // the coin itself spins on the stage only: one animation on the stream, not one per phone; the others get the line
    stage && h("div", { className: `coin ${animate ? "flip-" : "show-"}${c.result}` }, h("div", { className: "face heads" }, "H"), h("div", { className: "face tails" }, "T")),
    h("div", { className: "coin-text" }, coinDone() ? `${c.result[0].toUpperCase() + c.result.slice(1)}: ${S.entries[mt[c.winner]].name} advances` : `Called ${c.call}…`));
}

// the countdown the host starts: a bar draining left to right with the time on it, the same for everyone
let hitShown = null; // "r-m" of the match whose hit the stage has already played
let coinFlipped = null, coinLanded = null; // "r-m" of the coin already spun, and of the one that has landed
const coinDone = () => !!S.coin && coinLanded === `${S.current.r}-${S.current.m}`;
let clockTick = null;
function clock() {
  clearInterval(clockTick);
  if (!S.timer) return null;
  const ends = Date.now() + S.timer.left, total = S.timer.secs * 1000;
  const fill = h("div", { className: "fill" }), num = h("span", {}, "");
  const paint = () => {
    const left = Math.max(0, ends - Date.now()), secs = Math.ceil(left / 1000);
    fill.style.width = `${(100 * left) / total}%`;
    num.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    if (!left) clearInterval(clockTick);
  };
  clockTick = setInterval(paint, 200); paint();
  return h("div", { className: "clock" }, fill, num);
}

// the tug of war under the cards: each side's votes push the divide toward the other
function tug() {
  const t = S.tally, a = share("a");
  return h("div", { className: "tug" + (t.a + t.b ? "" : " empty") },
    h("div", { className: "n a" }, String(t.a)),
    h("div", { className: "bar" }, h("div", { className: "fa", style: `width:${(100 * a).toFixed(1)}%` }), h("div", { className: "fb" })),
    h("div", { className: "n b" }, String(t.b)));
}

function viewVoting() {
  const { r, m } = S.current;
  const mt = S.rounds[r][m];
  const t = S.revealed ? S.tally : null; // voting ended: the host advances the winner
  const tie = t && t.a === t.b;
  const leader = t && !tie ? (t.a > t.b ? "a" : "b") : null;
  const played = S.rounds.flat().filter((x) => x.tally).length, total = S.entries.length - 1;
  return [
    // no round label: the bar tells that story, and the bracket itself is a scroll away
    h("div", { className: "progress", title: `${roundName(S.rounds, r)} · match ${m + 1} of ${S.rounds[r].length} · ${played} of ${total} played` }, h("div", { style: `width:${(100 * played) / total}%` })),
    stage && S.nowPlaying && h("div", { className: "round" }, "♪ " + (S.entries.find((e) => e.yt === S.nowPlaying.yt)?.name || "playing")), // the stream sees what the room hears
    h("div", { className: "matchup" }, entryCard("a", mt.a), h("div", { className: "vs" }, "VS"), entryCard("b", mt.b)),
    tug(),
    t && tie && S.coin && coinView(mt),
    // under the score: the countdown everyone sees, then the host's controls. The host starts the countdown by
    // hand every match (clips run different lengths) and can cancel it; End voting works at any time
    h("div", { className: "timing" },
      clock(),
      S.isHost && !t && !S.timer && h("span", { className: "presets", title: "Start a countdown; voting ends when it runs out" }, "⏱", [15, 30, 60].map((s) => h("button", { className: "tiny", onclick: () => send("timer", { secs: s }) }, String(s)))),
      S.isHost && !t && S.timer && h("button", { className: "tiny", title: "Cancel the countdown", onclick: () => send("timer", { secs: 0 }) }, "✕"),
      S.isHost && S.nowPlaying && S.drives && h("button", { title: "Pause / resume for everyone", onclick: () => ytReady && (yt.getPlayerState() === 1 ? yt.pauseVideo() : yt.playVideo()) }, "⏯"),
      S.isHost && S.nowPlaying && h("button", { onclick: () => send("play", { yt: null }) }, "■ Stop"),
      S.isHost && !t && h("button", { className: "primary", onclick: () => send("reveal") }, "End voting")),
    S.isHost && t && h("div", { className: "row centered" },
      t && leader && h("button", { className: "primary", onclick: () => send("advance", { side: leader }) },
        `Advance ${S.entries[mt[leader]].name}`),
      t && tie && S.coin && coinDone() && h("button", { className: "primary", onclick: () => send("advance", { side: S.coin.winner }) },
        `Advance ${S.entries[mt[S.coin.winner]].name}`)),
  ];
}

function viewDone() {
  const champ = S.entries[S.rounds[S.rounds.length - 1][0].winner];
  const pic = S.pictureId && new URL(`pictures/${S.pictureId}.png`, location.href).href;
  return [
    h("div", { className: "champ" },
      h("div", { className: "muted" }, "CHAMPION"),
      champ.img && h("img", { className: "cover", src: champ.img, alt: "", referrerPolicy: "no-referrer" }),
      h("div", { className: "name" }, "🏆 " + champ.name)),
    pic && [
      h("a", { href: pic, target: "_blank" }, h("img", { className: "result", src: pic, alt: "the full bracket as a picture" })),
      !stage && h("div", { className: "row centered" }, copyButton("Copy picture link", pic)),
    ],
  ];
}

// the tree: every column is the same height and each match sits centred in an equal slot, so a
// match in round r lands exactly between the two it is fed by; the lines are drawn in CSS
function viewBracket() {
  const name = (i) => (i === null ? "—" : S.entries[i].name);
  const last = S.rounds.length - 1;
  return S.rounds.map((round, r) => h("div", { className: "col" + (r === 0 ? " first" : "") + (r === last ? " last" : "") },
    round.map((mt, m) => {
      const live = S.current && S.current.r === r && S.current.m === m;
      const cls = (i) => (mt.winner === null || i === null ? "" : i === mt.winner ? "w" : "l");
      const score = (s) => (mt.tally ? ` (${mt.tally[s]})` : "");
      return h("div", { className: "slot" }, r > 0 && h("div", { className: "rail" }),
        h("div", { className: "bm" + (live ? " live" : "") },
          h("div", { className: cls(mt.a), title: name(mt.a) }, name(mt.a) + score("a")),
          h("div", { className: cls(mt.b), title: name(mt.b) }, (r === 0 && mt.b === null ? "bye" : name(mt.b)) + score("b"))));
    })));
}

// one button instead of a URL box: copies, says so, goes back to its label
// a small figure for the people pill
const PERSON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="4.5" r="3" fill="currentColor"/><path d="M2 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" fill="currentColor"/></svg>';
const person = () => { const el = h("span", { className: "fig" }); el.innerHTML = PERSON; return el; }; // set after h(): fill() would wipe innerHTML
const copyButton = (label, text, title, className) => h("button", { title, className, onclick: async (e) => {
  try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied ✓"; setTimeout(() => (e.target.textContent = label), 1500); }
  catch { prompt("Copy this link:", text); }
} }, label);


// ribbons for the champion: a few seconds of paper falling past the page, then gone
function ribbons() {
  const c = h("canvas", { className: "ribbons" });
  document.body.append(c);
  const ctx = c.getContext("2d");
  let w, hgt;
  const size = () => { w = c.width = innerWidth; hgt = c.height = innerHeight; };
  size(); addEventListener("resize", size);
  const colors = ["#f0a63c", "#5aa7f0", "#6fd38a", "#eceef4", "#f06c9b"];
  const ps = Array.from({ length: 180 }, () => ({
    x: Math.random() * w, y: -20 - Math.random() * hgt * 0.8, vx: (Math.random() - 0.5) * 1.2, vy: 2 + Math.random() * 2.5,
    len: 12 + Math.random() * 16, wid: 5 + Math.random() * 4, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.2,
    col: colors[Math.floor(Math.random() * colors.length)], sway: Math.random() * Math.PI * 2,
  }));
  const t0 = performance.now();
  (function frame(t) {
    const life = (t - t0) / 1000;
    ctx.clearRect(0, 0, w, hgt);
    ctx.globalAlpha = Math.min(1, Math.max(0, 7 - life)); // fade out over the last second
    for (const p of ps) {
      p.x += p.vx + Math.sin(life * 3 + p.sway) * 0.8; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col;
      ctx.fillRect(-p.len / 2, -p.wid / 2, p.len, p.wid); ctx.restore();
    }
    if (life < 7) requestAnimationFrame(frame); else { c.remove(); removeEventListener("resize", size); }
  })(t0);
}

let lastPhase = null;
function render() {
  document.body.classList.add("playing");
  if (S.phase === "done" && lastPhase === "voting") ribbons(); // the moment the champion is decided, for everyone in the room
  lastPhase = S.phase;
  $("title").textContent = stage ? S.title : ""; // on the stage the name is the headline; in a game it sits in the toolbar's centre
  fill($("bar"), ...(stage ? [] : [
    // players see the title alone: the brand link in the header is their way out
    h("div", { className: "left" }, S.isHost && h("button", { onclick: () => go("") }, "← Brackets"),
      S.isHost && armed("Start over", "Click again: reshuffle and wipe this run", () => send("restart"))),
    h("div", { className: "ttl" }, S.title),
    h("div", { className: "right" },
      // who is here, as a figure and a number; then the join code itself, which copies the invite link when clicked
      S.isHost && h("span", { className: "chip people", title: `${S.here} in the room` }, person(), String(S.here) + (S.hostHere ? "" : " · host away")),
      S.isHost && copyButton(S.joinKey, new URL(`?join=${S.joinKey}`, location.href).href, "The join code: say it, or click to copy the invite link", "code"),
      S.isHost && h("button", { title: "Opens the stage in a new tab: the page to capture for a stream, with the match, the live vote and the join code", onclick: () => window.open(new URL(`?stage=${S.joinKey}`, location.href).href, "_blank") }, "Stage"))]));
  // the stage: the join code alone top-right, the head count big bottom-right, no bracket tree (it is a scoreboard)
  const corner = stage && h("div", { className: "joinbox" }, h("div", { className: "code" }, S.joinKey));
  const count = stage && h("div", { className: "count", title: `${S.here} in the room` }, person(), String(S.here));
  fill($("app"), corner, count, ...(S.phase === "voting" ? viewVoting() : viewDone()));
  fill($("bracket"), ...(stage ? [] : viewBracket()));
  if (stage && S.phase === "voting" && S.revealed && (S.tally.a !== S.tally.b || coinDone())) hitShown = `${S.current.r}-${S.current.m}`; // played now; hold it from here on
  renderPlayer();
}

export async function play(me, { bracketId, hostId, roomId, code, stage: asStage = false }) {
  stage = asStage;
  if (stage) document.body.classList.add("stage");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // keep the page's folder (e.g. /brackets) so this works behind a path-prefix proxy
  const base = location.pathname.replace(/\/[^/]*$/, "");
  const client = new Client(`${proto}://${location.host}${base}`);
  let attempt = 0;
  const join = async () => {
    fill($("app"), h("p", { className: "muted" }, attempt ? "Reconnecting…" : "connecting…"));
    // a room id dies with a server restart; the join code outlives it, so a reconnect looks the room up again
    const id = roomId && attempt ? (await api(`api/join/${code}`)).roomId : roomId;
    room = id ? await client.joinById(id, me) : await client.joinOrCreate("game", { ...me, bracketId, hostId });
    attempt = 0;
    room.onMessage("state", (s) => { S = { ...S, ...s }; render(); }); // entries arrive once, the rest every update
    // the socket dropped (a deploy, a locked phone, a wobble): come back on our own, the game is saved
    room.onLeave(() => retry());
  };
  const retry = () => {
    attempt++;
    if (attempt > 60) return fill($("app"), h("p", { className: "muted" }, "The host isn't in this game right now. Refresh to try again."));
    setTimeout(() => join().catch(retry), Math.min(5000, 800 * attempt));
  };
  await join(); // the first join's errors (a bad code, a closed game) surface as before
}
