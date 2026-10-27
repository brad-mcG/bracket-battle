// Entry point + home page. Routes by query string:
//   (none)                  landing page
//   ?browse                 all brackets
//   ?pick=<id>              host that bracket as yourself (lands on ?play=...)
//   ?new                    request a bracket (the research runner builds it)
//   ?edit=<id>              owner-only repairs to a saved bracket
//   ?play=<id>&host=<user>  a live game (that host's saved run of that bracket)
//   ?join                   the join box (the nav's Join opens it in place)
//   ?join=<code>            the invite link: joins the open game with that four-letter code
//   ?stage=<key>            the read-only stage view a streamer captures (same key as the invite link)
import { $, h, fill, api, go, identify, joinBox } from "./ui.js";
import { builder } from "./builder.js";
import { requestForm } from "./request.js";
import { landing } from "./landing.js";
import { play } from "./play.js";
import { SHELVES, shelfOf, heroSlides, hero, shelf, tile } from "./shelf.js";

async function home(me) {
  const brackets = await api(`api/brackets?me=${me.userId}`);
  const open = (b) => go(`play=${b.id}&host=${me.userId}`);
  const edit = (b) => go(`edit=${b.id}`);
  const t = (b) => tile(b, open, b.mine ? edit : null);
  const started = brackets.filter((b) => b.run && b.run.phase !== "done").sort((x, y) => (y.run.updatedAt || 0) - (x.run.updatedAt || 0));
  const slides = heroSlides(brackets);

  $("title").textContent = "";
  document.body.classList.add("browse");
  fill($("app"),
    brackets.length === 0 && h("p", { className: "muted center" }, "None yet."),
    slides.length > 0 && hero(slides, open),
    shelf("Continue", started, t),
    SHELVES.map(([name]) => shelf(name, brackets.filter((b) => shelfOf(b) === name), t)),
    shelf("More", brackets.filter((b) => shelfOf(b) === "More"), t),
    h("div", { className: "row centered" }, h("button", { onclick: () => go("new") }, "+ Request a bracket")),
  );
}

async function main() {
  try {
    const q = new URLSearchParams(location.search);
    document.querySelectorAll("nav.top a").forEach((a) => a.classList.toggle("current", q.has(a.getAttribute("href").slice(1))));
    const joinLink = document.querySelector('nav.top a[href="?join"]');
    if (joinLink) joinLink.onclick = (e) => { e.preventDefault(); joinBox(); }; // a box over the page, not a page
    if (![...q.keys()].length) return landing();
    if (q.has("join") && !q.get("join")) { await landing(); return joinBox(); }
    if (q.has("stage")) { const code = q.get("stage").toUpperCase(); return play({ userId: "stage", name: "Stage", stage: true }, { code, roomId: (await api(`api/join/${encodeURIComponent(code)}`)).roomId, stage: true }); } // a capture: no name prompt
    const me = await identify();
    if (q.has("pick")) return go(`play=${q.get("pick")}&host=${me.userId}`);
    if (q.has("play")) await play(me, { bracketId: q.get("play"), hostId: q.get("host") });
    else if (q.has("join")) { const code = q.get("join").toUpperCase(); await play(me, { code, roomId: (await api(`api/join/${encodeURIComponent(code)}`)).roomId }); } // the invite link or a typed code
    else if (q.has("new")) requestForm(me);
    else if (q.has("edit")) await builder(me, q.get("edit")); // owner-only repairs, not a way to make brackets
    else await home(me);
  } catch (e) {
    fill($("app"), h("p", {}, "Error: " + (e && e.message ? e.message : e)),
      h("button", { onclick: () => go("") }, "← Back"));
    console.error(e);
  }
}
main();
