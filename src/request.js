// "Request a bracket": collects what the bracket is about and what the requester has in
// mind. The research runner builds the real thing from this (field, pictures, clips, cases).
// A request that matches an existing bracket is sent as suggestions for that bracket instead.
import { $, h, fill, api, go } from "./ui.js";

const SIZES = [["auto", "Auto", "let the research decide"], ["small", "8–16"], ["medium", "~32"], ["big", "~64"], ["max", "Up to 256", "as big as the category can go"]];
const MEDIA = [["auto", "Auto", "let the research decide"], ["none", "None"], ["songs", "Songs"], ["trailers", "Trailers"], ["highlights", "Highlights", "career highlight reels"],
  ["openings", "Openings", "title sequences"], ["moments", "Moments", "the play or video itself"], ["scenes", "Scenes", "best-moments compilations"], ["commercials", "Commercials"], ["gameplay", "Gameplay"], ["standup", "Stand-up", "one bit"]];

// "Best Anime Series" ~ "best anime series!" ~ "Anime Series": strip filler words and punctuation
const norm = (s) => s.toLowerCase().replace(/\b(the|best|greatest|top|of all time|all time|ever)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

export async function requestForm(me) {
  const existing = await api("api/brackets");
  const rows = [{}];
  const form = { title: "", size: "auto", media: "auto", notes: "" };
  let msg = "", sent = null;

  const match = () => { const t = norm(form.title); return t.length > 2 ? existing.find((b) => norm(b.title) === t) : null; };

  async function submit() {
    const entries = rows.map((r) => ({ name: (r.name || "").trim(), must: !!r.must, comment: (r.comment || "").trim() })).filter((r) => r.name);
    const dup = match();
    try {
      await api("api/requests", { ...form, entries, relatedTo: dup ? dup.id : undefined, userId: me.userId, name: me.name });
      sent = dup ? `Your suggestions for "${dup.title}" go to the research; the ones that hold up get added, usually within a day.`
        : `"${form.title.trim()}" will show up in Brackets once it's built, usually within a day.`;
      render();
    } catch (e) { msg = e.message; render(); }
  }

  // a segmented control: one pill lit
  const seg = (name, opts) => {
    const btns = opts.map(([v, label, tip]) => h("button", { className: form[name] === v ? "on" : "", title: tip || "", onclick: () => { form[name] = v; btns.forEach((b, i) => b.classList.toggle("on", opts[i][0] === v)); } }, label));
    return h("div", { className: "seg" }, btns);
  };

  // one entry: name, a must-have star, a comment. The list grows itself: typing in the last
  // row adds a blank one under it, so there is always an empty row to fill in.
  let reqs;
  const rowEl = (r) => {
    const el = h("div", { className: "req" },
      h("div", { className: "row" },
        h("input", { placeholder: "Entry name", maxLength: 100, value: r.name || "", oninput: (e) => {
          r.name = e.target.value;
          if (r === rows[rows.length - 1] && r.name.trim() && rows.length < 40) { const n = {}; rows.push(n); reqs.append(rowEl(n)); }
        } }),
        h("button", { className: "must" + (r.must ? " on" : ""), title: "Must be in the bracket", onclick: (e) => { r.must = !r.must; e.target.classList.toggle("on", r.must); e.target.textContent = (r.must ? "★" : "☆") + " must-have"; } }, (r.must ? "★" : "☆") + " must-have"),
        h("button", { className: "rm", title: "Remove", onclick: () => { rows.splice(rows.indexOf(r), 1); el.remove(); } }, "×")),
      h("textarea", { rows: 2, maxLength: 600, placeholder: "Why it belongs, or its case for winning. A YouTube link is fine here.", value: r.comment || "", oninput: (e) => (r.comment = e.target.value) }));
    return el;
  };

  function render() {
    $("title").textContent = "Request a bracket";
    if (sent) {
      return fill($("app"), h("div", { className: "namebox" }, h("h2", {}, "Request sent"), h("p", { className: "muted" }, sent),
        h("div", { className: "row" }, h("button", { className: "primary", onclick: () => go("browse") }, "Back to brackets"))));
    }
    reqs = h("div", { className: "reqs" }, rows.map(rowEl));
    fill($("app"), h("div", { className: "reqform" },
      h("input", { className: "bigin", placeholder: "Best 90s R&B Song, Greatest NBA Point Guard…", maxLength: 80, autofocus: true, value: form.title, oninput: (e) => { form.title = e.target.value; renderDup(); } }),
      h("p", { id: "dup", className: "muted small" }),
      h("div", { className: "row opt" }, h("span", { className: "lbl" }, "Size"), seg("size", SIZES)),
      h("div", { className: "row opt" }, h("span", { className: "lbl" }, "Clips"), seg("media", MEDIA)),
      h("div", { className: "sechead muted left" }, "Entries you want in"),
      reqs,
      h("textarea", { className: "notes", rows: 2, maxLength: 600, placeholder: "Notes for the research, e.g. US releases only, or count remakes separately", value: form.notes, oninput: (e) => (form.notes = e.target.value) }),
      msg && h("p", { className: "muted" }, msg),
      h("div", { className: "row" }, h("button", { className: "primary big", id: "sendBtn", onclick: submit }, "Send request")),
    ));
    renderDup();
  }

  // the "already exists" hint, updated as the title is typed without re-rendering the form
  function renderDup() {
    const dup = match();
    fill($("dup"), dup && ["Already have ", h("b", {}, dup.title), " · ", h("a", { href: `?pick=${dup.id}` }, "host it"), " · or send this as suggestions for it"]);
    const btn = $("sendBtn");
    if (btn) btn.textContent = dup ? "Send suggestions" : "Send request";
  }
  render();
}
