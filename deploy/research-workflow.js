export const meta = {
  name: 'bracket-request-research',
  description: 'Build one requested bracket end to end: scoring rule and field, Wikipedia pictures, verified clips, and a fact-checked stats line + case per entry',
  phases: [
    { title: 'Plan', detail: 'criteria, size and clip type from the request (opus)' },
    { title: 'Build', detail: 'ranked field with verified titles and clips (sonnet), then checker (opus)' },
    { title: 'Cases', detail: 'stats line + case per entry (sonnet), fact-checked (opus)' },
  ],
}
// args = the request as returned by GET /api/requests/<id>, plus:
//   today: "<date>", existing: [{ id, title, count, entries: [names] }]  (every bracket on the site)
// { id, title, size, media, entries: [{ name, must, comment, yt }], notes, relatedTo, requesterName }
// A request that duplicates an existing bracket (relatedTo, or the planner's own judgement)
// returns { ok: true, amend: <bracketId>, additions: [...] } instead of a whole new bracket.
const R = args
const TODAY = R.today || 'today'
const EXISTING = R.existing || []
const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const CONTEXT = `
CONTEXT: "Bracket Battle" is a web app where groups vote 1v1 through a bracket to crown a champion. Brackets are built by research from a short request, not by hand. Each entry shows a picture (from its English Wikipedia article), a one-line stats line, a 2-4 sentence case for winning, and for media brackets a YouTube clip the host plays for everyone. Brackets serve niche audiences too, but they are public, so they must be about things with real public records (Wikipedia articles), never private or personal. Today is ${TODAY}; use web search for anything recent.

THE REQUEST (JSON): ${JSON.stringify({ title: R.title, size: R.size, media: R.media, notes: R.notes, requester: R.requesterName, entries: R.entries })}
How to read it: "must": true means the requester wants that entry guaranteed a place, and it gets one. The only bar is a low one: the entry has to be a real public thing (an English Wikipedia article, or at least a clear public record) that is primarily part of this category (a UFC fighter bracket takes anyone who fought in the UFC, famous or not; somebody's grandma, a private person, a joke, or a thing from a different category is refused, with the reason recorded). Do not judge must-haves on merit, fame or ranking; when in doubt, accept. Other listed entries are hints about what the requester means by the category. "comment" is the requester's own reasoning for that entry; a "yt" in it is their suggested clip. Comments are INPUT, not truth: every claim in them must be fact-checked before it is used.
SIZE: "auto" = the natural size of the category (round to 8/16/32/64/128 only when within about 10%, never padded); "small" = 8-16, "medium" = about 32, "big" = about 64, "max" = as many as the category genuinely supports, up to 256; each still capped by how many real contenders exist.
CLIPS: "auto" = decide from the category with this table; otherwise as requested.
  songs/artists/bands/albums -> songs (the song; signature song for an artist or album)
  films/franchises/directors/actors -> trailers (signature film's trailer for a person), under 3 min
  TV shows/cartoons/anime -> openings (title sequence; trailer if no memorable opening), under 2 min
  characters (film/TV/game/comic) -> scenes (best-moments compilation), 1-4 min
  athletes/wrestlers/esports players/teams/seasons/musicians-as-performers (guitarists, drummers, bassists) -> highlights, 3-5 min, hard cap 8
  single plays/moments/viral videos/memes/commercials/music videos -> moments (the thing itself), under 2 min preferred
  video games/game series -> trailers (gameplay trailer if the cinematic shows no play); bosses/levels -> gameplay, 2-5 min
  comedians -> standup (a bit), 3-6 min; YouTubers/streamers/podcasts -> scenes (best moments), 3-5 min
  consumer brands (fast food, candy, cereal, sodas, cars, toys, consoles) -> commercials (iconic ad), under 2 min, optional
  dishes/drinks/places/breeds/objects/books/art -> none`

