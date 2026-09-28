#!/usr/bin/env python3
# tools/scenarios/voiceover.py
"""
A scenario's voice-over: its transcript read by synthetic voices (Kokoro-82M), each line in the delivery its moment
calls for (calm to shouted), each channel with its sound (radio, interphone, cabin PA, cockpit), and the alerts the
record names synthesized (horn, chime, stick shaker, GPWS). One track, the scenario's audio.file, from its single clip's
start; it plays with the timeline. It is a reenactment, not the recording: the app labels it (audio.reenacted).

Setup, once (offline from the uv cache on the machine that built JAL 123; online elsewhere):
  uv venv --python 3.11 .work/tts
  uv pip install --python .work/tts/bin/python kokoro==0.9.4 soundfile \
    "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
Run:
  HF_HUB_OFFLINE=1 PYTORCH_ENABLE_MPS_FALLBACK=1 .work/tts/bin/python tools/scenarios/voiceover.py \
    public/scenarios/jal123 tools/scenarios/jal123/voices.json [--plan]
  python3 tools/scenarios/voiceover.py --selftest
--plan prints every line as it will be spoken, with its delivery, and writes nothing. Spoken clips are cached in
.work/voice-cache, so a second run only mixes. VOICE_SHARD=i/n speaks only every n-th line from the i-th and mixes
nothing: run n of them side by side (TTS_THREADS=2 each), then once without it to mix.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 24_000
REPO = 'hexgrad/Kokoro-82M'
CACHE = Path(__file__).resolve().parents[2] / '.work' / 'voice-cache'

# delivery → (Kokoro speed, gain dB, effort 0..1: the brighter, driven edge of a raised voice). Kokoro cannot yell:
# 'shout' is louder, faster and harder, not a true shout.
LEVELS = {
    'quiet': (0.93, -3.0, 0.0),
    'calm': (1.0, 0.0, 0.0),
    'firm': (1.04, 1.0, 0.0),
    'urgent': (1.1, 3.5, 0.3),
    'shout': (1.15, 6.0, 1.0),
}
COMMAND = re.compile(r'(?i)\b(nose|power|max|pull up|turn|stall|mountain|flap|push|both hands|stick with it|keep trying|'
                     r'descen|bank|check gear|squawk|exploded|hit|raise|lower|halt|stop|hold|control)')
ALARMED = re.compile(r"(?i)\b(no good|hopeless|uncontrol|losing|lost|loss|won't|doesn't|can't|heavy|speed|dropped)")
GENTLE = re.compile(r'(?i)\b(slightly|a little|carefully)\b')
ANSWER = re.compile(r'(?i)^(yes|roger|ok)\b')
ONLY_CRIES = re.compile(r'(?i)^[\s,.!?—-]*((oh|ah|eh|uh|hey)[\s,.!?—-]*)+$')
FILLER = re.compile(r"(?i)(?<![\w'])(eh+|ah+|er+|uh+|um+)(?![\w'])[,.]?")
KEEP_CAPS = {'ATC', 'JAL', 'DME', 'VOR', 'ILS', 'OK', 'R5', 'PO2'}
DIG = 'zero one two three four five six seven eight nine'.split()


def clock(s: str) -> float:
    h, m, sec = s.split(':')
    return int(h) * 3600 + int(m) * 60 + float(sec)


def digits(s: str) -> str:
    return ' '.join(DIG[int(c)] for c in s)


def say_numbers(t: str) -> str:
    """Radio style: 13,000 → one three thousand, 9,400 → nine four zero zero, 119.7 → one one nine decimal seven,
    15L → one five left, 123 → one two three, 16 → one six."""
    t = re.sub(r'\b(\d{1,3}),000\b', lambda m: f'{digits(m[1])} thousand', t)
    t = re.sub(r'\b(\d{1,3}),(\d{3})\b', lambda m: digits(m[1] + m[2]), t)
    t = re.sub(r'\b(\d+)\.(\d+)\b', lambda m: f'{digits(m[1])} decimal {digits(m[2])}', t)
    t = re.sub(r'\b(\d{2})([LRC])\b', lambda m: f"{digits(m[1])} {dict(L='left', R='right', C='center')[m[2]]}", t)
    return re.sub(r'\b\d{2,}\b', lambda m: digits(m[0]), t)


def speakable(text: str, radio: bool) -> str:
    """The words to speak: no [bracketed] notes, cut-off words or fillers, names in title case; '' when nothing is left
    or only cries are ('Ah, ah, ah': a synthetic cry would ring false)."""
    t = re.sub(r'\[[^\]]*\]', ' ', text)
    t = re.sub(r'\b\w{1,2}--', ' ', t).replace('—', ' ').replace('₂', '2')
    t = re.sub(r'-{2,}', ' ', t)
    t = re.sub(r'(?i)\b(squawk) (\d+)', lambda m: f'{m[1]} {digits(m[2])}', t)
    t = re.sub(r'\bMax\.', 'Max', t)
    if ONLY_CRIES.match(t):
        return ''
    t = FILLER.sub(',', t)
    if radio:
        t = say_numbers(t)
    t = re.sub(r'\b[A-Z][A-Z0-9]+\b', lambda m: m[0] if m[0] in KEEP_CAPS else m[0].title(), t)
    t = re.sub(r'\s*,[\s,]*', ', ', re.sub(r'\s+', ' ', t)).strip(' ,')
    t = re.sub(r'^[,.\s]+', '', t)
    return t if re.search(r'[A-Za-z0-9]', t) else ''


def delivery(time: str, speaker: str, channel: str, text: str, cfg: dict) -> str:
    """The line's delivery: the cast file's own call first, then the moment (routine before the failure, shouting in the
    last minutes), the channel (cabin and radio never shout) and the words (commands, alarm)."""
    own = cfg['delivery'].get(f'{time} {speaker}')
    if own:
        return own
    t = clock(time)
    if speaker in cfg['calm'] or t < clock(cfg['failureAt']):
        return 'calm'
    if channel in ('cabin', 'interphone'):
        return 'firm'
    if COMMAND.search(text):
        mild = channel != 'cockpit' or GENTLE.search(text) or ANSWER.match(text) or text.rstrip().endswith('?')
        return 'urgent' if mild or t < clock(cfg['shoutFrom']) or len(text.split()) > 6 else 'shout'
    if ALARMED.search(text) or text.rstrip().endswith('?'):
        return 'urgent'
    return 'firm'


# ---------- sound ----------

def band(x: np.ndarray, lo: float | None, hi: float | None) -> np.ndarray:
    """Zero-phase band-pass through the FFT, fourth-order-like edges."""
    n = len(x)
    size = 1 << (n + SR // 4).bit_length()
    f = np.fft.rfftfreq(size, 1 / SR)
    g = np.ones_like(f)
    if lo:
        g /= 1 + (lo / np.maximum(f, 1.0)) ** 4
    if hi:
        g /= 1 + (f / hi) ** 4
    return np.fft.irfft(np.fft.rfft(x, size) * g, size)[:n]


def drive(x: np.ndarray, k: float) -> np.ndarray:
    peak = max(float(np.abs(x).max()), 1e-9)
    return np.tanh(k * x / peak) / np.tanh(k) * peak


def level(x: np.ndarray, db: float) -> np.ndarray:
    rms = max(float(np.sqrt(np.mean(x ** 2))), 1e-9)
    return x * (10 ** ((-20 + db) / 20) / rms)


def trim(x: np.ndarray) -> np.ndarray:
    on = np.flatnonzero(np.abs(x) > 0.006)
    return x if on.size == 0 else x[max(on[0] - SR // 40, 0): on[-1] + SR // 25]


def delay(x: np.ndarray, s: float, g: float) -> np.ndarray:
    d = int(s * SR)
    return np.concatenate([np.zeros(d), x])[: len(x)] * g


RNG = np.random.default_rng(123)


def channel_fx(x: np.ndarray, ch: str) -> np.ndarray:
    """What the listener hears through: radio (narrow, driven, hiss, a squelch tail), the interphone, the cabin PA (a
    little room), the cockpit (as is)."""
    if ch in ('radio', 'company'):
        y = drive(band(x, 320, 2900), 2.2)
        y = np.concatenate([np.zeros(SR // 20), y, np.zeros(SR // 8)])
        hiss = band(RNG.standard_normal(len(y)), 500, 4000)
        hiss *= 0.012 / max(float(np.sqrt(np.mean(hiss ** 2))), 1e-9)
        hiss[-SR // 8:] *= 2.5  # the squelch as the key is let go
        return y + hiss * float(np.sqrt(np.mean(y ** 2))) * 6
    if ch == 'interphone':
        return drive(band(x, 300, 3400), 1.5)
    if ch == 'cabin':
        y = band(x, 250, 4000)
        return drive(y + delay(y, 0.06, 0.35) + delay(y, 0.13, 0.18), 1.2)
    return band(x, 90, None)


def effort(x: np.ndarray, e: float) -> np.ndarray:
    """A raised voice: more presence (1.8–4.5 kHz) and a harder edge."""
    return x if e <= 0 else drive(x + 0.8 * e * band(x, 1800, 4500), 1 + 1.2 * e)


def ramp(n: int, s: float = 0.005) -> np.ndarray:
    k = max(int(s * SR), 1)
    env = np.ones(n)
    env[:k] = np.linspace(0, 1, k)
    env[-k:] = np.linspace(1, 0, k)
    return env


def horn(s: float) -> np.ndarray:
    """The 747's intermittent horn (cabin altitude, or take-off configuration): a harsh buzz, 0.28 s on, 0.22 s off."""
    t = np.arange(int(s * SR)) / SR
    buzz = 0.65 * np.sign(np.sin(2 * np.pi * 480 * t)) + 0.35 * np.sign(np.sin(2 * np.pi * 720 * t))
    on = (t % 0.5) < 0.28
    env = np.convolve(on.astype(float), np.ones(SR // 200) / (SR // 200), mode='same')
    return band(buzz, 250, 5000) * env


def bell(f: float, s: float) -> np.ndarray:
    t = np.arange(int(s * SR)) / SR
    return sum(a * np.sin(2 * np.pi * f * m * t) * np.exp(-t * d) for m, a, d in ((1, 1, 2.6), (2, 0.28, 5), (3, 0.1, 9)))


def chime() -> np.ndarray:
    """SELCAL: the company's call, a hi-lo chime."""
    out = np.zeros(int(1.7 * SR))
    hi, lo = bell(1046.5, 0.9), bell(830.6, 1.25)
    out[: len(hi)] += hi
    out[int(0.45 * SR): int(0.45 * SR) + len(lo)] += lo
    return out * ramp(len(out), 0.003)


def shaker(s: float) -> np.ndarray:
    """The stick shaker: a motor-driven weight rattling the control column about 22 times a second."""
    n = int(s * SR)
    t = np.arange(n) / SR
    thump_t = np.arange(int(0.03 * SR)) / SR
    thump = np.sin(2 * np.pi * 110 * thump_t) * np.exp(-thump_t / 0.008)
    hits = np.zeros(n)
    hits[(np.arange(0, s, 1 / 22.0) * SR).astype(int)] = 1
    rattle = np.convolve(hits, thump)[:n]
    rumble = band(RNG.standard_normal(n), 60, 500) * (0.6 + 0.4 * np.sin(2 * np.pi * 22 * t))
    return (rattle + 0.08 * rumble / max(float(np.abs(rumble).max()), 1e-9)) * ramp(n, 0.02)


def whoop() -> np.ndarray:
    """The GPWS 'whoop': a tone rising from 400 to 1,300 Hz in 0.35 s."""
    t = np.arange(int(0.35 * SR)) / SR
    f = 400 * (1300 / 400) ** (t / 0.35)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return band(0.55 * np.sin(ph) + 0.45 * np.sign(np.sin(ph)), 250, 5000) * ramp(len(t), 0.01)


def digital(x: np.ndarray) -> np.ndarray:
    """A 1980s speech chip: 8 kHz, 6 bits, telephone band."""
    y = band(x, 300, 3400)
    y = np.repeat(y[::3], 3)[: len(y)]
    y = np.round(y / max(float(np.abs(y).max()), 1e-9) * 31) / 31
    return band(y, 250, 3800)


# ---------- speech ----------

class Voices:
    """Kokoro, loaded on the first line not in the cache."""

    def __init__(self) -> None:
        self.pipes: dict[str, object] | None = None

    def say(self, text: str, voice: str, speed: float) -> np.ndarray:
        CACHE.mkdir(parents=True, exist_ok=True)
        f = CACHE / f"{hashlib.sha1(f'{voice}|{speed:.3f}|{text}'.encode()).hexdigest()[:20]}.npy"
        if f.exists():
            return np.load(f)
        if self.pipes is None:
            import torch
            from kokoro import KModel, KPipeline
            if os.environ.get('TTS_THREADS'):
                torch.set_num_threads(int(os.environ['TTS_THREADS']))
            # ponytail: CPU. MPS compiles Metal kernels for every new input length, far slower over hundreds of lines.
            model = KModel(repo_id=REPO).eval()
            self.pipes = {c: KPipeline(lang_code=c, repo_id=REPO, model=model) for c in 'ab'}
        parts = [r.audio.cpu().numpy() for r in self.pipes[voice[0]](text, voice=voice, speed=speed) if r.audio is not None]
        a = trim(np.concatenate(parts).astype(np.float32)) if parts else np.zeros(1, np.float32)
        np.save(f, a)
        return a


def gpws(text: str, voices: Voices, voice: str) -> np.ndarray:
    words = text.replace('WHOOPWHOOP', 'WHOOP WHOOP ').split()
    parts: list[np.ndarray] = []
    spoken = ' '.join(w for w in words if w != 'WHOOP').title()
    for w in words:
        if w == 'WHOOP':
            parts += [whoop(), np.zeros(int(0.07 * SR))]
    parts.append(digital(voices.say(spoken + '.', voice, 1.0)))
    return np.concatenate(parts)


# ---------- the mix ----------

def build(folder: Path, cast_file: Path, plan: bool) -> None:
    scn = json.loads((folder / 'scenario.json').read_text())
    cfg = json.loads(cast_file.read_text())
    audio = scn['audio']
    clip = audio['clips'][0]
    t0 = clock(clip['at'])
    length = clip['to'] - clip['from']
    dark = clock(scn['ending']['darkAt']) if scn.get('ending') else t0 + length
    rows = list(csv.DictReader((folder / 'transcript.csv').open(encoding='utf-8')))
    rows = [r for r in rows if t0 <= clock(r['time']) < min(dark, t0 + length)]

    voices = Voices()
    mix = np.zeros(int(length * SR) + SR)
    ends: dict[str, float] = {}
    stats: dict[str, int] = {}
    speech_s = 0.0

    def put(x: np.ndarray, at: float) -> None:
        i = int(max(at - t0, 0) * SR)
        x = x[: max(len(mix) - i, 0)]
        mix[i: i + len(x)] += x

    shard = [int(v) for v in os.environ.get('VOICE_SHARD', '0/1').split('/')]
    for n, r in enumerate(rows):
        sp, t = r['speaker'], clock(r['time'])
        snd = cfg['sounds'].get(sp)
        if n % shard[1] != shard[0]:
            continue
        if snd:
            if plan:
                print(f"{r['time']} {sp:6} [{snd['kind']}] {r['text']}")
                continue
            kind = snd['kind']
            x = (horn(snd['s']) if kind == 'horn' else chime() if kind == 'chime' else shaker(snd['s']) if kind == 'shaker'
                 else gpws(r['text'], voices, cfg['voices'][sp]))
            put(level(x, 2.0 if kind == 'gpws' else -2.0 if kind == 'chime' else 0.0), t)
            stats[kind] = stats.get(kind, 0) + 1
            continue
        voice = cfg['voices'].get(sp)
        radio = r['channel'] in ('radio', 'company')
        text = speakable(r['text'], radio)
        if voice is None or text == '':
            continue
        how = delivery(r['time'], sp, r['channel'], r['text'], cfg)
        speed, gain, eff = LEVELS[how]
        if how in ('urgent', 'shout') and not text.endswith(('?', '!')):
            text = text.rstrip('.') + '!'
        if plan:
            print(f"{r['time']} {sp:6} {how:6} {voice:10} {text}")
            continue
        x = voices.say(text, voice, speed)
        # Fit before the same speaker's next line (or within the record's duration), at most 35 % faster.
        nxt = next((clock(q['time']) for q in rows[n + 1:] if q['speaker'] == sp), None)
        room = min(float(r['dur']) if r['dur'] else 1e9, (nxt - t) if nxt else 1e9) - 0.15
        if len(x) / SR > room > 0.4:
            x = voices.say(text, voice, min(1.35 * speed, speed * len(x) / SR / room))
        start = max(t, ends.get(sp, 0.0) + 0.05)
        ends[sp] = start + len(x) / SR
        speech_s += len(x) / SR
        y = level(channel_fx(effort(x, eff), r['channel']), gain - (3 if r['channel'] == 'cabin' else 0))
        put(y, start - (0.05 if radio else 0))
        stats[how] = stats.get(how, 0) + 1
    if plan or shard[1] > 1:
        return

    mix = np.tanh(mix * 1.1) / 1.1  # a soft limit on the rare peaks where voices and alerts meet
    out = folder / audio['file']
    out.parent.mkdir(parents=True, exist_ok=True)
    wav = CACHE / 'mix.wav'
    import soundfile as sf
    sf.write(wav, mix[: int(length * SR)].astype(np.float32), SR, subtype='PCM_16')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-ac', '1', '-c:a', 'aac', '-b:a', '64k',
                    '-movflags', '+faststart', str(out)], check=True)
    print(f'{out}: {out.stat().st_size / 1e6:.1f} MB, {length:.0f} s, {speech_s / 60:.1f} min of speech; {stats}')


