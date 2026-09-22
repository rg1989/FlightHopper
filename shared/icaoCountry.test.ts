// shared/icaoCountry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flagEmoji } from './icaoCountry.ts'

test('flagEmoji: two regional-indicator symbols, case-insensitive', () => {
  assert.equal(flagEmoji('IL'), '\u{1F1EE}\u{1F1F1}')
  assert.equal(flagEmoji('lt'), '\u{1F1F1}\u{1F1F9}')
  assert.equal(flagEmoji('US'), '🇺🇸')
})

test('flagEmoji: anything but two ASCII letters → empty string', () => {
  for (const s of ['', 'I', 'ISR', '1A', 'I-', ' IL', 'É1']) assert.equal(flagEmoji(s), '', JSON.stringify(s))
})
