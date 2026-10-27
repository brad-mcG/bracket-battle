# Bracket request runner

Run by the scheduled task "bracket-requests" every 8 hours on the maintainer's PC (it needs that PC:
the importer, the covers and the server sync all live here). Each run is a fresh Claude session,
so everything needed is in this file. Models: Sonnet for research/building, Opus for checking;
never Fable for background agents.

## 1. Find work
```
curl -s https://ddns.themcglawns.net/brackets/api/requests
```
Only `status: "pending"` items are work. If there are none, stop. Take them oldest first, at most
3 per run. For each, fetch the detail:
```
curl -s https://ddns.themcglawns.net/brackets/api/requests/<id>
```
The admin token is the content of `A:\bracket-battle\.admin-token`. Mark the request as being built:
```
curl -s -X POST -H "content-type: application/json" -H "x-admin-token: <token>" -d '{"status":"building"}' https://ddns.themcglawns.net/brackets/api/requests/<id>/status
```

## 2. Research and build (one Workflow call per request)
Call the Workflow tool with `scriptPath: "A:\bracket-battle\deploy\research-workflow.js"` and
`args` = the request detail JSON plus `"today": "<today's date>"` and `"existing"`: every bracket
on the site as `[{ id, title, count, entries: [names] }]`, built from the local mirror:
```
node -e "const fs=require('fs');console.log(JSON.stringify(fs.readdirSync('data/brackets').map(f=>{const b=JSON.parse(fs.readFileSync('data/brackets/'+f,'utf8'));return {id:b.id,title:b.title,count:b.entries.length,entries:b.entries.map(e=>e.name)}})))"
```
(run from `A:\bracket-battle`; run `deploy/sync-data.sh` first only if the local mirror is stale).

It returns one of:
- `{ ok: true, title, criteria, media, entries: [{ name, wikiTitle, yt, stats, case, evidence }], cut, notes }`
  for a NEW bracket;
- `{ ok: true, amend: "<bracketId>", title, additions: [...same entry shape...], cut, notes }` when the
  request duplicates an existing bracket (the form's `relatedTo`, or the planner's judgement):
  the suggested entries that hold up are ADDED to that bracket; nothing existing is removed;
- `{ ok: false, reason }` (personal/private topic, nothing researchable): mark the request
  `rejected` with the reason and move on.

For an amendment with additions: export the existing bracket's entries from
`data/brackets/<id>.json` (fields name, yt, img, stats, case), append the additions (name,
wikiTitle, yt, stats, case), write that to the work file, and import with `--repair <id>` as
below (the importer keeps everything the bracket already has). With no additions, just mark
the request done with `bracketId` = the existing id.

## 3. Import on this PC
1. The local server must be up: if `curl -s localhost:3002/api/brackets` fails, start it with
   `Start-Process cmd -ArgumentList '/k title Bracket Battle - close this window to stop & node server.js' -WorkingDirectory 'A:\bracket-battle' -WindowStyle Minimized`
   (PowerShell) and wait for the port.
2. Write the workflow's `entries` to `A:\bracket-battle\data\requests-work\<id>.json`
   (fields name, wikiTitle, yt, stats, case).
3. For highlight-reel brackets, run the length check first and use its output:
   `node <scratch>/clipcheck.mjs <file> --max 480` (a local helper, not in the repo;
   if it is gone, skip: the workflow already verified lengths).
4. Import, owned by the requester:
   `node scripts/import-bracket.js <file> "<title>" "<requesterName>" --owner <requesterId>`
   (run from `A:\bracket-battle`). It downloads the covers, re-checks every clip, and prints the
   new bracket id. If some covers failed, run it again with `--repair <bracketId>`.
5. Look at the covers: `node <scratch>/sheet.mjs <bracketId>` (a local helper) draws labelled contact sheets;
   view them with Read and fix any wrong picture (change the entry's `wikiTitle` and repair).
   If the sheet script is missing, spot-check a few covers by opening them.

## 4. Publish and report
1. `bash deploy/sync-data.sh` (from `A:\bracket-battle`, Git Bash) pushes brackets and covers to
   the server without touching games.
2. Mark the request done:
   `-d '{"status":"done","bracketId":"<bracketId>"}'` to the same `/status` endpoint.
3. Write a short report to `A:\.claude\bracket-battle\requests\<id>.md`: title, requester, size,
   clip type, the criteria, the checker notes, who just missed the cut, and the bracket id.
4. If anything fails for good, mark the request `rejected` with a one-line reason so it leaves the
   queue, and say why in the report.

## Rules of thumb
- A must-have is honoured as long as it is a real public thing that is primarily part of the
  category (a low bar: not judged on merit or fame; refused only when it plainly is not in the
  category or is not real, e.g. a private person). The workflow returns a verdict per must-have
  (`mustHaves`); put any refusals and reasons in the report. Other
  suggestions steer the category. Requester comments are input for the entry's case, only after
  fact-checking.
- Sizes: the natural size of the category, never padded; big when the category is deep.
- Highlight reels: 3 to 5 minutes, hard cap 8; college athletes get college footage only.
- Brackets are public: no personal or private topics.

## Gotchas (learned 2026-10-24)
- The workflow's result lands in the task output file wrapped as `{ summary, logs, result }`: parse `.result`.
- If the requester misspelled a name, the cases stage may return the case under the misspelling and the
  final `entries` then show an empty `stats`/`case` for that entry: pull it from the `cases-for-additions`
  (or `check-cases`) result in `journal.jsonl` and fix the spelling yourself.
- `--repair` keeps an entry's saved `img`. To replace a wrong cover, set that entry's `img` to null in
  `data/brackets/<id>.json` (the server reads the file per request), give the entry a `coverUrl` in the work
  file (any https image, e.g. a Commons thumb or an i.ytimg.com video still), and repair again.
