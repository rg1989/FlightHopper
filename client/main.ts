// client/main.ts
// Entry point loaded by index.html: the boot splash at once, then settings from the Vite env (.env.local) and the app in
// #globe. The splash says what is loading and goes when the first aircraft arrive (or after FIRST_DATA_WAIT_MS: the map
// is usable, and the status icon tells the rest). A startup error (bad setting, terrain unreachable) stays on it.
import { mountSplash } from './ui/splash.ts'

const FIRST_DATA_WAIT_MS = 12_000
const splash = mountSplash()
const root = document.getElementById('globe') ?? document.body
try {
  const [{ startApp }, { readConfig }] = await Promise.all([import('./app.ts'), import('./config.ts')])
  await startApp(root, readConfig(import.meta.env), { onFirstData: () => splash.done() })
  splash.set('Connecting to live traffic…')
  setTimeout(() => splash.done(), FIRST_DATA_WAIT_MS)
} catch (e) {
  splash.fail(`FlightHopper could not start: ${e instanceof Error ? e.message : String(e)}`)
  throw e
}
