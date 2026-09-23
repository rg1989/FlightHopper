// client/scenario/format.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { clockToS, sToClock, offsetMs, parseScenario, parseCard, loadScenario, ScenarioError } from './format.ts'

// ---- clockToS / sToClock / offsetMs -----------------------------------------------------------

test('clockToS: basic time with fractional seconds', () => {
  assert.equal(clockToS('18:24:35.7'), 66275.7)
})

test('clockToS: hours may exceed 23 (a scenario that crosses midnight)', () => {
  assert.equal(clockToS('24:05:00'), 86700)
})

test('clockToS: throws on bad input', () => {
  assert.throws(() => clockToS('not a time'))
  assert.throws(() => clockToS('18:60:00')) // minutes out of range
  assert.throws(() => clockToS('18:24'))
})

test('sToClock: round-trips clockToS for whole seconds', () => {
  assert.equal(sToClock(66275), '18:24:35')
})

test('sToClock: hours >= 24 are kept as such', () => {
  assert.equal(sToClock(86700), '24:05:00')
})

test('sToClock: decimals', () => {
  assert.equal(sToClock(66275.7, 1), '18:24:35.7')
})

test('offsetMs: +09:00 is 9 hours', () => {
  assert.equal(offsetMs('+09:00'), 32_400_000)
})

test('offsetMs: negative offset', () => {
  assert.equal(offsetMs('-05:00'), -18_000_000)
})

// ---- a tiny inline package: happy path ---------------------------------------------------------

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    id: 'jal123',
    title: 'Japan Air Lines Flight 123',
    subtitle: 'Tokyo Haneda \u2192 Osaka Itami',
    date: '1985-08-12',
    utcOffset: '+09:00',
    clockLabel: 'JST',
    start: '18:11:15',
    end: '18:11:18',
    note: 'A reconstruction of a real accident.',
    summary: ['line one'],
    crew: [{ role: 'Captain', name: 'Masami Takahama' }],
    aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: 'b744' },
    speakers: { CAP: { name: 'Captain', kind: 'crew' }, COP: { name: 'Co-pilot', kind: 'crew' }, ACC: { name: 'Tokyo Control', kind: 'atc' } },
    imagery: [],
    sources: [{ id: 'R', title: 'AAIC report (1987)' }],
    ...overrides,
  }
}

const VALID_TRACK = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,35.55,139.78,0,150,0,0', '18:11:16,35.551,139.781,50,150,1,0', '18:11:18,35.552,139.782,120,150,2,0'].join(
  '\n',
)

const VALID_EVENTS = ['time,type,value,label,src', '18:11:15,phase,,Take-off,R', '18:11:16,mark,,Rotation,'].join('\n')

const VALID_TRANSCRIPT = [
  'time,dur,speaker,to,channel,lang,text,original,q,src',
  '18:11:15,2,CAP,COP,cockpit,en,Positive rate,,D,R',
  '18:11:16,,ACC,,radio,en,Contact departure,,D,',
].join('\n')

function validFiles(overrides: Partial<{ manifest: unknown; track: string; events: string | null; transcript: string | null }> = {}) {
  return {
    base: 'https://example.test/scenarios/jal123/',
    manifest: validManifest(),
    track: VALID_TRACK,
    events: VALID_EVENTS,
    transcript: VALID_TRANSCRIPT,
    present: { body: false, finLogo: false, audio: false },
    ...overrides,
  }
}

test('parseScenario: a valid tiny package parses without throwing', () => {
  const scn = parseScenario(validFiles())
  assert.equal(scn.id, 'jal123')
  assert.equal(scn.track.length, 3)
  assert.equal(scn.events.length, 2)
  assert.equal(scn.lines.length, 2)
  assert.equal(scn.start, clockToS('18:11:15'))
  assert.equal(scn.end, clockToS('18:11:18'))
})

test('parseScenario: t0UtcMs for 1985-08-12 +09:00 is midnight JST expressed in UTC', () => {
  const scn = parseScenario(validFiles())
  assert.equal(scn.t0UtcMs, Date.UTC(1985, 7, 11, 15, 0, 0))
})

test('parseScenario: an empty dur is estimated from the caption length, clamped 2.5..8', () => {
  const scn = parseScenario(validFiles())
  const line = scn.lines[1] // dur cell was empty, text = 'Contact departure' (18 chars)
  const expected = Math.min(8, Math.max(2.5, 1.2 + 0.06 * 'Contact departure'.length))
  assert.equal(line.dur, expected)
})

