# JAL123 CVR and radio transcript: sources for per-second captions

## Summary

- **Best primary source for timing: the JTSB 2011 commentary, Attachment 1 (別添1 時系列表).** It is a continuous timeline from 18:24:35 to 18:56:26. Every entry has an exact second (h’m”s) and a speaker code (CAP/COP/F/E), and the lines are in the original Japanese. It is on printed pp. 27–31 of https://jtsb.mlit.go.jp/kaisetsu/nikkou123-kaisetsu.pdf (3.6 MB, dated July 2011). The index page is https://jtsb.mlit.go.jp/kaisetsu/nikkou123.html.
- **Your dossier's master log has CVR times that are off by up to about 60 s.** The corrections are in §3.
- **Process note.** WebFetch could not read either PDF as text. It saved them automatically, outside the repo, to `<session cache>` (the commentary) and `.../webfetch-1790165515957-uya1rq.pdf` (the sakura PDF). I read those saved copies with `pdftotext` and Read. I did not use curl or wget, and I did not fetch the 57.7 MB report, any audio or any video. You may want to delete the two saved files.

## 1. Sources compared

| Source | Seconds on every line? | Scope | Reliability |
|---|---|---|---|
| **Official AAIC report, Attachment 6 (CVR record)**. Japanese report https://jtsb.mlit.go.jp/aircraft/rep-acci/62-2-JA8119.pdf, pp. ~309–343 (page range per the commentary text and [JFC](https://www.factcheckcenter.jp/fact-check/affairs/baseless-jal123-fake-voice-recorder/)). English report https://jtsb.mlit.go.jp/eng-air_report/JA8119.pdf, pp. 293–330 per your dossier. **Neither was fetched.** | Yes. Each minute is one page laid out on a 00–59 s grid, and times come from collating the ATC tape time signal with the CVR tape speed. I confirmed this from the legend in your OCR (Appendix D), not from the PDF. | Complete, 18:24:12–18:56:28, all channels, including cabin and other-traffic columns | Primary. The Japanese is the original; the English report's version is the AAIC's own translation. |
| **JTSB 2011 commentary, Attachment 1** (link above) | Yes, but several utterances share one timestamp (e.g. 25’53” holds 8 lines). Uncertain readings are underlined (the underlines are lost in text extraction). | Condensed. Radio and company calls are paraphrased in indirect Japanese, and cabin PA and +++ lines are mostly left out. | Primary. **Best spine for caption timing.** |
| **transportation.sakura.ne.jp** https://transportation.sakura.ne.jp/123accident/850812jal123cvr.pdf | Partly. It has an HH:MM:SS column plus a "file time" column (0:03–5:08). | Covers only the ~5-minute TBS *News 23* edit of the 32-minute audio. Gaps are marked 「ファイル編集により一部省略」 ("partly omitted by editing"). | Secondary, a listening transcript. Its file-time column maps the edited audio to real time, which is useful for syncing audio. Some readings differ from the official record (see §1a). |
| **planecrashinfo** https://www.planecrashinfo.com/cvr850812.htm | No. About 100 timestamps, one every few lines. | Cockpit only, no ATC or COM. No translator named. | Secondary. Has typos (18:49:49 is listed before 18:48:58), puts the bang at 18:24:34, and follows leaked-audio readings in places. |
| **tailstrike** https://tailstrike.com/database/12-august-1985-japan-airlines-123 | No. Minute headers only (18.24, 18.28, 18.47, 18.50). | Heavily condensed | Unreliable. GPWS is placed under 18.50, and the final line "It's the end" is not in the official record. |
| **English Wikipedia** https://en.wikipedia.org/wiki/Japan_Air_Lines_Flight_123 | No | Narrative, with few quotes: "But now uncontrol"; "This may be hopeless" at 18:46:33 | Condensed |
| **Japanese Wikipedia** https://ja.wikipedia.org/wiki/日本航空123便墜落事故 | Only for key lines | Narrative | Merges "まずい、何か爆発したぞ" ("Uh-oh, something exploded") at 18:24:35, but notes the report shows the final utterance as unintelligible |
| **Aviation Safety Network CVR page** (mail.aviation-safety.net/investigation/transcripts/cvr_ja123.php) | Unverified (HTTP 403) | — | — |
| **JAL Safety Promotion Center** | No online transcript found (unverified absence) | — | — |

