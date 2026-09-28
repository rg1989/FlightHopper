# KC1388 package: how it was built

Air Astana Flight 1388, 11 November 2018, Embraer 190-100LR P4-KCJ (`public/scenarios/kc1388/`). The report does not
publish the flight recorder data as numbers, nor a transcript, so this package is a reconstruction (every track row is
`q=R`) and has no captions: the story messages quote the report.

Inputs (not in the repository; `.work/kc1388/sources/` in the main checkout):

- The GPIAAF final report 08/ACCID/2018 (PDF, 6.3 MB), from https://asn.flightsafety.org/reports/2018/20181111_E190_P4-KCJ.pdf.
- Flightradar24's `KC1388_1e84fc24.csv` (multilateration fixes) and `KC1388-Altitude-Only-Data.csv`, linked from its blog
  post (see `sources` in scenario.json). Their terms do not let us republish them.

Steps:

```bash
pdfimages -f 44 -l 44 -png gpiaaf-final-report.pdf fig        # Figure 13 is fig-004.png (912 × 730)
python3 tools/scenarios/kc1388/digitize_fig13.py fig-004.png > tools/scenarios/kc1388/fig13.csv
node tools/scenarios/kc1388/airports.ts                        # airport.json: Alverca and Beja
node tools/scenarios/kc1388/reconstruct.ts KC1388_1e84fc24.csv KC1388-Altitude-Only-Data.csv tools/scenarios/kc1388/fig13.csv
node --test client/scenario/format.test.ts
```

What the reconstruction does and does not know is in the header of `reconstruct.ts`. In short: the positions between
13:34 and 15:04 are FR24's, re-timed (its time stamps wander) and smoothed; the take-off and the three Beja approaches
are shaped from the report's times and figures; the attitude is what the path requires, far calmer than the real
flight; airspeed and load factor are the report's Figure 13, as 10-second averages.
