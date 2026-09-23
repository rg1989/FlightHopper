#!/usr/bin/env python3
"""Apply validated WP plans to a git worktree, task by task, one commit per task, full check after each WP.

Usage: apply_plans.py <worktree> <WP file stem> [<WP file stem> ...]
File-block rules (same as the assembler that rebuilt the project from plans):
  - a line `File: \`path\`` right before a fenced block → that file's complete content, verbatim
  - otherwise a block whose first line is a path comment (// p, /* p */, <!-- p -->) → new file, comment included
  - bash blocks: `mkdir -p`, `cp .planning/plans/assets/...`, `git rm ...` lines are executed; `git commit -m "..."` gives the message
"""
import os, re, subprocess, sys

TRAILER = "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
FENCE = re.compile(r"(?:^File: `([^`]+)`\n(?:[ \t]*\n)*)?^```([a-zA-Z0-9]*)\n(.*?)\n```", re.M | re.S)
PATHC = re.compile(r"^(?://|/\*|<!--)\s*([\w./@-]+\.[a-zA-Z0-9]+)")
TASK = re.compile(r"^### Task (\d+)[:.]? (.*)$", re.M)


def sh(cmd, cwd, check=True):
    r = subprocess.run(cmd, cwd=cwd, shell=True, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise SystemExit(f"FAILED: {cmd}\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    return r


def apply_task(tree, body):
    written, msg = [], None
    for m in FENCE.finditer(body):
        path, lang, content = m.group(1), m.group(2), m.group(3)
        if path:
            target = path
        elif lang in ("bash", "sh", "shell", ""):
            for line in content.splitlines():
                s = line.strip()
                if s.startswith("mkdir -p ") or s.startswith("cp .planning/plans/assets/") or s.startswith("git rm "):
                    sh(s, tree)
                cm = re.search(r'git commit -m "((?:[^"\\]|\\.)*)"', s)
                if cm:
                    msg = cm.group(1).replace('\\"', '"')
            pm = PATHC.match(content.split("\n", 1)[0]) if lang == "" else None
            if not pm:
                continue
            target = pm.group(1)
        else:
            pm = PATHC.match(content.split("\n", 1)[0])
            if not pm:
                continue
            target = pm.group(1)
        full = os.path.join(tree, target)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(content + "\n")
        written.append(target)
    return written, msg


def main():
    tree, stems = sys.argv[1], sys.argv[2:]
    plans = os.path.join(tree, ".planning", "plans")
    for stem in stems:
        text = open(os.path.join(plans, stem + ".md")).read()
        tasks = list(TASK.finditer(text))
        commits = 0
        for i, t in enumerate(tasks):
            body = text[t.end(): tasks[i + 1].start() if i + 1 < len(tasks) else len(text)]
            written, msg = apply_task(tree, body)
            sh("git add -A", tree)
            if sh("git diff --cached --quiet", tree, check=False).returncode == 0:
                continue  # verification-only task
            msg = msg or f"feat({stem}): task {t.group(1)} — {t.group(2).strip()}"
            with open(os.path.join(tree, ".git-msg"), "w") as f:
                f.write(msg + TRAILER + "\n")
            sh("git commit -q -F .git-msg", tree)
            os.remove(os.path.join(tree, ".git-msg"))
            commits += 1
        tsc = sh("npx tsc --noEmit", tree, check=False)
        test = sh("npm test 2>&1 | grep -E '^ℹ (tests|pass|fail) '", tree, check=False)
        nums = dict(re.findall(r"ℹ (tests|pass|fail) (\d+)", test.stdout))
        ok = tsc.returncode == 0 and nums.get("fail") == "0"
        print(f"{stem}: {commits} commits, tsc {'ok' if tsc.returncode == 0 else 'FAIL'}, tests {nums}", flush=True)
        if not ok:
            print(tsc.stdout[-2000:], flush=True)
            raise SystemExit(f"stop: {stem} failed its gate")


if __name__ == "__main__":
    main()