# ---------- check ----------

def selftest() -> None:
    assert say_numbers('maintain 13,000, contact 123.7, runway 15L, JAPAN AIR 123') == \
        'maintain one three thousand, contact one two three decimal seven, runway one five left, JAPAN AIR one two three'
    assert speakable('Ah, TOKYO, JAPAN AIR 123 request from immediate e-- trouble', True) == \
        'Tokyo, Japan Air one two three request from immediate trouble'
    assert speakable('[unintelligible]', False) == ''
    assert say_numbers('passing 9,400, wind 220, 16') == 'passing nine four zero zero, wind two two zero, one six'
    assert speakable('Squawk 77', False) == 'Squawk seven seven'
    assert speakable('Present position direct SEAPERCH, ----123.', True) == 'Present position direct Seaperch, one two three.'
    assert speakable('Ah, ah, ah', False) == ''
    assert speakable('Oh—, Oh Oh', False) == ''
    assert speakable('Eh, listen right now ah, R5 door, ah has broken.', False) == 'listen right now, R5 door, has broken.'
    assert speakable('Max. power.', False) == 'Max power.'
    cfg = {'delivery': {'18:46:33 CAP': 'quiet'}, 'calm': ['ACC'], 'failureAt': '18:24:35', 'shoutFrom': '18:47:39'}
    assert delivery('18:46:33', 'CAP', 'cockpit', 'This may be hopeless.', cfg) == 'quiet'
    assert delivery('18:30:00', 'ACC', 'radio', 'Descend.', cfg) == 'calm'
    assert delivery('18:20:00', 'CAP', 'cockpit', 'Lower the nose.', cfg) == 'calm'
    assert delivery('18:37:31', 'CAP', 'cockpit', 'Lower the nose.', cfg) == 'urgent'
    assert delivery('18:55:15', 'CAP', 'cockpit', 'Raise the nose.', cfg) == 'shout'
    assert delivery('18:55:03', 'COP', 'cockpit', 'Yes, flap 10.', cfg) == 'urgent'
    assert delivery('18:53:31', 'CAP', 'radio', 'Eh, uncontrol, Japan Air 123 uncontrol.', cfg) == 'urgent'
    assert delivery('18:48:16', 'CAP', 'cockpit', 'Reduce power slightly.', cfg) == 'urgent'
    assert delivery('18:43:19', 'STH', 'cabin', 'Please remain in that condition and wait please.', cfg) == 'firm'
    assert delivery('18:44:53', 'FE', 'cockpit', 'Gears are down.', cfg) == 'firm'
    print('selftest ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    elif len(sys.argv) in (3, 4):
        build(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:] == ['--plan'])
    else:
        sys.exit(__doc__)