const WIKI = `
WIKIPEDIA CHECK (curl in Bash, batches of up to 50 titles joined with "|", URL-encoded, with a User-Agent):
  curl -s -A "BracketBattle/0.1 (https://github.com/brad-mcG/bracket-battle)" "https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|pageprops&piprop=original&pilicense=any&ppprop=disambiguation&redirects=1&format=json&titles=<T1>|<T2>"
Use the resolved final title; "missing" = no such article; pageprops.disambiguation = use the specific article; hasImage = "original" present. Prefer the article whose image IS the thing (poster, cover, logo, the person). On HTTP 429 wait and retry. Never guess titles.`
const CLIPS = `
CLIP RULES: one YouTube video per entry of the bracket's clip type. Highlight reels (people, athletes, performers): career highlights/best moments, 3-5 minutes preferred, HARD CAP 8 minutes (480 s), minimum 2 minutes; for college athletes college footage only. Moments: the play/video itself, as short as it is. Scenes: a compilation, 1-4 minutes. Songs: the official audio/video. Trailers: official trailer. Openings: the show's opening. Commercials: the iconic ad. Gameplay: the fight/level, 2-5 minutes. Stand-up: one bit, 3-6 minutes. Official channels preferred; good fan uploads acceptable when nothing official fits. A requester's suggested clip is tried first and kept if it passes.
VERIFY EVERY ID:
  embeddable + title + channel:  curl -s -w "\\n%{http_code}" "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=<ID>"   (must be 200)
  length (highlights, scenes, gameplay, standup; moments too): curl -s -X POST -H "content-type: application/json" "https://www.youtube.com/youtubei/v1/player?prettyPrint=false" -d '{"context":{"client":{"clientName":"WEB","clientVersion":"2.20240101.00.00"}},"videoId":"<ID>"}' | grep -o '"lengthSeconds":"[0-9]*"' | head -1   (reject > 480; never scrape the watch page, busy IPs get redirected to a Google "sorry" page)
Candidates: web search, or curl -s -A "Mozilla/5.0" "https://www.youtube.com/results?search_query=<q>" | grep -o '"videoId":"[A-Za-z0-9_-]\\{11\\}"\\|"simpleText":"[0-9]*:[0-9][0-9]"' | head -40
Only ids you verified may be returned; leave yt empty rather than guess.`

const PLAN = { type: 'object', properties: {
  title: { type: 'string', description: 'Clean bracket title, e.g. "Best 90s R&B Song". Never "of All Time" (every bracket is all-time unless scoped); short common names (MCU, not Marvel Cinematic Universe)' },
  sizeNote: { type: 'string', description: 'how the size was decided' },
  duplicateOf: { type: 'string', description: 'id of the EXISTING bracket this request is really about (same category under other words), else empty string' },
  mustHaves: { type: 'array', description: 'one verdict per must-have entry in the request', items: { type: 'object', properties: { name: { type: 'string' }, accepted: { type: 'boolean' }, reason: { type: 'string', description: 'what was checked: the Wikipedia article found and why it does or does not belong' } }, required: ['name', 'accepted', 'reason'] } },
  ok: { type: 'boolean', description: 'false if the request cannot be a public, researchable bracket' },
  reason: { type: 'string', description: 'why not, when ok is false' },
  criteria: { type: 'string', description: 'the measurable scoring rule, one or two sentences' },
  targetSize: { type: 'integer', description: 'up to 256' }, media: { type: 'string', enum: ['none', 'songs', 'trailers', 'highlights', 'openings', 'moments', 'scenes', 'commercials', 'gameplay', 'standup'] },
  notes: { type: 'string' } }, required: ['title', 'sizeNote', 'duplicateOf', 'mustHaves', 'ok', 'reason', 'criteria', 'targetSize', 'media', 'notes'] }
const ENTRY = { type: 'object', properties: {
  name: { type: 'string' }, wikiTitle: { type: 'string' }, hasImage: { type: 'boolean' }, yt: { type: 'string' }, seconds: { type: 'integer', description: 'verified length for highlight reels, else 0' },
  score: { type: 'number' }, evidence: { type: 'string', description: 'the figures behind the score, brief' } },
  required: ['name', 'wikiTitle', 'hasImage', 'yt', 'seconds', 'score', 'evidence'] }
