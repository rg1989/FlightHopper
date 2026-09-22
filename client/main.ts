// client/main.ts
// Entry point loaded by index.html: settings from the Vite env (.env.local), then the app in #globe.
// A startup error (bad setting, terrain unreachable) is shown on the page, not only in the console.
import { startApp } from './app.ts'
import { readConfig } from './config.ts'

const root = document.getElementById('globe') ?? document.body
try {
  await startApp(root, readConfig(import.meta.env))
} catch (e) {
  const box = document.createElement('pre')
  box.style.cssText =
    'position:fixed;left:16px;right:16px;bottom:16px;z-index:20;margin:0;padding:8px 10px;border-radius:4px;' +
    'font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#fff;background:#8b1a1a'
  box.textContent = `FlightHopper could not start: ${e instanceof Error ? e.message : String(e)}`
  document.body.append(box)
  throw e
}
