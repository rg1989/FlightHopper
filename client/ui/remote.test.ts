// client/ui/remote.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// remote.ts imports its CSS for Vite. Node cannot load CSS, so this test process loads every .css as an empty module.
registerHooks({
  load: (url, context, nextLoad) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)),
})

const { CHASE_ZOOM, MAP_ZOOM, ORBIT_DEG, PAN_SHARE, STEP_S, TILT_DEG, cameraStep, pickNext, remoteAction, remoteKey, tvMode } = await import('./remote.ts')

const box = (x: number, y: number, w = 36, h = 36): { x: number; y: number; w: number; h: number } => ({ x, y, w, h })

test('tvMode: only ?tv=1', () => {
  assert.equal(tvMode('?tv=1'), true)
  assert.equal(tvMode('?at=1,2,3&tv=1'), true)
  assert.equal(tvMode(''), false)
  assert.equal(tvMode('?tv=0'), false)
  assert.equal(tvMode('?tv'), false)
})

test('remoteKey: the remote\'s keys, nothing with a modifier', () => {
  const k = (key: string, mod: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}): ReturnType<typeof remoteKey> =>
    remoteKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mod })
  assert.equal(k('ArrowUp'), 'up')
  assert.equal(k('ArrowDown'), 'down')
  assert.equal(k('ArrowLeft'), 'left')
  assert.equal(k('ArrowRight'), 'right')
  assert.equal(k('Enter'), 'ok')
  assert.equal(k('Escape'), 'back')
  assert.equal(k('ContextMenu'), 'menu')
  assert.equal(k('t'), null)
  assert.equal(k(' '), null)
  assert.equal(k('ArrowLeft', { shiftKey: true }), null, 'Shift+← is the scrubber\'s big step, a keyboard\'s')
  assert.equal(k('Enter', { metaKey: true }), null)
})

test('pickNext: the nearest control that way, in line first', () => {
  // A column of rail buttons and, left of it, a panel's controls.
  const rail = [box(1232, 12), box(1232, 50), box(1232, 88)]
  assert.equal(pickNext(rail[0], rail, 'down'), 1)
  assert.equal(pickNext(rail[1], rail, 'down'), 2)
  assert.equal(pickNext(rail[1], rail, 'up'), 0)
  assert.equal(pickNext(rail[2], rail, 'down'), -1, 'nothing below the last one')
  assert.equal(pickNext(rail[0], rail, 'left'), -1, 'nothing left of the rail')
  // Left from the middle button: the panel's control level with it beats a nearer one higher up.
  const panel = [box(1180, 12, 28, 28), box(900, 52, 280, 30), box(1150, 200, 28, 28)]
  assert.equal(pickNext(rail[1], panel, 'left'), 1)
  assert.equal(pickNext(rail[0], panel, 'left'), 0)
})

test('pickNext: only what lies wholly beyond the edge; adjacent boxes count', () => {
  const from = box(100, 100, 100, 30)
  const rowBelow = box(100, 130, 100, 30) // shares from's bottom edge (a list's next row)
  const overlapping = box(150, 110, 100, 30) // half beside, half below: neither
  assert.equal(pickNext(from, [overlapping, rowBelow], 'down'), 1)
  assert.equal(pickNext(from, [overlapping], 'right'), -1)
  assert.equal(pickNext(from, [overlapping], 'down'), -1)
  assert.equal(pickNext(from, [box(100, 129.5, 100, 30)], 'down'), 0, 'sub-pixel overlap is adjacent')
})

test('pickNext: up and down go to the control in the column over a nearer one aside; a tie goes to the best aligned', () => {
  const from = box(100, 100, 40, 30)
  const farBelow = box(100, 300, 40, 30)
  const nearAside = box(400, 140, 40, 30)
  assert.equal(pickNext(from, [nearAside, farBelow], 'down'), 1)
  // Three buttons in a row under a wide field: the one under the field's middle.
  const field = box(100, 100, 300, 30)
  const row = [box(100, 140, 60, 30), box(220, 140, 60, 30), box(340, 140, 60, 30)]
  assert.equal(pickNext(field, row, 'down'), 1)
})

test('pickNext: sideways, a control in the row beats a nearer one above or below', () => {
  const from = box(100, 100, 40, 30)
  const inRowFar = box(600, 100, 40, 30)
  const nearHigher = box(150, 20, 40, 30)
  assert.equal(pickNext(from, [nearHigher, inRowFar], 'right'), 1)
  assert.equal(pickNext(from, [nearHigher], 'right'), 0, 'still reachable when nothing is in the row')
  // The corner's Settings: ← goes to the layout button level with it across the screen, not to the play bar's exit
  // just below its row.
  const settings = box(1227, 613)
  const exit = box(1171, 658)
  const layout = box(12, 590, 46, 46)
  assert.equal(pickNext(settings, [exit, layout], 'left'), 1)
})