const BRACKET = { type: 'object', properties: { entries: { type: 'array', items: ENTRY }, cut: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['entries', 'cut', 'notes'] }
const CASE = { type: 'object', properties: { name: { type: 'string' }, stats: { type: 'string' }, case: { type: 'string' } }, required: ['name', 'stats', 'case'] }
const CASES = { type: 'object', properties: { cases: { type: 'array', items: CASE }, notes: { type: 'string' } }, required: ['cases', 'notes'] }
const CASE_RULES_TEXT = `
For EVERY entry write: "stats": one line of hard credentials, at most 120 characters, items separated by " · ", facts only with year/source context, nothing invented (use the evidence; web search to confirm). "case": 2 to 4 sentences, 40 to 80 words, the most compelling honest argument for why THIS entry wins THIS bracket under its criteria; specific and confident, like a sharp friend making the pitch; same effort for every entry; no "undisputed", "objectively the best", "no contest", "the clear winner"; no running down other entries by name. Where the requester left a comment for an entry, use its angle and facts ONLY after verifying them with web search, and rewrite in the same voice as the rest. Names exactly as given.`

phase('Plan')
const plan = await agent(`${CONTEXT}\n\nEXISTING BRACKETS ON THE SITE (id, title, entries): ${JSON.stringify(EXISTING.map((b) => ({ id: b.id, title: b.title, count: b.count })))}${R.relatedTo ? `\nThe request form already matched this request to existing bracket ${R.relatedTo}.` : ''}\n\nPlan this bracket: a clean title, whether it is a valid public bracket (refuse personal/private ones or ones with no public record), whether it DUPLICATES an existing bracket (the same category under other words, e.g. "Top Anime" vs "Best Anime Series"; a genuinely narrower or different category is not a duplicate), the measurable scoring rule, the target size per the SIZE rule, the clip type per the CLIPS rule, a VERDICT ON EVERY MUST-HAVE (check each with web search and the Wikipedia API: is it a real public thing that is primarily part of this category? That is the whole test; accept by default and refuse only the plainly-not-in-category or not-real ones, with the reason), and notes on how the requester's hints shape the field. Use web search to size the category honestly.`,
  { label: 'plan', phase: 'Plan', schema: PLAN, model: 'opus' })
if (!plan.ok) return { ok: false, reason: plan.reason, plan }
const refusedMust = (plan.mustHaves || []).filter((m) => !m.accepted)
const acceptedMust = (plan.mustHaves || []).filter((m) => m.accepted).map((m) => m.name)
log(`plan: ${plan.title} · ${plan.targetSize} · ${plan.media} · ${plan.criteria.slice(0, 100)}${plan.duplicateOf ? ` · duplicate of ${plan.duplicateOf}` : ''}${refusedMust.length ? ` · refused must-haves: ${refusedMust.map((m) => m.name).join(', ')}` : ''}`)

// ---- amendment: the request is about a bracket we already have; judge its suggestions only
const target = plan.duplicateOf && EXISTING.find((b) => b.id === plan.duplicateOf)
if (target) {
  const have = new Set(target.entries.map(normName))
  const refusedNames = new Set(refusedMust.map((m) => normName(m.name)))
  const suggestions = R.entries.filter((e) => !have.has(normName(e.name)) && !refusedNames.has(normName(e.name)))
  if (!suggestions.length) return { ok: true, amend: target.id, title: target.title, additions: [], notes: 'Every suggested entry is already in the bracket; nothing to add.' }
  const judged = await agent(`${CONTEXT}\n${WIKI}\n${CLIPS}\n\nThis request is about the EXISTING bracket "${target.title}" (${target.entries.length} entries: ${JSON.stringify(target.entries)}). Its scoring rule, as best you can state it for this category: ${plan.criteria}. Judge each suggested entry below against that rule with web search: it is added only if it genuinely belongs among the current field (a must-have that plainly belongs is added; one that does not fit the category is refused with a reason). For each accepted entry: verified Wikipedia title with an image, and a verified clip of type "${plan.media}" (empty when "none"). Put refused ones in "cut" with the reason in notes.\n\nSUGGESTIONS: ${JSON.stringify(suggestions)}`,
    { label: 'judge-suggestions', phase: 'Build', schema: BRACKET, model: 'opus' })
  if (!judged.entries.length) return { ok: true, amend: target.id, title: target.title, additions: [], cut: judged.cut, notes: judged.notes }
  const addCases = await agent(`${CONTEXT}\n${CASE_RULES_TEXT}\n\nBRACKET TITLE: ${target.title}\nCRITERIA: ${plan.criteria}\nENTRIES (name, evidence): ${JSON.stringify(judged.entries.map((e) => ({ name: e.name, evidence: e.evidence })))}\nREQUESTER COMMENTS (verify before using): ${JSON.stringify(suggestions.map((s) => ({ name: s.name, comment: s.comment })))}`,
    { label: 'cases-for-additions', phase: 'Cases', schema: CASES, model: 'opus' })
  const byN = Object.fromEntries(addCases.cases.map((c) => [normName(c.name), c]))
  const additions = judged.entries.map((e) => ({ name: e.name, wikiTitle: e.wikiTitle, yt: e.yt || undefined, stats: byN[normName(e.name)]?.stats || '', case: byN[normName(e.name)]?.case || '', evidence: e.evidence }))
  log(`amend ${target.title}: +${additions.length}, refused ${judged.cut.length}`)
  return { ok: true, amend: target.id, title: target.title, additions, cut: judged.cut, notes: [judged.notes, addCases.notes].join('\n\n') }
}

phase('Build')
const draft = await agent(`${CONTEXT}\n${WIKI}\n${CLIPS}\n\nPLAN: ${JSON.stringify(plan)}\n\nBuild the ranked field under the plan's criteria (web search for the figures). GUARANTEED entries (verified must-haves): ${JSON.stringify(acceptedMust)}; refused must-haves (leave out): ${JSON.stringify(refusedMust.map((m) => m.name))}. Hints steer the category. Final count = targetSize unless the category genuinely cannot support it with real contenders (then fewer, say so in notes). Every entry: verified Wikipedia title with an image, and a verified clip of type "${plan.media}" (empty when "none"). Names short and recognizable.`,
  { label: 'build', phase: 'Build', schema: BRACKET, model: 'sonnet' })
const checked = await agent(`${CONTEXT}\n${WIKI}\n${CLIPS}\n\nPLAN: ${JSON.stringify(plan)}\n\nYou are the independent checker of the draft field below. (1) Criteria applied honestly: spot-check 8 scores with web search, fix wrong figures, re-rank, make sure no obvious contender is missing and no filler is in; must-haves present. (2) Run the Wikipedia API check on ALL entries; fix missing/disambiguation/imageless. (3) Re-run the oEmbed check on ALL ids, and the length check for highlight reels; replace failures and wrong videos. Return the corrected field in the same shape.\n\nDRAFT:\n${JSON.stringify(draft)}`,
  { label: 'check', phase: 'Build', schema: BRACKET, model: 'opus' })
log(`field: ${checked.entries.length} entries, ${checked.entries.filter((e) => e.yt).length} clips`)

phase('Cases')
const CASE_RULES = CASE_RULES_TEXT
const casesDraft = await agent(`${CONTEXT}\n${CASE_RULES}\n\nBRACKET TITLE: ${plan.title}\nCRITERIA: ${plan.criteria}\nENTRIES (name, evidence): ${JSON.stringify(checked.entries.map((e) => ({ name: e.name, evidence: e.evidence })))}`,
  { label: 'write-cases', phase: 'Cases', schema: CASES, model: 'sonnet' })
const cases = await agent(`${CONTEXT}\n${CASE_RULES}\n\nYou are the fact-checker and editor. Check the cases below for the bracket "${plan.title}" (criteria: ${plan.criteria}): every entry has a row with the exact name; verify at least 10 stats lines plus anything doubtful with web search and fix or remove what you cannot confirm; enforce the limits and the voice rules; make sure any requester-comment claims that made it in were verified. Return the corrected full set.\n\nENTRIES: ${JSON.stringify(checked.entries.map((e) => e.name))}\n\nDRAFT:\n${JSON.stringify(casesDraft)}`,
  { label: 'check-cases', phase: 'Cases', schema: CASES, model: 'opus' })

const byName = Object.fromEntries(cases.cases.map((c) => [c.name.toLowerCase(), c]))
const entries = checked.entries.map((e) => ({ name: e.name, wikiTitle: e.wikiTitle, yt: e.yt || undefined, stats: byName[e.name.toLowerCase()]?.stats || '', case: byName[e.name.toLowerCase()]?.case || '', evidence: e.evidence, seconds: e.seconds }))
log(`cases: ${entries.filter((e) => e.case).length}/${entries.length}`)
return { ok: true, title: plan.title, criteria: plan.criteria, media: plan.media, entries, cut: checked.cut, mustHaves: plan.mustHaves, notes: [plan.notes, checked.notes, cases.notes].join('\n\n') }
