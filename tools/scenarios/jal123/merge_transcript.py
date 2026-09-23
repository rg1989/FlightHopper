# tools/scenarios/jal123/merge_transcript.py
# Merges the JAL 123 transcript fragments into public/scenarios/jal123/transcript.csv, checks every row against the
# package contract, and cross-checks the key lines against the JTSB 2011 commentary times (cvr.md §2).
"""
    /usr/bin/python3 tools/scenarios/jal123/merge_transcript.py [--work <FlightHopper>/.work/jal123] [--check]

Input: every `transcript/*.csv` in the work folder (git-ignored; `--work`, `$JAL123_WORK` or `<repo>/.work/jal123`),
read in file-name order. Each fragment has the columns of spec §3.5 and may add `x_` columns. The speaker codes and
source ids come from `public/scenarios/jal123/scenario.json`, so the check is the package's own contract.

Steps:
1. Read each fragment by column name. The output has the spec columns, then every `x_` column any fragment has.
2. Normalise (each change is printed): the SELCAL label to `[SELCAL]`; `x_unclear` = 1 on the readings the record
   underlines, for fragments written before that column existed (UNCLEAR, from the D2a and D2b reports).
3. Check every row: time, speaker and addressee codes, channel, language, `q` rules, source id, no raw `・・・`/`+++`,
   no reading from leaked audio, nothing starting before `start` or still on screen at `ending.darkAt`.
4. Sort by time (stable: rows of one second keep their order), reject duplicates, warn when one speaker has two lines
   less than 0.3 s apart.
5. Cross-check KEYS: each key line must be within 3 s of its time. Two times printed in cvr.md §2 are wrong and are
   corrected in KEYS (see the comments there); the data follows the official record.

Exit 0 and write the output when there is no error; exit 1 and write nothing otherwise. `--check` never writes.
Doctests: /usr/bin/python3 -m doctest tools/scenarios/jal123/merge_transcript.py
"""
import argparse
import csv
import io
import json
import os
import re
import sys
from pathlib import Path

COLUMNS = ['time', 'dur', 'speaker', 'to', 'channel', 'lang', 'text', 'original', 'q', 'src']
CHANNELS = {'cockpit', 'radio', 'company', 'cabin', 'interphone', 'alert'}
LANGS = {'', 'en', 'ja'}  # '' = no speech (a sound, or wholly unintelligible)
TOLERANCE_S = 3.0  # a key line further than this from its time is an error
SAME_SPEAKER_S = 0.3  # two lines of one speaker closer than this: a warning (a split or a duplicate)

# Readings the fabricated "full transcripts" and the leaked audio use, which the official record does not have
# (cvr.md §1a). None may appear in a caption: the record marks those passages unintelligible.
BANNED = [r'もう\s*、?\s*だめ', r'もう\s*、?\s*ダメ', r'まずい', r'被弾', r'戦闘機', r'撃ち', r'mou\s*dame',
          r"it'?s the end", r'contact sound', r'衝撃音', r'\bimpact\b', r'<end of recording>']

# Readings the record underlines (uncertain), for fragments without an x_unclear column: (fragment, time, speaker).
# From the D2a report (decision 7) and the D2b report ("Uncertain readings"). Wording only: an underlined speaker code
# is not marked, as in c.csv.
UNCLEAR = [
    ('a', '18:24:39', 'CAP'), ('a', '18:24:46', 'CAP'), ('a', '18:24:48', 'FE'), ('a', '18:24:51', 'COP'),
    ('a', '18:24:55', 'FE'), ('a', '18:25:55', 'CAP'), ('a', '18:27:31', 'CAP'), ('a', '18:29:01', 'FE'),
    ('a', '18:29:06', 'COP'), ('a', '18:30:35', 'FE'), ('a', '18:31:46', 'CAP'), ('a', '18:31:50', 'FE'),
    ('a', '18:33:17', 'FE'), ('a', '18:33:23', 'FE'),
    ('b', '18:34:21', 'CAP'), ('b', '18:34:59', 'CAP'), ('b', '18:35:01', 'CAP'), ('b', '18:37:04', 'CAP'),
    ('b', '18:41:07', 'CAP'), ('b', '18:45:18', 'CAP'), ('b', '18:45:52', 'CAP'), ('b', '18:45:54', 'FE'),
]

