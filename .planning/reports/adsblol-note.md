<!-- .planning/reports/adsblol-note.md -->
# Courtesy note to adsb.lol (draft)

You send this yourself, from the address in `CONTACT` (`.env.local`). Nothing in this project sends it.

- **To:** `info@adsb.lol`. This is the public email of the adsb.lol GitHub organisation (github.com/adsblol, read through api.github.com/orgs/adsblol on 2026-09-22). adsb.lol itself was not opened, because all of this project's adsb.lol traffic belongs to the recorder.
- **Subject:** FlightHopper, a small personal project using api.adsb.lol

---

Hi,

I am building FlightHopper, a personal, non-commercial 3D flight viewer (CesiumJS) for myself and a few friends. It reads your public API, and I want to stay well inside what you are comfortable with.

- **Endpoints:** `/v2/point/{lat}/{lon}/{radius}` (40 nm circles around KSFO, LLBG and LOWI, and circles of at most 250 nm around the area a viewer is looking at, only while someone looks), and batched `/v2/hex/{hex1,hex2,…}` (at most 100 hexes) for the aircraft being followed.
- **Identification:** every request sends `User-Agent: FlightHopper/0.1 (+CONTACT)`, where CONTACT is the address I am writing from, and `Accept-Encoding: gzip`.
- **Rate:** about one request every 12 s (≈ 0.08 req/s) in total, from all my processes together. Your API answered 429 when my first recorder polled every 2–7 s, so that is where it settled. On a 429 my code slows down, honours Retry-After and never speeds back up; on 401 or 403 it stops and does not retry.
- **Question:** what sustained rate is acceptable for a single personal client like this? I would rather ask than find out by testing your limits.
- **Attribution:** the app shows "adsb.lol (ODbL 1.0)" on screen. Recordings stay on my machine, except small test fixtures, which carry the ODbL notice.
- **Feeding:** I am setting up my own ADS-B receiver (readsb) and will feed adsb.lol with it soon.

If you prefer a different rate or other endpoints, or want me to use a key once I feed, tell me and I will change it.

Thank you for running adsb.lol.

Best regards,
