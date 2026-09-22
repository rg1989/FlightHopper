// tools/gate-g1.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { StatusReport } from '../shared/api.ts'
import { evaluateG1 } from './gate-g1.ts'

interface Over {
  r429?: number
  r4xx?: number
  maxRps?: number
  requestsTotal?: number
  cells?: (number | null)[]
  chase?: number | null
  bytes?: number
}

/** A synthetic /api/status body. Defaults describe a healthy server. */
const report = (o: Over = {}): StatusReport => ({
  source: 'adsblol',
  degraded: null,
  cellPeriodP95S: null,
  chasePeriodP95S: o.chase === undefined ? 1.2 : o.chase,
  budget: {
    rps: 1,
    maxRps: o.maxRps ?? 1,
    tokens: 0,
    blocked: false,
    pausedUntilMs: 0,
    counts: { ok: 0, r429: o.r429 ?? 0, r4xx: o.r4xx ?? 0, r5xx: 0, err: 0 },
  },
  cells: (o.cells ?? [3.1]).map((p, i) => ({ id: `b31:${i}`, lat: 36, lon: -122.5, radiusNm: 181, lastOkMs: 0, periodP95S: p })),
  chasedHexes: ['a1b2c3'],
  bytesPerHourEstimate: o.bytes ?? 5e6,
  requestsTotal: o.requestsTotal ?? 0,
})

type Result = ReturnType<typeof evaluateG1>
const check = (r: Result, name: string): Result['checks'][number] => {
  const c = r.checks.find((x) => x.name === name)
  assert.ok(c, `no check named ${name}`)
  return c
}

test('a healthy hour passes every check', () => {
  const r = evaluateG1([report(), report({ requestsTotal: 1800 }), report({ requestsTotal: 3500 })], 3600)
  assert.equal(r.pass, true)
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ['upstream4xx', 'cellPeriodP95S', 'chasePeriodP95S', 'avgUpstreamRps', 'bytesPerHourEstimate'],
  )
  assert.ok(r.checks.every((c) => c.pass))
  assert.deepEqual(check(r, 'bytesPerHourEstimate'), { name: 'bytesPerHourEstimate', value: 5e6, threshold: Infinity, pass: true })
})

test('any 429 or other 4xx during the window fails; 4xx from before the window does not', () => {
  assert.equal(evaluateG1([report({ r429: 3, r4xx: 1 }), report({ r429: 3, r4xx: 1 })], 60).pass, true)
  const r = evaluateG1([report({ r429: 3 }), report({ r429: 3, r4xx: 1 })], 60)
  assert.equal(r.pass, false)
  assert.deepEqual(check(r, 'upstream4xx'), { name: 'upstream4xx', value: 1, threshold: 0, pass: false })
  assert.equal(check(evaluateG1([report(), report({ r429: 1 })], 60), 'upstream4xx').pass, false)
})

test('cell period: the worst cell p95 of any report counts; nulls are ignored', () => {
  const r = evaluateG1([report({ cells: [3.0, null] }), report({ cells: [null, 4.0] }), report({ cells: [3.2, 3.3] })], 60)
  assert.deepEqual(check(r, 'cellPeriodP95S'), { name: 'cellPeriodP95S', value: 4, threshold: 3.5, pass: false })
  assert.equal(r.pass, false)
})

test('cell period threshold scales with MAX_RPS: 7 s at 0.5 req/s', () => {
  const r = evaluateG1([report({ maxRps: 0.5, cells: [6.9] }), report({ maxRps: 0.5, cells: [6.5] })], 60)
  assert.deepEqual(check(r, 'cellPeriodP95S'), { name: 'cellPeriodP95S', value: 6.9, threshold: 7, pass: true })
})

test('no cell or chase data at all fails (value NaN)', () => {
  const r = evaluateG1([report({ cells: [], chase: null }), report({ cells: [null], chase: null })], 60)
  assert.ok(Number.isNaN(check(r, 'cellPeriodP95S').value))
  assert.equal(check(r, 'cellPeriodP95S').pass, false)
  assert.ok(Number.isNaN(check(r, 'chasePeriodP95S').value))
  assert.equal(check(r, 'chasePeriodP95S').pass, false)
})

