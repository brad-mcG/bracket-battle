// Shared bits for every page: DOM builder, localStorage, and who you are.
export const $ = (id) => document.getElementById(id);

// strings go through textContent / properties, so entry names can't inject HTML
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el[k] = v;
  }
  return fill(el, ...kids);
}

// replaceChildren that skips the false/null/"" left by `cond && h(...)`, at any nesting depth
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ""));
  return el;
}

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

export const go = (query) => { location.search = query; };

export const openYouTube = (yt) => window.open(`https://www.youtube.com/watch?v=${yt}`, "_blank");

// crypto.randomUUID only exists on https/localhost; getRandomValues works on plain http too
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// No accounts and no names: a random id kept in this browser is what makes you "the host" of
// your saved runs and what makes a vote yours. A one-time "?claim=<id>" link adopts an existing
// id, so a bracket made for someone (or their id from another device) becomes theirs.
export async function identify() {
  const q = new URLSearchParams(location.search);
  const claim = q.get("claim");
  if (/^[\w-]{1,64}$/.test(claim || "")) {
    const cur = store.get("userId");
    // a stray link must not silently replace who you already are here
    if (!cur || cur === claim || confirm("Switch this browser to the identity in this link? Your current one is kept as a backup.")) {
      if (cur && cur !== claim) store.set("prevUserId", cur);
      store.set("userId", claim);
      if (q.get("name")) store.set("name", q.get("name").slice(0, 40));
    }
    q.delete("claim"); q.delete("name"); // don't leave the id sitting in the address bar
    history.replaceState(null, "", location.pathname + (q.size ? "?" + q : ""));
  }
  let userId = store.get("userId");
  if (!userId) store.set("userId", (userId = randomId()));
  return { userId, name: store.get("name") || "" };
}

// the join box: four letters in, into the room. Opens over whatever page is showing
export function joinBox() {
  const input = h("input", { className: "code", maxLength: 4, placeholder: "CODE", autocomplete: "off", autocapitalize: "characters", spellcheck: false,
    oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ""); } });
  const err = h("div", { className: "muted" }, "");
  const enter = async () => {
    const code = input.value;
    if (code.length < 4) return input.focus();
    try { await api(`api/join/${code}`); go(`join=${code}`); }
    catch (e) { err.textContent = e.message || "No game with that code right now."; input.select(); }
  };
  const modal = h("div", { className: "modal", onclick: (e) => { if (e.target === modal) modal.remove(); } },
    h("div", { className: "namebox" }, h("h2", {}, "Join a game"), h("div", { className: "row" }, input, h("button", { className: "primary", onclick: enter }, "Join")), err));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); if (e.key === "Escape") modal.remove(); });
  document.body.append(modal);
  input.focus();
}

export async function api(path, body) {
  const r = await fetch(path, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
