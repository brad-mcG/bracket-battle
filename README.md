# Bracket Battle

Live for my friend group (link on request)

A web app for settling "best Beatles song" with friends, one 1v1 vote at a time, while everyone
sits in a Discord voice call or watches a stream. Existing bracket sites are built for one person
filling in a bracket alone; this one is played together, live.

The part that matters for streamers: the host presses play on a YouTube clip and it plays in every
viewer's own browser, under the host's control. The stage page captured by OBS shows the match, the
live vote, the join code and the head count, never the video, so the stream itself carries none of
the music.

Stack: Node 24, Express 4, Colyseus 0.17 (rooms over WebSockets), a plain DOM client bundled with
esbuild, JSON files on disk, @napi-rs/canvas for the result pictures. One process, one port, no
accounts and no database.

## How it works
- **Request a bracket** (`+ Request a bracket`): name the category, optionally a size and clip
  type, entries you have in mind (tick must-have for guaranteed ones), and a comment per entry
  with your reasoning or a YouTube link. The request shows under **Being built** until the
  research runner (below) has built it. There is no manual builder on purpose: every bracket is
  researched the same way. Owners get an **Edit** screen for repairs only.
- **Host it** from the home page. The seeding is shuffled when you start. Every open game has a
  four-letter join code: friends type it under **Join** in the nav, or follow the invite link,
  which carries the same code. There is no public list of open games, and nobody is asked for a name.
- **Stream it**: the host's **Stage** button opens a read-only page for an OBS browser source:
  title-only cards, the live vote bar, the countdown, the join code top right and the head count
  bottom right. When voting ends the winner winds up, knocks the loser off screen and slides to
  the centre. No video and no buttons. Clips play on the host's and the viewers' own devices, each listener at their own volume; the
  host keeps the playing window out of the capture. Nobody ever sees who voted for what, only the
  totals. The host can start a 15, 30 or 60 second countdown once a clip has had its time; it
  ends voting by itself.
- **Each matchup** shows both entries' pictures, a stats line and the case for each, and the
  host can play either clip for everyone. People vote, votes stay hidden; the host clicks
  **Reveal**, then **Advance**s the winner. A tie goes to a coin: one random voter calls heads or
  tails for their side, the server flips, the coin spins on the stage and every screen gets the
  result (the server calls heads for a caller who walks away after 20 s).
- **When it's over** the champion screen shows the whole bracket as one picture, with a link to
  paste in Discord. Pictures are drawn on the server on first request and kept (newest 500).
  **Start over** retires the old picture and reshuffles.
- **Stop any time.** Every run is saved per bracket and per host; hosting the same bracket again
  resumes it. Someone else hosting the same bracket gets their own run.

Being "the host" is tied to a random ID saved in your browser. To carry it to another device,
open `?claim=<your id>` there once. Accounts are the step after that.

## The research runner
Requests are built by a Claude Code scheduled task on the maintainer's PC (`bracket-requests`,
every 8 hours). It follows `deploy/REQUEST-RUNNER.md`: fetch pending requests, run
`deploy/research-workflow.js` (plan the criteria and size, build and check the field with
Wikipedia pictures and verified clips, write and fact-check a stats line and case per entry),
import with `scripts/import-bracket.js`, eyeball the covers, `deploy/sync-data.sh` to publish,
then mark the request done with the admin token (`.admin-token` locally, `ADMIN_TOKEN` in the
service's environment on the server).

Importer notes: Wikipedia originals refuse scripts, so it uses the API thumbnail (and the page
summary thumbnail for small originals), paces requests at ~2/s, and shrinks covers to 800px.
Wikimedia rate-limits by User-Agent: without a contact URL you get 10 requests a minute, with one
(`BracketBattle/0.1 (https://github.com/brad-mcG/bracket-battle)`) 200, so every Wikipedia-facing
script carries that User-Agent and runs at most three requests at a time.

## Run locally
Double-click `start.cmd`. It installs and builds on first run, starts the server and opens
http://localhost:3002. Close its window to stop it. By hand:
```
npm install
npm run build
npm start                # 0.0.0.0:3002
npm test                 # bracket logic self-check
node test-room.js        # API + 3-player game, reconnect, countdown, tie coin; runs its own server on :3003
```
No brackets ship with the repo (`data/` is not committed). Make one with `scripts/import-bracket.js`
(usage in its header) or by posting to `/api/brackets` the way `test-room.js` does.

## Hosting
It runs as an unprivileged systemd service inside an Ubuntu LXC container, behind Caddy, which
serves it under `/brackets/` and fetches and renews the HTTPS certificate. The app listens only on
`127.0.0.1:3002` inside the container and can write only its `data/` folder
(`deploy/bracket-battle.service`). The container's firewall lets in only 80/443 and lets out only
web, DNS and NTP, never the home LAN (`deploy/120.fw`).

- One-time container setup (Node, Caddy, service user): `deploy/setup-ct.sh`.
- Site config: `deploy/Caddyfile`.
- Ship code changes from a PC (Git Bash): `deploy/push.sh`. It reads the Proxmox host and
  container id from `deploy/local.sh`, which is not committed. The server keeps its own brackets,
  games and covers; `deploy/push.sh --with-data` seeds them once and refuses if the server already
  has brackets. `deploy/sync-data.sh` pushes brackets and covers alone.
- Logs: `journalctl -u bracket-battle -f` (or `-u caddy`) in the container.

Use one address everywhere: the browser remembers who you are per address, so the LAN address
and the public name count as two different people.

### Limits and hardening (from the pre-launch security review)
- One bad message can't take the server down: the room catches handler errors, and Colyseus
  drops a player who sends more than 20 messages a second or an unknown message type.
- Creator and host IDs never leave the server; the API returns a `mine` flag, a join code
  resolves to a room ID, and vote ownership is never sent to other clients.
- Growth caps: 60 writes a minute per IP address, 2000 brackets and 5000 saved games in total
  (`MAX_BRACKETS` / `MAX_GAMES` in `src/store.js`). Per-user quotas belong with accounts.
- Entry pictures must be `https://` links to a named host, and are fetched with no referrer.
  When the server draws a result picture it fetches those links itself, so it refuses private
  or LAN addresses, follows no redirects, stops at 2 MB, and reads the image size from the
  header to reject anything over 4 megapixels before decoding. Covers are shrunk to icons as
  they load, four at a time, so a 128-entry picture never holds 128 full-size images.
- Picture requests count toward the per-IP limit, at most 4 renders queue at once, and
  drawing is one at a time.
- Caddy caps request bodies at 256 KB and keeps its admin API on a private socket; the app
  service is capped at 640 MB of memory and is restarted if it dies.
- Container firewall (`deploy/120.fw`): in, only 80/443; out, only web, DNS and NTP, and
  never the home LAN. IPv6 is off in the container.

There is no login, so anyone with the address can request brackets and join games. Only a run's
own host can run it, and only a bracket's creator can edit it. That's fine for a friend group;
accounts come before anything bigger.

## License
MIT.