# Key lines of cvr.md §2 (JTSB commentary 別添1 times, "K"): (time, speaker, pattern, what). The pattern is searched in
# `original`, then in `text`. Not keyed: the bang at 18:24:35 (not a caption: the failure event covers it) and the
# contact, impact and end of recording at 18:56:23-28 (never captioned; step 3 checks nothing is on screen then).
KEYS = [
    ('18:24:37', 'ALARM', r'Cabin altitude', 'cabin-altitude / take-off horn'),
    ('18:24:39', 'CAP', r'爆発したぞ', '"Something exploded"'),
    # cvr.md names the speaker PRA; the record prints this oxygen-mask announcement as PUR. Same time.
    ('18:24:44', 'PUR', r'酸素マスク', 'oxygen-mask announcement'),
    ('18:24:46', 'CAP', r'^エンジン', '"Engine?"'),
    ('18:24:46', 'COP', r'スコーク77', '"Squawk 77"'),
    ('18:24:46', 'FE', r'オールエンジン', '"All engines"'),
    ('18:24:57', 'COP', r'ハイドロプレッシャみませんか', '"Shall we check hydraulic pressure?"'),
    ('18:25:16', 'CAP', r'ライトターン', '"Right turn"'),
    ('18:25:21', 'CAP', r'request', 'request to return to Haneda'),
    ('18:25:40', 'CAP', r'Radar vector to OSHIMA', 'radar vector to Oshima'),
    ('18:25:52', 'CAP', r'^090', 'heading 090'),
    ('18:25:53', 'CAP', r'バンク', '"Don\'t bank so much"'),
    ('18:26:00', 'FE', r'ハイドロプレッシャがおっこち', '"Hydraulic pressure is dropping"'),
    ('18:26:11', 'CAP', r'^戻せ', '"Turn it back"'),
    ('18:26:11', 'COP', r'戻らない', '"It doesn\'t go back"'),
    ('18:26:27', 'CAP', r'ハイドロ全部', '"Hydro all out?"'),
    ('18:27:47', 'FE', r'オールロス', '"Hydraulic pressure, all lost"'),
    ('18:28:31', 'ACC', r'JAPAN AIR 124', 'ACC calls "JAPAN AIR 124"'),
    ('18:28:35', 'CAP', r'uncontrol', '"But now uncontrol"'),
    # cvr.md §2 prints 18:29:00. The record has this line on row 05 of the 18:29 page (EN p.300, JA p.316); row 00 is
    # 「気合を入れろ」. cvr.md's own second source (T) gives 18:29:05. Corrected here, not in the data.
    ('18:29:05', 'CAP', r'ストールするぞ', '"It\'ll stall, really"'),
    ('18:31:14', 'ACC', r'72 miles', '72 miles to Nagoya'),
    ('18:31:26', 'ACC', r'Japanese', '"You may speak in Japanese"'),
    ('18:33:35', 'FE', r'エマジェンシーディセント', '"We\'d better make an emergency descent"'),
    ('18:35:12', 'FE', r'123 over', '"Japan Air Tokyo ... 123 over"'),
    ('18:35:34', 'FE', r'ブロークン', 'R5 door "has broken"'),
    ('18:45:46', 'CAP', r'uncontrollable', '"Japan Air 123 uncontrollable"'),
    ('18:46:16', 'CAP', r'このままでお願いします', '"Stay with us please"'),
    ('18:46:33', 'CAP', r'だめかもわからん', '"This may be hopeless"'),
    ('18:47:07', 'ACC', r'ランウエイ22', 'runway 22, keep heading 090'),
    ('18:47:17', 'ACC', r'コントロールできますか', '"Can you control the aircraft now?"'),
    ('18:47:17', 'CAP', r'アンコントローラブル', '"It\'s uncontrollable"'),
    ('18:47:39', 'CAP', r'山だぞ', '"Hey, mountain"'),
    ('18:47:52', 'CAP', r'山にぶつかる', '"We\'ll hit a mountain"'),
    ('18:47:59', 'CAP', r'マックパワー', '"Max power"'),
    ('18:49:39', 'CAP', r'だめだ', '"Ah, no good"'),
    ('18:50:06', 'CAP', r'どーんといこう', '"Let\'s give it a try"'),
    ('18:53:31', 'CAP', r'アンコントロール', '"Uncontrol" (radio)'),
    ('18:53:51', 'CAP', r'119てん7', '"Yes, yes, 119.7"'),
    # cvr.md §2 prints 18:54:19 for this call. The record (EN p.325, JA p.341) has the F/E's check-in on 119.7 at
    # 18:54:19, APC's "45 miles" at 18:54:30 and this 55 NM / 25 NM west of Kumagaya position on row 42. The row mixed
    # the time of the check-in with the words of the later call. Corrected here, not in the data.
    ('18:54:42', 'APC', r'55マイル', 'position 55 NM NW, 25 NM west of Kumagaya'),
    ('18:55:01', 'CAP', r'フラップおりる', '"Can you extend flap"'),
    ('18:55:01', 'COP', r'フラップじゅう', '"Yes, flap 10"'),
    ('18:55:05', 'APC', r'日本語で申しあげます', 'Haneda and Yokota ready (last exchange acknowledged)'),
    ('18:55:15', 'CAP', r'あたま上げろ', '"Raise the nose"'),
    ('18:55:42', 'COP', r'^パワー', '"Power"'),
    ('18:55:42', 'CAP', r'フラップとめ', '"Halt the flap"'),
    ('18:55:56', 'CAP', r'^パワー', '"Power"'),
    ('18:55:56', 'FE', r'あげてます', '"It is up"'),
    ('18:56:04', 'CAP', r'あたま上げろ', '"Raise the nose"'),
    ('18:56:14', 'GPWS', r'SINK RATE', 'GPWS "SINK RATE"'),
]

