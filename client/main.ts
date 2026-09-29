// client/main.ts
// Entry point loaded by index.html: the boot splash at once, then settings from the Vite env (.env.local) and the API
// keys saved in this browser (the Settings dialog; they win), and the app in #globe. The splash says what is loading
// and goes when the first aircraft arrive, or a ?scenario= link's scenario starts (or after FIRST_DATA_WAIT_MS: the map
// is usable, and the status icon tells the rest). A startup error (bad setting, terrain unreachable) stays on it, with
// Try again; offline, it says so and starts by itself when the network is back.
import { mountSplash } from './ui/splash.ts'

const FIRST_DATA_WAIT_MS = 12_000
const splash = mountSplash()
const root = document.getElementById('globe') ?? document.body
if (!navigator.onLine) {
  splash.offline()
  window.addEventListener('online', () => location.reload(), { once: true })
} else try {
  const [{ startApp }, { KEYS_KEY, readConfig, readSavedKeys }] = await Promise.all([import('./app.ts'), import('./config.ts')])
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(KEYS_KEY) // throws where storage is blocked: then the build's keys only
  } catch {
    // blocked: nothing saved
  }
  await startApp(root, readConfig(import.meta.env, readSavedKeys(saved)), { onFirstData: () => splash.done() })
  if (new URLSearchParams(location.search).has('scenario')) splash.set('Loading the scenario…', { skip: true })
  else splash.set('Connecting to live traffic…', { hint: 'The first answer from the flight-data source is slow; the map is ready.', skip: true })
  setTimeout(() => splash.done(), FIRST_DATA_WAIT_MS)
} catch (e) {
  splash.fail(e instanceof Error ? e.message : String(e))
  throw e
}
