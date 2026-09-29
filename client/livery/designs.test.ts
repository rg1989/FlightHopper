// client/livery/designs.test.ts
// Every airline design drawn on every painted model: finite numbers, valid colours, logo files that exist and have a
// recorded source and licence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { DESIGNS } from './designs/index.ts'
import { drawDesign, profileOf } from './kit.ts'
import type { Op } from './kit.ts'
import type { ModelManifest } from '../types.ts'

const root = new URL('../../', import.meta.url)
const manifest: ModelManifest = JSON.parse(readFileSync(new URL('public/models/manifest.json', root), 'utf8'))
const COLOUR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([\d.,\s%]+\))$/i

test('every design is registered under its own code and names its sources', () => {
  for (const [code, d] of Object.entries(DESIGNS)) {
    assert.equal(d.code, code)
    assert.ok(d.sources && d.sources.length > 0, `${code}: sources`)
    for (const c of [d.base, d.wing, d.stab, d.engineColor, d.wingletColor]) if (c !== undefined) assert.match(c, COLOUR, code)
  }
})

test('every design draws on every painted model with finite coordinates, valid colours and existing images', () => {
  const nums = (op: Op): number[] =>
    op.k === 'path' ? op.d.flatMap((s) => s.slice(1) as number[]) : op.k === 'text' ? [op.z, op.y, op.capM, op.tracking] : op.k === 'image' ? [op.z, op.y, op.w ?? 1, op.h ?? 1] : op.k === 'wrap' ? op.box : []
  for (const [code, d] of Object.entries(DESIGNS)) {
    for (const m of manifest.models.filter((e) => e.paint)) {
      const ops = drawDesign(d, { id: m.id, profile: profileOf(m)!, paint: m.paint })
      for (const r of [ops.skin, ops.nacelle, ops.tip]) {
        for (const op of r ? [...r.left, ...r.right] : []) {
          for (const n of nums(op)) assert.ok(Number.isFinite(n), `${code} on ${m.id}: ${JSON.stringify(op).slice(0, 120)}`)
          if ('color' in op) assert.match(op.color, COLOUR, `${code} on ${m.id}`)
          if (op.k === 'image' || op.k === 'wrap') {
            assert.ok(op.src.startsWith('/'), `${code}: ${op.src} is a public path`)
            assert.ok(existsSync(new URL(`public${op.src}`, root)), `${code}: ${op.src} exists`)
          }
        }
      }
    }
  }
})

test('every file in a design folder has its source and licence in the folder\'s sources.json', () => {
  const dir = new URL('public/liveries/', root)
  for (const code of readdirSync(dir).filter((f) => statSync(new URL(f, dir)).isDirectory())) {
    const src: Record<string, { source: string; licence: string }> = JSON.parse(readFileSync(new URL(`${code}/sources.json`, dir), 'utf8'))
    for (const f of readdirSync(new URL(`${code}/`, dir)).filter((n) => n !== 'sources.json')) {
      assert.ok(src[f]?.source && src[f]?.licence, `public/liveries/${code}/sources.json: "${f}" needs source and licence`)
    }
  }
})