CLOCK_RE = re.compile(r'^(\d+):([0-5]\d):([0-5]\d)(\.\d+)?$')
SRC_RE = re.compile(r'^([A-Za-z0-9]+)(:p\.\d+(-\d+)?)?$')


def secs(clock):
    """'HH:MM:SS[.s]' -> seconds of the day; ValueError when malformed.

    >>> secs('18:24:35')
    66275.0
    >>> secs('18:24:35.5')
    66275.5
    """
    m = CLOCK_RE.match(clock)
    if not m:
        raise ValueError('bad time %r' % clock)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + float(m.group(4) or 0)


def est_dur(text):
    """The loader's on-screen time for an empty `dur` (client/scenario/format.ts): 1.2 + 0.06 s per character, 2.5-8 s.

    >>> est_dur('Yes.')
    2.5
    >>> est_dur('x' * 200)
    8.0
    """
    return min(8.0, max(2.5, 1.2 + 0.06 * len(text)))


def on_screen(row):
    """Seconds the caption stays up: `dur` when given, else the loader's estimate.

    >>> on_screen({'dur': '5', 'text': 'Yes.'})
    5.0
    >>> on_screen({'dur': '', 'text': 'Yes.'})
    2.5
    """
    return float(row['dur']) if row['dur'] else est_dur(row['text'])


def normalise(row, frag, has_unclear, log):
    """Applies the fixed normalisations to one row in place; appends what changed to `log`.

    >>> r = {'time': '18:34:07', 'speaker': 'SELCAL', 'text': 'SELCAL'}
    >>> log = []; normalise(r, 'b', True, log); r['text'], len(log)
    ('[SELCAL]', 1)
    >>> r = {'time': '18:34:21', 'speaker': 'CAP', 'text': 'Stick with it.'}
    >>> normalise(r, 'b', False, []); r['x_unclear']
    '1'
    """
    if row['speaker'] == 'SELCAL' and row['text'] == 'SELCAL':
        row['text'] = '[SELCAL]'
        log.append('%s %s SELCAL: text "SELCAL" -> "[SELCAL]"' % (frag, row['time']))
    if not has_unclear:
        row['x_unclear'] = '1' if (frag, row['time'], row['speaker']) in UNCLEAR_SET else ''


UNCLEAR_SET = set(UNCLEAR)


