// Front page: the pitch, then the same featured row the browse page leads with. No name
// prompt here; that happens when someone clicks into a bracket or the request form.
import { $, h, fill, api, go, joinBox } from "./ui.js";
import { heroSlides, hero } from "./shelf.js";

export async function landing() {
  document.body.classList.add("landing");
  $("title").textContent = "Bracket Battle";
  const brackets = await api("api/brackets");
  // the pitch sits over the top of the browse page's carousel, which fills the screen here
  const pitch = h("div", { className: "pitch" },
    h("h2", {}, "Settle it with a bracket."),
    h("div", { className: "row centered" },
      h("button", { className: "primary big", onclick: () => go("browse") }, "Browse brackets"),
      h("button", { className: "big", onclick: joinBox }, "Join a game"),
      h("button", { className: "big", onclick: () => go("new") }, "Request a bracket")));
  fill($("app"), hero(heroSlides(brackets), (b) => go(`pick=${b.id}`), { kickers: false, overlay: pitch }));
}