test('parseScenario: track quality and src are parsed; missing epr columns give epr: null', () => {
  const scn = parseScenario(validFiles())
  assert.equal(scn.track[0].epr, null)
  assert.equal(scn.track[0].q, null)
  assert.equal(scn.track[0].src, null)
})

test('parseCard: reads only the manifest, for the scenario panel', () => {
  const card = parseCard(validManifest())
  assert.equal(card.id, 'jal123')
  assert.equal(card.title, 'Japan Air Lines Flight 123')
  assert.equal(card.start, clockToS('18:11:15'))
})

// ---- validation: manifest -----------------------------------------------------------------------

test('parseScenario: manifest format !== 1 is a problem naming the manifest file and column', () => {
  assert.throws(() => parseScenario(validFiles({ manifest: validManifest({ format: 2 }) })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^scenario\.json:.*format/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: a missing required manifest string is a problem', () => {
  const m = validManifest()
  delete m.title
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /title/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: a bad date is a problem', () => {
  assert.throws(() => parseScenario(validFiles({ manifest: validManifest({ date: '1985/08/12' }) })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /date/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: a bad utcOffset is a problem', () => {
  assert.throws(() => parseScenario(validFiles({ manifest: validManifest({ utcOffset: 'JST' }) })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /utcOffset/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: start >= end is a problem', () => {
  assert.throws(() => parseScenario(validFiles({ manifest: validManifest({ start: '18:20:00', end: '18:10:00' }) })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /start/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: an empty aircraft.model is a problem', () => {
  const m = validManifest({ aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: '' } })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /aircraft\.model/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: a speaker with an unknown kind is a problem', () => {
  const m = validManifest({ speakers: { CAP: { name: 'Captain', kind: 'pilot' } } })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /speakers\.CAP/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: duplicate source ids are a problem', () => {
  const m = validManifest({ sources: [{ id: 'R', title: 'a' }, { id: 'R', title: 'b' }] })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /sources.*duplicate/i.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: an imagery rect with west >= east is a problem', () => {
  const m = validManifest({ imagery: [{ url: 'https://x/{z}/{x}/{y}.jpg', rect: [140, 35, 139, 36], credit: 'x' }] })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /imagery/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: ending.fadeFrom after darkAt is a problem', () => {
  const m = validManifest({ ending: { fadeFrom: '18:56:22', darkAt: '18:56:17', cardAfterS: 5, card: { title: 't', lines: [] } } })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /ending\.fadeFrom/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: audio with an empty source is a problem', () => {
  const m = validManifest({ audio: { file: 'local/cvr.m4a', source: '', clips: [{ from: 0, to: 1, at: '18:11:15' }] } })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /audio\.source/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: an audio clip with from >= to is a problem', () => {
  const m = validManifest({ audio: { file: 'local/cvr.m4a', source: 'x', clips: [{ from: 5, to: 1, at: '18:11:15' }] } })
  assert.throws(() => parseScenario(validFiles({ manifest: m })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /audio\.clips/.test(p)), err.problems.join('\n'))
    return true
  })
})

// ---- validation: track.csv -----------------------------------------------------------------------

test('parseScenario: an unknown track.csv column is a problem, but x_* columns are ignored', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll,bogus,x_note', '18:11:15,35.55,139.78,0,150,0,0,1,note', '18:11:16,35.551,139.781,50,150,1,0,1,note'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /track\.csv.*bogus/.test(p)), err.problems.join('\n'))
    assert.ok(!err.problems.some((p) => /x_note/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: a missing required track.csv column is a problem', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch', '18:11:15,35.55,139.78,0,150,0', '18:11:16,35.551,139.781,50,150,1'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /track\.csv.*roll/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv time must be strictly increasing', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,35.55,139.78,0,150,0,0', '18:11:15,35.551,139.781,50,150,1,0', '18:11:18,35.552,139.782,120,150,2,0'].join(
    '\n',
  )
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /track\.csv:3.*time/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv lat out of range is a problem naming the row and column', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,95,139.78,0,150,0,0', '18:11:16,35.551,139.781,50,150,1,0', '18:11:18,35.552,139.782,120,150,2,0'].join(
    '\n',
  )
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:2: lat:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv hdg out of range [0, 360) is a problem', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,35.55,139.78,0,360,0,0', '18:11:16,35.551,139.781,50,150,1,0', '18:11:18,35.552,139.782,120,150,2,0'].join(
    '\n',
  )
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:2: hdg:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv bad q is a problem', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll,q', '18:11:15,35.55,139.78,0,150,0,0,X', '18:11:16,35.551,139.781,50,150,1,0,A', '18:11:18,35.552,139.782,120,150,2,0,A'].join(
    '\n',
  )
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:2: q:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv src not in sources is a problem', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll,src', '18:11:15,35.55,139.78,0,150,0,0,Z', '18:11:16,35.551,139.781,50,150,1,0,R', '18:11:18,35.552,139.782,120,150,2,0,R'].join(
    '\n',
  )
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:2: src:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv needs at least 2 rows', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,35.55,139.78,0,150,0,0'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /track\.csv.*at least 2 rows/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv must start at or before manifest start and end at or after manifest end', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:16,35.55,139.78,0,150,0,0', '18:11:17,35.551,139.781,50,150,1,0'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /track\.csv.*first row/.test(p)), err.problems.join('\n'))
    assert.ok(err.problems.some((p) => /track\.csv.*last row/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv an empty required numeric cell is a problem, not a silent 0', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,,139.78,0,150,0,0', '18:11:16,35.551,139.781,50,150,1,0', '18:11:18,35.552,139.782,120,150,2,0'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:2: lat: required/.test(p)), err.problems.join('\n'))
    // and it must not also be reported as merely out-of-range from the 0 fallback
    assert.ok(!err.problems.some((p) => /^track\.csv:2: lat: out of range/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: track.csv an empty optional numeric cell (e.g. ias_kt) is not a problem', () => {
  const track = [
    'time,lat,lon,alt_ft,hdg,pitch,roll,ias_kt',
    '18:11:15,35.55,139.78,0,150,0,0,',
    '18:11:16,35.551,139.781,50,150,1,0,140',
    '18:11:18,35.552,139.782,120,150,2,0,140',
  ].join('\n')
  const scn = parseScenario(validFiles({ track }))
  assert.equal(scn.track[0].iasKt, null)
})

test('parseScenario: track.csv a bad last-row time reports only the bad-time problem, not a duplicate boundary problem', () => {
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,35.55,139.78,0,150,0,0', '18:11:16,35.551,139.781,50,150,1,0', 'bogus,35.552,139.782,120,150,2,0'].join('\n')
  assert.throws(() => parseScenario(validFiles({ track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^track\.csv:4: time: bad time/.test(p)), err.problems.join('\n'))
    assert.ok(!err.problems.some((p) => /last row/.test(p)), err.problems.join('\n'))
    return true
  })
})

// ---- validation: events.csv ----------------------------------------------------------------------

test('parseScenario: events.csv bad type is a problem', () => {
  const events = ['time,type,value,label,src', '18:11:15,bogus,,x,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ events })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^events\.csv:2: type:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: events.csv gear value must be 0 or 1', () => {
  const events = ['time,type,value,label,src', '18:11:15,gear,down,x,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ events })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^events\.csv:2: value:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: events.csv flaps value must be a number', () => {
  const events = ['time,type,value,label,src', '18:11:15,flaps,many,x,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ events })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^events\.csv:2: value:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: events.csv damage value must be non-empty', () => {
  const events = ['time,type,value,label,src', '18:11:15,damage,,x,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ events })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^events\.csv:2: value:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: events.csv times must be non-decreasing', () => {
  const events = ['time,type,value,label,src', '18:11:16,mark,,a,', '18:11:15,mark,,b,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ events })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^events\.csv:3: time:/.test(p)), err.problems.join('\n'))
    return true
  })
})

// ---- validation: transcript.csv ------------------------------------------------------------------

test('parseScenario: transcript.csv unknown speaker is a problem', () => {
  const transcript = ['time,dur,speaker,to,channel,lang,text,original,q,src', '18:11:15,2,GHOST,,cockpit,en,hi,,D,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ transcript })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^transcript\.csv:2: speaker:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: transcript.csv bad channel is a problem', () => {
  const transcript = ['time,dur,speaker,to,channel,lang,text,original,q,src', '18:11:15,2,CAP,,bogus,en,hi,,D,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ transcript })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^transcript\.csv:2: channel:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: transcript.csv q=U requires text [unintelligible]', () => {
  const transcript = ['time,dur,speaker,to,channel,lang,text,original,q,src', '18:11:15,2,CAP,,cockpit,en,something,,U,'].join('\n')
  assert.throws(() => parseScenario(validFiles({ transcript })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^transcript\.csv:2: text:/.test(p)), err.problems.join('\n'))
    return true
  })
})

test('parseScenario: transcript.csv times must be non-decreasing', () => {
  const transcript = [
    'time,dur,speaker,to,channel,lang,text,original,q,src',
    '18:11:16,2,CAP,,cockpit,en,a,,D,',
    '18:11:15,2,CAP,,cockpit,en,b,,D,',
  ].join('\n')
  assert.throws(() => parseScenario(validFiles({ transcript })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.some((p) => /^transcript\.csv:3: time:/.test(p)), err.problems.join('\n'))
    return true
  })
})

// ---- several errors reported together --------------------------------------------------------

test('parseScenario: several problems across files are collected and thrown together', () => {
  const manifest = validManifest({ format: 2, date: 'bad-date' })
  const track = ['time,lat,lon,alt_ft,hdg,pitch,roll', '18:11:15,95,139.78,0,150,0,0'].join('\n')
  assert.throws(() => parseScenario(validFiles({ manifest, track })), (err: unknown) => {
    assert.ok(err instanceof ScenarioError)
    assert.ok(err.problems.length >= 3, `expected several problems, got ${err.problems.length}:\n${err.problems.join('\n')}`)
    assert.ok(err.problems.some((p) => /format/.test(p)))
    assert.ok(err.problems.some((p) => /date/.test(p)))
    assert.ok(err.problems.some((p) => /lat/.test(p)))
    return true
  })
})

// ---- loadScenario: optional-file presence probing -------------------------------------------------

function mockFetcher(manifest: unknown, headCalls: string[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'HEAD') {
      headCalls.push(u)
      return new Response(null, { status: 200 })
    }
    if (u.endsWith('scenario.json')) return new Response(JSON.stringify(manifest), { status: 200 })
    if (u.endsWith('track.csv')) return new Response(VALID_TRACK, { status: 200 })
    if (u.endsWith('events.csv')) return new Response(VALID_EVENTS, { status: 200 })
    if (u.endsWith('transcript.csv')) return new Response(VALID_TRANSCRIPT, { status: 200 })
    return new Response('', { status: 404 })
  }) as typeof fetch
}

test('loadScenario: an empty livery.body/finLogo/audio.file path is not probed and present stays false', async () => {
  const headCalls: string[] = []
  const manifest = validManifest({
    aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: 'b744', livery: { body: '', finLogo: '' } },
    audio: { file: '', source: 'AAIC', clips: [] },
  })
  const scn = await loadScenario('https://example.test/', 'jal123', mockFetcher(manifest, headCalls))
  assert.equal(headCalls.length, 0, `expected no HEAD probes, got: ${headCalls.join(', ')}`)
  assert.equal(scn.present.body, false)
  assert.equal(scn.present.finLogo, false)
  assert.equal(scn.present.audio, false)
})

test('loadScenario: a non-empty livery.body path is probed and present reflects the HEAD result', async () => {
  const headCalls: string[] = []
  const manifest = validManifest({
    aircraft: { registration: 'JA8119', type: 'Boeing 747SR-46', callsign: 'JAL123', operator: 'Japan Air Lines', model: 'b744', livery: { body: 'decals/body.png' } },
  })
  const scn = await loadScenario('https://example.test/', 'jal123', mockFetcher(manifest, headCalls))
  assert.ok(headCalls.some((u) => u.endsWith('decals/body.png')), headCalls.join(', '))
  assert.equal(scn.present.body, true)
})

// ---- every real package (npm test fails if a shipped package is broken) ------------------------

test('parseScenario: every real package under public/scenarios parses without throwing', async (t) => {
  const root = path.resolve(import.meta.dirname, '../../public/scenarios')
  const indexPath = path.join(root, 'index.json')
  try {
    await access(indexPath)
  } catch {
    t.skip('public/scenarios/index.json does not exist yet (another task creates it)')
    return
  }
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { scenarios: string[] }
  for (const id of index.scenarios) {
    const dir = path.join(root, id)
    const manifest: unknown = JSON.parse(await readFile(path.join(dir, 'scenario.json'), 'utf8'))
    const track = await readFile(path.join(dir, 'track.csv'), 'utf8')
    const events = await readFile(path.join(dir, 'events.csv'), 'utf8').catch(() => null)
    const transcript = await readFile(path.join(dir, 'transcript.csv'), 'utf8').catch(() => null)
    assert.doesNotThrow(
      () => parseScenario({ base: `${dir}/`, manifest, track, events, transcript, present: { body: false, finLogo: false, audio: false } }),
      `scenario ${id}`,
    )
  }
})