def check_row(row, where, speakers, sources, start, dark_at, errors):
    """Checks one row against the package contract (spec §3.5, §7); appends messages to `errors`.

    >>> errs = []
    >>> row = dict(time='18:30:00', dur='', speaker='CAP', to='', channel='cockpit', lang='', text='[unintelligible]',
    ...            original='', q='U', src='EN:p.301')
    >>> check_row(row, 'a:2', {'CAP'}, {'EN'}, 0, 1e9, errs); errs
    []
    >>> row.update(q='D', text='もうだめだ', lang='xx', src='ZZ:p.1')
    >>> check_row(row, 'a:2', {'CAP'}, {'EN'}, 0, 1e9, errs); len(errs)
    3
    """
    def err(msg):
        errors.append('%s %s %s: %s' % (where, row.get('time', ''), row.get('speaker', ''), msg))

    try:
        t = secs(row['time'])
    except ValueError as e:
        err(str(e))
        return
    if t < start:
        err('before the scenario start')
    if row['dur'] and not (re.match(r'^\d+(\.\d+)?$', row['dur']) and float(row['dur']) > 0):
        err('dur must be a positive number or empty: %r' % row['dur'])
    elif t + on_screen(row) > dark_at + 1e-9:
        err('still on screen at ending.darkAt (%.1f s past it)' % (t + on_screen(row) - dark_at))
    if row['speaker'] not in speakers:
        err('unknown speaker code')
    if row['to'] and row['to'] not in speakers:
        err('unknown addressee %r' % row['to'])
    if row['to'] and row['to'] == row['speaker']:
        err('speaker addresses itself')
    if row['channel'] not in CHANNELS:
        err('bad channel %r' % row['channel'])
    if row['lang'] not in LANGS:
        err('bad lang %r' % row['lang'])
    if row['q'] not in ('D', 'T', 'U'):
        err('bad q %r' % row['q'])
    if row['q'] == 'U' and (row['text'] != '[unintelligible]' or row['original'] or row['lang']):
        err('q=U needs text [unintelligible], no original and no lang')
    if row['lang'] == 'ja' and not row['original']:
        err('lang ja without the original words')
    if row['lang'] != 'ja' and row['original']:
        err('an original but lang %r' % row['lang'])
    if not row['text']:
        err('empty text')
    if re.search(r'・・・|\+\+\+|· · ·', row['text']):
        err('raw unintelligible mark left in text')
    for pat in BANNED:
        if re.search(pat, row['text'] + ' ' + row['original'], re.IGNORECASE):
            err('banned reading %r (not in the official record)' % pat)
    m = SRC_RE.match(row['src'])
    if not m:
        err('bad src %r' % row['src'])
    elif m.group(1) not in sources:
        err('unknown source %r' % m.group(1))
    if row.get('x_unclear', '') not in ('', '1'):
        err('x_unclear must be 1 or empty')


def key_hits(rows, keys):
    """For each key, the nearest row of that speaker whose original or text matches: (key, row or None, offset s).

    >>> rows = [{'time': '18:29:00', 'speaker': 'CAP', 'original': '気合を入れろ', 'text': ''},
    ...         {'time': '18:29:05', 'speaker': 'CAP', 'original': 'ストールするぞほんとうに', 'text': ''}]
    >>> [(k[0], off) for k, _, off in key_hits(rows, [('18:29:05', 'CAP', 'ストール', '')])]
    [('18:29:05', 0.0)]
    """
    out = []
    for key in keys:
        t, spk, pat, _ = key
        best, off = None, None
        for r in rows:
            if r['speaker'] != spk:
                continue
            if not (re.search(pat, r['original']) or re.search(pat, r['text'])):
                continue
            d = secs(r['time']) - secs(t)
            if off is None or abs(d) < abs(off):
                best, off = r, d
        out.append((key, best, off))
    return out


def merge(work, manifest_path):
    """Reads, normalises, checks and sorts the fragments. Returns (rows, columns, errors, warnings, log, keys)."""
    manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    speakers = set(manifest['speakers'])
    sources = {s['id'] for s in manifest['sources']}
    start = secs(manifest['start'])
    dark_at = secs(manifest['ending']['darkAt']) if manifest.get('ending') else secs(manifest['end'])

    errors, warnings, log = [], [], []
    frags = sorted(Path(work, 'transcript').glob('*.csv'))
    if not frags:
        errors.append('no fragments in %s' % Path(work, 'transcript'))
    rows, xcols, spans = [], [], []
    for path in frags:
        frag = path.stem
        with open(path, encoding='utf-8', newline='') as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames or []
            missing = [c for c in COLUMNS if c not in header]
            unknown = [c for c in header if c not in COLUMNS and not c.startswith('x_')]
            if missing or unknown:
                errors.append('%s: header: missing %s, unknown %s' % (path.name, missing, unknown))
                continue
            has_unclear = 'x_unclear' in header
            for c in header + ([] if has_unclear else ['x_unclear']):
                if c.startswith('x_') and c not in xcols:
                    xcols.append(c)
            times = []
            for i, row in enumerate(reader, start=2):
                if None in row or any(v is None for v in row.values()):
                    errors.append('%s:%d: wrong number of cells' % (path.name, i))
                    continue
                normalise(row, frag, has_unclear, log)
                check_row(row, '%s:%d' % (path.name, i), speakers, sources, start, dark_at, errors)
                row['_where'] = '%s:%d' % (path.name, i)
                rows.append(row)
                try:
                    times.append(secs(row['time']))
                except ValueError:
                    pass
            if times:
                spans.append((min(times), max(times), path.name))
            if not has_unclear:
                used = {(frag, r['time'], r['speaker']) for r in rows if r.get('x_unclear') == '1'}
                for k in UNCLEAR:
                    if k[0] == frag and k not in used:
                        errors.append('%s: UNCLEAR entry %s %s matches no row' % (path.name, k[1], k[2]))

    spans.sort()
    for (a0, a1, an), (b0, b1, bn) in zip(spans, spans[1:]):
        if b0 <= a1:
            warnings.append('%s and %s overlap in time (%s-%s): check for duplicated lines' % (an, bn, clock(b0), clock(a1)))

    ok_rows = [r for r in rows if CLOCK_RE.match(r['time'])]
    ok_rows.sort(key=lambda r: secs(r['time']))  # stable
    seen = {}
    last_by_speaker = {}
    for r in ok_rows:
        k = (r['time'], r['speaker'], r['text'])
        if k in seen:
            errors.append('%s duplicates %s: %s %s %r' % (r['_where'], seen[k], r['time'], r['speaker'], r['text']))
        seen[k] = r['_where']
        t = secs(r['time'])
        prev = last_by_speaker.get(r['speaker'])
        if prev is not None and t - secs(prev['time']) < SAME_SPEAKER_S:
            warnings.append('%s %s %s: %.1f s after the same speaker\'s line %s' % (
                r['_where'], r['time'], r['speaker'], t - secs(prev['time']), prev['_where']))
        last_by_speaker[r['speaker']] = r

    keys = key_hits(ok_rows, KEYS)
    for (t, spk, pat, what), hit, off in keys:
        if hit is None:
            errors.append('key %s %s %s: no matching line' % (t, spk, what))
        elif abs(off) > TOLERANCE_S:
            errors.append('key %s %s %s: nearest line at %s, off by %+.0f s' % (t, spk, what, hit['time'], off))
    return ok_rows, COLUMNS + xcols, errors, warnings, log, keys