### 1a. Fabricated or disputed content

- **Fabricated.** Pages claiming an "unedited full transcript" contain lines that appear in no official record: 被弾 ("we've been hit"), 戦闘機 ("fighter jets"), 撃ちやがった ("they fired on us"). Examples are https://note.com/honkakuhanonote/n/nfca14bf5dd99 and the 2025 YouTube video 「封印された言葉を解き放つ」. The Japan Fact-Check Center debunked them on 19 Aug 2025, checking against Attachment 6 and the commentary (https://www.factcheckcenter.jp/fact-check/affairs/baseless-jal123-fake-voice-recorder/).
- **Not identified.** I could not find the specific "1990s farewell transcript" your dossier warns about; treat it as unverified.
- **Readings from the leaked audio that differ from the official record** (sakura PDF and Japanese Wikipedia):
  - 18:24:35 「まずい」 ("uh-oh"): the official record has only an unintelligible mark.
  - 18:56:21 「もう、ダメだ！」 ("it's no use!"): the official record has 「・・・」 (unintelligible).
  - The sakura PDF's own note 7 says the TBS edit moved 「これはだめかも…」 ("this may be hopeless") out of its real place.
  - **Recommendation:** caption these as **[unintelligible]**.

## 2. Key lines: Japanese original, cross-checked times

Abbreviations for the sources:
- **K**: JTSB commentary, Attachment 1
- **T**: sakura TBS-audio PDF
- **P**: planecrashinfo
- **E**: English Attachment 6 OCR in your dossier
- **W**: Japanese Wikipedia
- **EW**: English Wikipedia

Where two sources disagree by 1–4 s, use the K time.