test('remoteAction: UI mode', () => {
  const ui = (key: Parameters<typeof remoteAction>[0], control: Parameters<typeof remoteAction>[2]['control'] = 'other', modal = false): string =>
    remoteAction(key, 'ui', { control, modal })
  for (const d of ['up', 'down', 'left', 'right'] as const) assert.equal(ui(d), 'move')
  assert.equal(ui('ok'), 'click')
  assert.equal(ui('back'), 'back')
  assert.equal(ui('menu'), 'map')
  // A text field: OK opens the on-screen keyboard, Esc is its own; every arrow leaves it (the keyboard types at the end:
  // no caret to move).
  for (const d of ['up', 'down', 'left', 'right'] as const) assert.equal(ui(d, 'text'), 'move')
  assert.equal(ui('ok', 'text'), 'keyboard')
  assert.equal(ui('back', 'text'), 'pass')
  // A slider and a tab keep ←/→.
  assert.equal(ui('left', 'range'), 'pass')
  assert.equal(ui('down', 'range'), 'move')
  assert.equal(ui('ok', 'range'), 'click')
  assert.equal(ui('right', 'tab'), 'pass')
  assert.equal(ui('up', 'tab'), 'move')
  // A box of text that scrolls (the card's details): ↑/↓ scroll it (to its end, then on), ←/→ leave it.
  assert.equal(ui('down', 'scroll'), 'scroll')
  assert.equal(ui('up', 'scroll'), 'scroll')
  assert.equal(ui('left', 'scroll'), 'move')
  // The search box: ↑/↓ are its own (its results), OK opens the keyboard until a result is under them, then picks it;
  // Back clears it, then leaves it; ←/→ leave it.
  for (const c of ['search', 'result'] as const) {
    assert.equal(ui('up', c), 'pass')
    assert.equal(ui('down', c), 'pass')
    assert.equal(ui('left', c), 'move')
    assert.equal(ui('back', c), 'clear')
    assert.equal(ui('menu', c), 'map')
  }
  assert.equal(ui('ok', 'search'), 'keyboard')
  assert.equal(ui('ok', 'result'), 'pass')
  // A modal dialog: Esc is the dialog's (it closes), and the map stays out of reach.
  assert.equal(ui('back', 'other', true), 'pass')
  assert.equal(ui('menu', 'other', true), 'none')
  assert.equal(ui('down', 'other', true), 'move')
  assert.equal(ui('ok', 'other', true), 'click')
})

test('remoteAction: the on-screen keyboard open takes the arrows, OK and Back; Menu still goes to the map', () => {
  const osk = (key: Parameters<typeof remoteAction>[0], modal = false): string => remoteAction(key, 'ui', { control: 'search', modal, osk: true })
  for (const d of ['up', 'down', 'left', 'right'] as const) assert.equal(osk(d), 'key')
  assert.equal(osk('ok'), 'type')
  assert.equal(osk('back'), 'done')
  assert.equal(osk('back', true), 'done', 'in a dialog too: Back closes the keyboard, not the dialog')
  assert.equal(osk('menu'), 'map')
  assert.equal(osk('menu', true), 'none')
})

test('remoteAction: map mode', () => {
  const map = (key: Parameters<typeof remoteAction>[0]): string => remoteAction(key, 'map', { control: 'other', modal: false })
  for (const d of ['up', 'down', 'left', 'right'] as const) assert.equal(map(d), 'camera')
  assert.equal(map('ok'), 'ok')
  assert.equal(map('back'), 'ui')
  assert.equal(map('menu'), 'ui')
})

test('cameraStep: a press (STEP_S) pans a tenth of the view that way', () => {
  const w = 1280
  const h = 720
  const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
  near(cameraStep('right', STEP_S, w, h, false).dx, PAN_SHARE * w)
  near(cameraStep('left', STEP_S, w, h, false).dx, -PAN_SHARE * w)
  near(cameraStep('up', STEP_S, w, h, false).dy, -PAN_SHARE * h)
  near(cameraStep('down', STEP_S, w, h, false).dy, PAN_SHARE * h)
  assert.equal(cameraStep('up', STEP_S, w, h, false).dx, 0)
  assert.equal(cameraStep('left', STEP_S, w, h, false).zoom, 1, 'a pan does not zoom')
  // Held, at the same pace: half a step in half the time.
  near(cameraStep('right', STEP_S / 2, w, h, false).dx, (PAN_SHARE * w) / 2)
})

test('cameraStep: chase arrows move the camera round the aircraft: right swings it right (the heading offset falls), up raises it', () => {
  const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
  near(cameraStep('right', STEP_S, 1, 1, true).headingDeg, -ORBIT_DEG)
  near(cameraStep('left', STEP_S, 1, 1, true).headingDeg, ORBIT_DEG)
  near(cameraStep('up', STEP_S, 1, 1, true).pitchDeg, -TILT_DEG)
  near(cameraStep('down', STEP_S, 1, 1, true).pitchDeg, TILT_DEG)
  assert.equal(cameraStep('up', STEP_S, 1, 1, true).headingDeg, 0)
})

test('cameraStep: OK zooms in, a held OK out: halves or doubles the map\'s height, the chase range by 1.5, over a step', () => {
  const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
  near(cameraStep('in', STEP_S, 1, 1, false).zoom, MAP_ZOOM)
  near(cameraStep('out', STEP_S, 1, 1, false).zoom, 1 / MAP_ZOOM)
  near(cameraStep('in', STEP_S, 1, 1, true).zoom, CHASE_ZOOM)
  near(cameraStep('out', STEP_S, 1, 1, true).zoom, 1 / CHASE_ZOOM)
  // Frame by frame it compounds to the same.
  near(cameraStep('in', STEP_S / 4, 1, 1, false).zoom ** 4, MAP_ZOOM)
  assert.equal(cameraStep('in', STEP_S, 1, 1, false).dx, 0)
  assert.equal(MAP_ZOOM, 2)
})