def clock(t):
    """Seconds of the day -> 'HH:MM:SS'.

    >>> clock(66275)
    '18:24:35'
    """
    t = int(round(t))
    return '%02d:%02d:%02d' % (t // 3600, t % 3600 // 60, t % 60)


def to_csv(rows, columns):
    """RFC 4180 text with LF line ends, the given columns in order.

    >>> to_csv([{'time': '18:11:20', 'text': 'a, b'}], ['time', 'text'])
    'time,text\\n18:11:20,"a, b"\\n'
    """
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(columns)
    for r in rows:
        w.writerow([r.get(c, '') for c in columns])
    return buf.getvalue()


def main(argv=None):
    here = Path(__file__).resolve()
    repo = here.parents[3]
    ap = argparse.ArgumentParser(description='merge and check the JAL 123 transcript fragments')
    ap.add_argument('--work', default=os.environ.get('JAL123_WORK', str(repo / '.work' / 'jal123')),
                    help='the git-ignored work folder (transcript/ inside); default $JAL123_WORK or <repo>/.work/jal123')
    ap.add_argument('--manifest', default=str(repo / 'public' / 'scenarios' / 'jal123' / 'scenario.json'))
    ap.add_argument('--out', default=str(repo / 'public' / 'scenarios' / 'jal123' / 'transcript.csv'))
    ap.add_argument('--check', action='store_true', help='check only; write nothing')
    args = ap.parse_args(argv)

    rows, columns, errors, warnings, log, keys = merge(args.work, args.manifest)
    for line in log:
        print('normalised  ' + line)
    print('key lines (cvr.md §2, corrected as commented in KEYS):')
    for (t, spk, _pat, what), hit, off in keys:
        at = hit['time'] if hit else '--:--:--'
        mark = '' if hit is not None and abs(off) <= TOLERANCE_S else '  ** ERROR'
        print('  %s %-5s ours %s (%s)  %s%s' % (t, spk, at, '%+.0f s' % off if hit else 'none', what, mark))
    for w in warnings:
        print('warning  ' + w)
    for e in errors:
        print('ERROR  ' + e)
    counts = {}
    for r in rows:
        counts[r['q']] = counts.get(r['q'], 0) + 1
    print('%d rows, %s .. %s, q %s; %d error(s), %d warning(s)' % (
        len(rows), rows[0]['time'] if rows else '-', rows[-1]['time'] if rows else '-',
        ' '.join('%s=%d' % kv for kv in sorted(counts.items())), len(errors), len(warnings)))
    if errors:
        print('not written: fix the errors first')
        return 1
    if args.check:
        return 0
    Path(args.out).write_text(to_csv(rows, columns), encoding='utf-8')
    print('wrote %s' % args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
