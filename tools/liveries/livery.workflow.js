export const meta = {
  name: 'livery',
  description: 'Paint airlines on FlightHopper models from reference photos: research, design, lab shots, independent critique until it matches',
  whenToUse: 'Adding or improving an airline livery (docs/liveries.md Part 5). args: { repo, host?, rounds?, airlines: [{ code, airline, types, pairs, hexes?, commons?, note? }] }',
  phases: [
    { title: 'Setup', detail: 'register every design in client/livery/designs/index.ts' },
    { title: 'Research', detail: 'reference photos + dossier (skipped when a verified dossier exists)' },
    { title: 'Verify', detail: 'an independent check of the dossier against the photos' },
    { title: 'Design', detail: 'the design file, iterated against lab shots' },
    { title: 'Critique', detail: 'independent comparison of shots and photos, then fixes, until it passes' },
  ],
}

// args: {
//   repo: '/abs/path/to/checkout',            the worktree the agents edit (the dev server must serve it)
//   host: 'http://localhost:5182',            the vite dev server
//   rounds: 3,                                critique rounds at most
//   airlines: [{ code: 'WZZ', airline: 'Wizz Air', types: 'Airbus A321neo (A21N)', pairs: ['a21n:WZZ'],
//                hexes: ['4d2531', …] (tracked airframes for photos), commons: 'Category:…', note: '…' }],
// }
const A = args ?? {}
const REPO = A.repo
if (!REPO) throw new Error('args.repo (the checkout the agents edit) is required')
const HOST = A.host ?? 'http://localhost:5182'
const ROUNDS = A.rounds ?? 3
const AIRLINES = A.airlines ?? []

const RULES = `
Rules for every agent in this workflow:
- Work only in ${REPO}. Read docs/liveries.md (the pipeline guide) and .planning/livery-pipeline-design.md first.
- Never commit, never touch git; never edit files other than the ones your task names. Other agents work in the same checkout at the same time on other airlines.
- Photos are copyrighted: they stay in data/livery-refs/ (git-ignored); never copy one into public/ or client/.
- Logos: only public-domain or freely licensed files from Wikimedia Commons, into public/liveries/<CODE>/ with the source and licence of each file in public/liveries/<CODE>/sources.json. A wordmark with no free file is typeset in an OFL font (public/fonts/, licence file beside it). A graphic emblem with no free file is left out or replaced by plain shapes that are not a copy.
- Downloads needed for the task are approved. Be polite to APIs (planespotters: 1 request/s, UA "FlightHopper livery research (+https://github.com/rg1989/FlightHopper)").
- Look at images with the Read tool; base every claim on what you see.`

const DOSSIER = (a) => `${REPO}/.planning/liveries/${a.code}.md`
const REFS = (a) => `${REPO}/data/livery-refs/${a.code}`
const SHOTS = (a) => `${REPO}/data/livery-refs/shots`
const shotsCmd = (a, port, views = 'all') => `cd ${REPO} && node tools/livery-shots.ts --host ${HOST} --port ${port} --views ${views} --out data/livery-refs/shots ${a.pairs.join(' ')}`

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' }, skipped: { type: 'boolean' }, photos: { type: 'number' }, scheme: { type: 'string' }, open: { type: 'array', items: { type: 'string' } } },
  required: ['code', 'skipped', 'scheme'],
}
const DESIGN_SCHEMA = {
  type: 'object',
  properties: { code: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, shots: { type: 'string' }, summary: { type: 'string' }, knownGaps: { type: 'array', items: { type: 'string' } } },
  required: ['code', 'files', 'summary', 'knownGaps'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix'] },
    issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['major', 'minor'] }, view: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'what', 'fix'] } },
    score: { type: 'number', description: '0-10, how closely the model matches the photos' },
  },
  required: ['verdict', 'issues', 'score'],
}

phase('Setup')
await agent(`${RULES}
Make sure every one of these airline designs is registered in ${REPO}/client/livery/designs/index.ts: ${AIRLINES.map((a) => a.code).join(', ')}.
For each code without a file, create ${REPO}/client/livery/designs/<CODE>.ts exporting \`export const <CODE>: Design = { code: '<CODE>', name: '<airline> (to be drawn)', sources: ['(to do)'], side: (k) => { k.fill('#f7f7f7') } }\` (import type { Design } from '../kit.ts'), and import + add it to the DESIGNS object in index.ts (keep existing entries). Then run \`cd ${REPO} && npx tsc --noEmit -p .\` and fix only what you added. Return "ok".`, { label: 'setup', phase: 'Setup', effort: 'low' })