| Time (K) | Speaker → addressee / channel | Original (short fragment) | Second source |
|---|---|---|---|
| 18:24:35 | [bang] | — | T 18:24:35; P 18:24:34 |
| 18:24:37 | [takeoff / cabin-altitude horn, ~1 s] | — | T 0:06 |
| 18:24:39 | CAP → crew (cockpit) | 「なんか爆発したぞ。スコーク77」 ("Something exploded. Squawk 77") | E "(CAP) Something exploded? … Squawk 77"; T 18:24:39–42 |
| 18:24:44 | PRA (cabin PA) | [emergency descent / oxygen announcement] | P 18:24:44 |
| 18:24:46 | CAP 「エンジン？」 ("Engine?"); **COP** 「スコーク77」 ("Squawk 77"); F/E 「オールエンジン…」 ("All engines…") | T and P give "Squawk 77" to **CAP** (speaker dispute) | |
| 18:24:57 | COP → CAP | 「ハイドロプレッシャみませんか？」 ("Shall we check hydraulic pressure?") | P 18:24:54 (mistranslated as "dropped") |
| 18:25:16 | CAP → COP | 「ライトターン、ライトターン」 ("Right turn, right turn") | P 18:25:13–14 |
| 18:25:21 | CAP → ACC (radio, English) | Request 22,000 ft and return to Haneda | W 18:25:21; dossier |
| 18:25:40 / :52 | CAP ↔ ACC (radio, English) | Radar vector to Oshima; turn right; approved | dossier |
| 18:25:53 | CAP → COP | 「バンクそんなにとるな」 ("Don't bank so much") | T 18:25:53; P 18:25:50 |
| 18:26:00 | F/E → CAP | 「ハイドロプレッシャがおっこちています」 ("Hydraulic pressure is dropping") | T 18:26:00 |
| 18:26:11 | CAP 「戻せ」 ("Bring it back") / COP 「戻らない」 ("It won't come back") | | T 18:26:11; P 18:26:08 |
| 18:26:27 | CAP → F/E | 「ハイドロ全部だめ？」 ("All hydraulics gone?") | T 18:26:27; P 18:26:25 |
| 18:27:47 | F/E → CAP | 「ハイドロプレッシャ、オールロス」 ("Hydraulic pressure, all lost") | P 18:27:46 |
| 18:28:35 | CAP → ACC (radio, English) | "But now uncontrol" | E; EW. ACC called "JAPAN AIR 124" at 18:28:31 (sic, per E and EW) |
| 18:29:00 | CAP → COP | 「ストールするぞ、本当に」 ("We'll stall, really") | T 18:29:05 |
| 18:31:14 | ACC → CAP (radio, English) | "72 miles to Nagoya… land Nagoya?" → CAP "request back to Haneda" | E |
| 18:31:26 | ACC → CAP (radio) | "You may speak in Japanese from now on" | E; W |
| 18:33:35 | F/E → CAP | 「エマジェンシー・ディセンドやった方が…」 ("We should do an emergency descent…") | P 18:33:33 |
| 18:35:12 / :34 | F/E → COM (company radio, Japanese) | 「ジャパンエア東京…123 オーバー」 ("Japan Air Tokyo… 123, over"); then R5 door "broken" | P 18:35:00 |
| 18:45:46 | CAP → ACC (radio) | "Japan Air 123 uncontrollable" | E |
| 18:46:16 | CAP → ACC (radio, Japanese) | 「このままでお願いします」 ("Please stay with us") | E "Stay with us please" |
| 18:46:33 | CAP (cockpit) | 「これはだめかもわからんね」 ("This may be hopeless") | T and P 18:46:33; EW |
| 18:47:07 | ACC → CAP (radio, Japanese) | Runway 22, keep heading 090 | T 18:47:10 |
| 18:47:17 | ACC 「操縦できるか」 ("Can you control it?") → CAP | 「アンコントローラブル」 ("uncontrollable", said in English) | T 18:47:17 / 18:47:19 |
| 18:47:39 | CAP → COP | 「おい山だぞ」 ("Hey, there's a mountain") | T 18:47:39 |
| 18:47:52 | CAP → COP | 「山にぶつかるぞ」 ("We'll hit the mountain") | T 18:47:52 |
| 18:47:59 | CAP / COP | 「マックパワー」 ("Max power") | P 18:47:58 |
| 18:49:39 | CAP + [stall warning] | 「あーだめだ…ストール、マックパワー」 ("Ah, no good… stall, max power") | T 18:49:39 / 18:49:46; P 18:49:40 / 18:49:46. Minimum 108 kt at 49’42” (K) |
| 18:50:06 | CAP → COP | 「ドーンと行こうや」 ("Let's go at it boldly") | T 18:50:09 |
| 18:53:31 | CAP → ACC (radio) | "uncontrol" (third time) | W 18:53:30 |
| 18:53:51 | ACC → 119.7; CAP | 「はいはい119.7」 ("Yes, yes, 119.7") | E |
| 18:54:19 | APC → crew (radio, Japanese) | 55 NM NW of Haneda, 25 NM W of Kumagaya | T 18:54:55 F/E relays it; P 18:54:55 |
| 18:55:01 | CAP 「フラップ下りるね」 ("Flaps coming down?") / COP 「はい、フラップじゅう」 ("Yes, flaps ten") | | W 18:55:01 |
| 18:55:05 | APC → crew (radio, Japanese) | Haneda and Yokota both available (last exchange the crew acknowledged) | W |
| 18:55:15 | CAP → COP | 「あたま上げろ」 ("Raise the nose") | T; P 18:55:15 |
| 18:55:42 | COP 「パワー」 ("Power"); CAP 「フラップ止めな」 ("Stop the flaps") | | T 18:55:42; P 18:55:42 |
| 18:55:56 | CAP 「パワー、パワー、フラップ」 ("Power, power, flaps") / F/E 「上げてます」 ("Raising them") | | T 18:55:56 |
| 18:56:04 | CAP | 「あたま上げろ…パワー」 ("Raise the nose… power") | T 18:56:04 / 18:56:07 |
| 18:56:14 | [GPWS "Sink rate, whoop whoop pull up"] | — | T; P 18:56:14 |
| 18:56:23 / :26 / :28 | [first contact] / [impact] / [end of recording] | — | T; P (K gives :26) |

## 3. Corrections to your dossier's master log