test('chase period p95 above 1.5 s fails', () => {
  const r = evaluateG1([report({ chase: 1.2 }), report({ chase: 1.6 }), report({ chase: 1.1 })], 60)
  assert.deepEqual(check(r, 'chasePeriodP95S'), { name: 'chasePeriodP95S', value: 1.6, threshold: 1.5, pass: false })
})

test('average upstream rate: requestsTotal delta / seconds, allowed up to maxRps plus one burst', () => {
  const at = (requestsTotal: number): Result => evaluateG1([report({ requestsTotal: 100 }), report({ requestsTotal })], 3600)
  assert.equal(check(at(100 + 3600), 'avgUpstreamRps').value, 1)
  assert.equal(check(at(100 + 3602), 'avgUpstreamRps').pass, true)
  const over = check(at(100 + 3610), 'avgUpstreamRps')
  assert.equal(over.pass, false)
  assert.equal(over.threshold, 1 + 2 / 3600)
  assert.equal(check(evaluateG1([report({ maxRps: 0.5 }), report({ maxRps: 0.5, requestsTotal: 1900 })], 3600), 'avgUpstreamRps').pass, false)
})

test('needs at least two reports over a positive span', () => {
  assert.throws(() => evaluateG1([report()], 60), /2 reports/)
  assert.throws(() => evaluateG1([report(), report()], 0), /2 reports/)
})

// ---- CLI smoke test against a local fake /api/status (never the network) ----

const run = promisify(execFile)
const script = fileURLToPath(new URL('./gate-g1.ts', import.meta.url))

async function fakeStatus(
  make: (n: number) => StatusReport,
  firstDelayMs = 0,
): Promise<{ base: string; hits: () => number; close: () => Promise<void> }> {
  let n = 0
  const srv = createServer((req, res) => {
    if (req.url !== '/api/status') {
      res.writeHead(404).end()
      return
    }
    const i = n++
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(make(i)))
    }
    if (i === 0 && firstDelayMs > 0) setTimeout(answer, firstDelayMs)
    else answer()
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections()
        srv.close(() => resolve())
      }),
  }
}

const cliArgs = (base: string, out: string): string[] => [script, '--base', base, '--minutes', '0.003', '--interval-ms', '40', '--out', out]

test('CLI polls /api/status, writes G1-<date>.json and exits 0 on pass', async () => {
  const fake = await fakeStatus(() => report())
  const out = mkdtempSync(join(tmpdir(), 'g1-pass-'))
  try {
    const { stdout } = await run(process.execPath, cliArgs(fake.base, out))
    const files = readdirSync(out)
    assert.equal(files.length, 1)
    assert.match(files[0], /^G1-\d{4}-\d{2}-\d{2}\.json$/)
    const written = JSON.parse(readFileSync(join(out, files[0]), 'utf8'))
    assert.equal(written.gate, 'G1')
    assert.equal(written.pass, true)
    assert.equal(written.checks.length, 5)
    assert.ok(written.reports >= 2, `reports=${written.reports}`)
    assert.ok(written.seconds > 0)
    assert.ok(fake.hits() >= 2)
    assert.match(stdout, /G1 PASS/)
  } finally {
    await fake.close()
  }
})

test('CLI exits 1 and records the failure when a 429 happens during the run', async () => {
  const fake = await fakeStatus((n) => report({ r429: n }))
  const out = mkdtempSync(join(tmpdir(), 'g1-fail-'))
  try {
    await assert.rejects(run(process.execPath, cliArgs(fake.base, out)), (e: { code?: number; stdout?: string }) => {
      assert.equal(e.code, 1)
      assert.match(e.stdout ?? '', /G1 FAIL/)
      return true
    })
    const written = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(written.pass, false)
    assert.equal(written.checks[0].name, 'upstream4xx')
    assert.equal(written.checks[0].pass, false)
  } finally {
    await fake.close()
  }
})

test('CLI still takes a second report when the first answer arrives after the window', async () => {
  const fake = await fakeStatus(() => report(), 400) // the window is 0.003 min = 180 ms
  const out = mkdtempSync(join(tmpdir(), 'g1-slow-'))
  try {
    const { stdout } = await run(process.execPath, cliArgs(fake.base, out))
    const written = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(written.reports, 2)
    assert.equal(written.pass, true)
    assert.match(stdout, /G1 PASS/)
  } finally {
    await fake.close()
  }
})
