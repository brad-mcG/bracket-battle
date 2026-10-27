// Bracket builder: one person sets the topic and entries, then saves. Nothing live here;
// playing happens later from the home page.
import { $, h, fill, api, go, openYouTube } from "./ui.js";
import { youtubeId } from "./bracket.js";

const MAX = 256;

export async function builder(me, id) {
  let title = "", entries = [], msg = "";
  if (id) {
    const b = await api(`api/brackets/${id}?me=${me.userId}`);
    if (!b.mine) { $("app").textContent = "Only the creator can edit this bracket."; return; }
    title = b.title;
    entries = b.entries.map((e) => ({ name: e.name, yt: e.yt ? `https://youtu.be/${e.yt}` : "", img: e.img || "", stats: e.stats || "", case: e.case || "", wiki: e.wiki || "" }));
  }

  // "Name", "link", or "Name | link"; link-only lines get the video's title
  async function parse(line) {
    const [a, b] = line.split("|").map((s) => s.trim());
    const link = b || (youtubeId(a) ? a : "");
    let name = b ? a : (youtubeId(a) ? "" : a);
    if (!name && link) name = (await api(`api/title/${youtubeId(link)}`)).title || "";
    return name ? { name, yt: link } : null;
  }

  async function addLines(text) {
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, MAX - entries.length);
    msg = lines.length ? "Looking up titles…" : "";
    render();
    const parsed = await Promise.all(lines.map(parse));
    const bad = parsed.filter((p) => !p).length;
    entries.push(...parsed.filter(Boolean));
    msg = bad ? `${bad} line(s) skipped: no name, and the link's title couldn't be found.` : "";
    render();
  }

  async function save() {
    try {
      await api("api/brackets", { id, title, entries, userId: me.userId, name: me.name });
      go("");
    } catch (e) { msg = e.message; render(); }
  }

  function render() {
    const size = entries.length < 2 ? 0 : 2 ** Math.ceil(Math.log2(entries.length));
    const nameIn = h("input", { id: "addName", placeholder: "Name (blank = use the YouTube title)" });
    const linkIn = h("input", { id: "addLink", placeholder: "YouTube link (optional)" });
    const addOne = () => {
      if (!nameIn.value.trim() && !linkIn.value.trim()) return;
      addLines(nameIn.value.trim() && linkIn.value.trim() ? `${nameIn.value} | ${linkIn.value}` : nameIn.value || linkIn.value);
    };
    [nameIn, linkIn].forEach((i) => i.addEventListener("keydown", (e) => e.key === "Enter" && addOne()));
    const bulk = h("textarea", { id: "bulk", rows: 5,
      placeholder: "Paste a list, one per line:\nHey Jude\nhttps://youtu.be/QDYfEBY9NM4\nLet It Be | https://www.youtube.com/watch?v=..." });

    $("title").textContent = id ? "Edit bracket" : "New bracket";
    fill($("app"),
      h("div", { className: "row" }, h("input", {
        id: "topic", placeholder: "Topic, e.g. Best Beatles song", value: title, maxLength: 80,
        oninput: (e) => (title = e.target.value),
      })),
      h("h3", {}, `Entries ${entries.length} / ${MAX}`,
        size ? h("span", { className: "muted" }, `  ·  ${size}-slot bracket` + (size > entries.length ? `, ${size - entries.length} bye${size - entries.length > 1 ? "s" : ""}` : "")) : ""),
      h("div", { className: "row" }, nameIn, linkIn, h("button", { onclick: addOne, disabled: entries.length >= MAX }, "Add")),
      h("div", { className: "row" }, bulk,
        h("button", { onclick: () => addLines(bulk.value), disabled: entries.length >= MAX }, "Add all")),
      msg && h("p", { className: "muted" }, msg),
      h("ol", { className: "edit-list" }, entries.map((e, i) => h("li", { className: "entry" },
        h("span", { className: "n" }, `${i + 1}.`),
        e.img ? h("img", { className: "thumb", src: e.img, alt: "", referrerPolicy: "no-referrer" }) : h("span", { className: "thumb" }),
        h("input", { value: e.name, maxLength: 100, oninput: (ev) => (e.name = ev.target.value) }),
        h("input", { value: e.yt, placeholder: "YouTube link", oninput: (ev) => (e.yt = ev.target.value) }),
        h("input", { value: e.img || "", placeholder: "Picture URL", onchange: (ev) => { e.img = ev.target.value.trim(); render(); } }),
        youtubeId(e.yt) && h("button", { title: "preview", onclick: () => openYouTube(youtubeId(e.yt)) }, "↗"),
        h("button", { title: "remove", onclick: () => { entries.splice(i, 1); render(); } }, "×"),
        h("input", { className: "stats", value: e.stats || "", maxLength: 140, placeholder: "Stats line, e.g. 1982 Heisman · 3× All-American", oninput: (ev) => (e.stats = ev.target.value) }),
        h("input", { className: "stats", value: e.wiki || "", maxLength: 200, placeholder: "Wikipedia article title", oninput: (ev) => (e.wiki = ev.target.value) }),
        h("textarea", { value: e.case || "", maxLength: 700, rows: 2, placeholder: "The case for it winning this bracket (2-4 sentences)", oninput: (ev) => (e.case = ev.target.value) })))),
      h("div", { className: "row" },
        h("button", { className: "primary", onclick: save }, "Save bracket"),
        h("button", { onclick: () => go("") }, "Cancel")),
    );
  }
  render();
}