- **"Squawk 77" at 18:24:35, "both pilots at once".** K gives CAP at 18:24:39 and COP at 18:24:46.
- **"Shall we check hydro pressure?" at 18:24:36.7.** K gives 18:24:57.
- **The 18:25:00–59 block** ("Hydraulic pressure has dropped… don't bank… turn it back… descend"). K spreads these over 18:25:53–18:26:31.
- **"Uncontrollable #3" at 18:53:51.** K gives 18:53:31; 18:53:51 is the frequency change to 119.7.
- **GPWS "SINK RATE" at 18:56:13.** K, T and P all give 18:56:14.
- **"Now uncontrollable" at 18:28:35.** This is a paraphrase. The words actually spoken on the radio were "But now uncontrol".

## 4. Speaker and channel conventions

**Official Attachment 6 legend** (your OCR of the Appendix D notes):

- **Speaker codes.** CAP, COP, F/E, PUR (purser), STH (stewardesses, including the assistant purser), PRA (pre-recorded announcement). On radio: ACC (Tokyo Area Control Center), APC (Tokyo Approach), YOK (Yokota Approach), COM (JAL company radio).
- **Marks.** "+++" means indecipherable. A bracket mark means simultaneous speech.
- **Sound symbols.** HI-CHIME, SELCAL, FIRE WARNING, STALL WARNING, GPWS, CABIN ALTITUDE / TAKEOFF WARNING, ALTITUDE ALERT.
- **Columns.** Time, Alarms, CVR Area Microphone, **"Co-pilot Seat (right) = Captain"**, **"Captain Seat (left) = Co-pilot"**, Flight Engineer Seat, and "Communication between other aircraft and ACC / COM".

**Seat swap.** Captain Takahama was the instructor in the right seat. First Officer Sasaki was flying from the left seat as a captain-upgrade trainee (Japanese Wikipedia; the Attachment 6 column headers). The commentary adds that the PRA and purser PAs are recorded on the co-pilot's channel, not the captain's.

**Addressees** are not written in the record; infer them from the channel:

- Radio columns: the crew speaks to ACC, APC or COM.
- The captain's commands (「あたま下げろ」 "lower the nose", 「あたま上げろ」 "raise the nose") go CAP → COP.
- 18:31:36–18:32:11: F/E on the cabin interphone. K notes the interphone call chime.
- 18:34–18:36: F/E ↔ COM.
- YOK: broadcasts to JAL123 on guard 121.5, never answered.
- Other aircraft ↔ ACC traffic is on the tape; show it dimmed or leave it out.

## 5. Radio language and how to mark translations

**Before 18:31:26.** All ATC traffic is in English.

**At 18:31:26.** ACC says "You may speak in Japanese from now on" and the captain agrees (K; E).

**After 18:31:26:**
- ACC, APC and COM speak Japanese. COM spoke Japanese throughout (K quotes it in Japanese).
- APC announced at 18:55:05 that it would speak Japanese (E).
- **Yokota stayed in English**; your OCR has "JAPAN AIR ONE TWENTY THREE… YOKOTA APPROACH on guard".
- The crew keeps English phraseology inside Japanese sentences: アンコントローラブル ("uncontrollable"), ラジャー ("roger"), 119.7.
- The cockpit is Japanese throughout, with many English words spoken as loanwords: ライトターン ("right turn"), マックパワー ("max power"), フラップアップ ("flaps up"), ストール ("stall"), スコーク77 ("squawk 77").

In the English report, the Japanese lines appear only in English. Whether it marks them as translated line by line is **unverified**: your OCR shows no such marker.

**Caption convention I recommend:**
1. **Lines spoken in English:** show verbatim with no tag (e.g. "But now uncontrol").
2. **Lines translated from Japanese:** show the English caption with a small "JA" badge (or "(translated)"), and the original Japanese underneath.
3. **English loanwords inside Japanese:** keep them as spoken ("Right turn!") and tag them "(said in English)".
4. **Unintelligible audio** (+++ or ･･･): show "[unintelligible]". Never fill in with 「もうダメだ」 or 「まずい」.
5. **Uncertain readings** (underlined in K): mark with "(?)" or italics.
6. **Sources:** give each line a source field, e.g. `K p.27 24’39”`.

**Audio sync.** The publicly circulating audio is TBS's 5-minute edit of the 32-minute recording (sakura PDF, note 3). It is not continuous. Use the sakura PDF's file-time column to map each edit segment to its real time. The ATC audio was published separately (sakura PDF, note 6).