const results = await pipeline(
  AIRLINES,
  (a) => agent(`${RULES}
Task: the livery dossier for ${a.airline} (${a.code}), ${a.types}. ${a.note ?? ''}
If ${DOSSIER(a)} already exists and has been independently verified (it has "(verified)" marks), do nothing but read it and return skipped=true.
Otherwise research it: get reference photos into ${REFS(a)}/ (use \`node tools/liveries/refs.ts --code ${a.code}${a.hexes ? ` --hex ${a.hexes.slice(0, 15).join(',')}` : ''}${a.commons ? ` --commons "${a.commons}"` : ''}\`, then more from Wikimedia Commons or the airline if views are missing), fill in every "view" in refs.json, and write the dossier as the existing ones in .planning/liveries/ do (identity and which frames wear it; reference table; colours as hex with evidence; every element in side elevation with metres and landmarks; left/right differences; engines; wingtips; logos with licences; fonts; geometry notes; confidence). Return the structured summary.`, { label: `research:${a.code}`, phase: 'Research', schema: RESEARCH_SCHEMA }),
  (r, a) => (r && r.skipped ? r : agent(`${RULES}
Independently check the livery dossier ${DOSSIER(a)} for ${a.airline} against the photos in ${REFS(a)}/ (refs.json). Assume it has mistakes. Check the current scheme, every colour (re-sample hex values from sunlit areas), the belly line and every stripe's geometry, the titles (text, size, place, left/right), the fin, engines and wingtips on both faces, and the logo licences (open each Commons file page). Get missing views. Fix the dossier in place, marking changes "(verified)" or "(corrected: was …)". Return the structured summary with skipped=false.`, { label: `verify:${a.code}`, phase: 'Verify', schema: RESEARCH_SCHEMA })),
  (r, a, i) => agent(`${RULES}
Task: draw ${a.airline}'s livery (${a.code}) as a FlightHopper design, so that the 3-D models (${a.pairs.join(', ')}) look like the aircraft in the reference photos. ${a.note ?? ''}
Inputs: the dossier ${DOSSIER(a)}; the photos ${REFS(a)}/ (refs.json says each one's view); the kit API in docs/liveries.md §3.4 and client/livery/kit.ts; examples: the other designs in client/livery/designs/ (read at least one finished one if there is one); the model profiles in public/models/manifest.json ("profile").
Your files: client/livery/designs/${a.code}.ts (already registered in designs/index.ts), public/liveries/${a.code}/ (logos + sources.json), new files in public/fonts/ if you need a font. Nothing else.
Loop until it matches: edit the design → run \`${shotsCmd(a, 9360 + 2 * i, 'all')}\` → open the PNGs in ${SHOTS(a)}/<model>-${a.code}/ (sheet.png shows each photo beside the same view; the per-view PNGs are larger) → compare with the photos view by view (colours in similar light, belly line, every stripe/swoosh and where it starts and ends, the titles' text/size/position on BOTH sides, fin art, engines, wingtips, nose) → fix. Do at least 4 iterations and stop when a careful observer would say it is the same livery. Check the right side too (the text must read correctly). Use k.side / k.model only where the real aircraft differ.
Finally run \`cd ${REPO} && npx tsc --noEmit -p . && node --test client/livery/*.test.ts client/scene/livery.test.ts\` and fix failures in your files. Return the structured summary (files you wrote, what you matched, known gaps).`, { label: `design:${a.code}`, phase: 'Design', schema: DESIGN_SCHEMA }),
  async (d, a, i) => {
    let last = null
    for (let round = 1; round <= ROUNDS; round++) {
      const c = await agent(`${RULES}
You are an independent, demanding critic. Compare FlightHopper's 3-D model of ${a.airline} (${a.code}) with real photos. Do not trust anyone's summary.
Run \`${shotsCmd(a, 9361 + 2 * i, 'all')}\` to get fresh renders into ${SHOTS(a)}/<model>-${a.code}/, then look at every reference photo in ${REFS(a)}/ (refs.json gives each view) and the matching render, and the dossier ${DOSSIER(a)}.
List every visible difference a spotter would notice: colours, belly line, stripes and swooshes (shape, width, where they start/end), titles (text, font weight, size, position, both sides reading correctly), fin art (extent, logo size/position), tail cone, engines, wingtips (both faces), nose/radome, anything missing or extra. Ignore what the model geometry or the renderer cannot do (window shapes, panel lines, reflections, lighting differences, the photo's background). For each difference: severity (major = a spotter would call it a different or wrong livery at first glance; minor = detail), the view, what is wrong, and a concrete fix in kit terms (docs/liveries.md §3.4). Verdict "pass" only when there is no major issue. Score 0-10.`, { label: `critic:${a.code}:r${round}`, phase: 'Critique', schema: CRITIC_SCHEMA })
      last = c
      if (!c || c.verdict === 'pass' || round === ROUNDS) break // the last round only judges
      await agent(`${RULES}
Fix ${a.airline}'s design (client/livery/designs/${a.code}.ts and its public/liveries/${a.code}/ assets only; the renders: ${a.pairs.join(', ')}) for these issues an independent critic found comparing the renders with the photos (${SHOTS(a)}, ${REFS(a)}):
${JSON.stringify(c.issues, null, 1)}
Fix every major issue and as many minor ones as you can. Iterate with \`${shotsCmd(a, 9360 + 2 * i, 'all')}\` and look at the result against the photos after each change. Then run \`cd ${REPO} && npx tsc --noEmit -p . && node --test client/livery/*.test.ts\`. Return a short summary of what you changed.`, { label: `fix:${a.code}:r${round}`, phase: 'Critique' })
    }
    return { code: a.code, design: d, critic: last }
  },
)
return results.filter(Boolean)
