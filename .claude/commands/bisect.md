---
description: Regression hunting — build a failing predicate, git bisect run it, return the commit instead of reading code
argument-hint: <what broke> [-- <last known good ref>]
allowed-tools: Bash, Read
---

# /bisect — let delta debugging find it

Regression: **$ARGUMENTS**

When something *used to work*, the cheapest localization is not reading code —
it is `git bisect run`. It returns a commit and a diff. Reading returns 45k of
context and a hypothesis.

## Step 0 — is this actually a regression?

Answer before doing anything else:

- Did this ever work? On which ref/commit/date?
- Is the working tree clean? (`git status --porcelain`)

If it never worked, or the answer is "I think so" → **stop and use `/localize`.**
Bisect on a bug that was never fixed wastes every step. Say which you chose.

If the tree is dirty, stash first (`git stash -u`) and restore at the end —
bisect checks out other commits and will refuse or corrupt uncommitted work.

## Step 1 — write the predicate (outside the repo)

The script must live **outside the working tree** — bisect checks out old commits
and would delete or revert a script stored in the repo. Use the session
scratchpad.

Exit codes: `0` = good, `1`–`124` = bad, `125` = untestable (skip).

pi-web has no test runner, so the predicate is a shell check. Pick the narrowest
one that actually distinguishes good from bad:

```bash
# A. Type regression
cat > "$SCRATCH/probe.sh" <<'EOF'
#!/bin/sh
cd /Users/aishwarya/dev/pi-web || exit 125
npm run -s typecheck 2>&1 | grep -q "Conversation.tsx.*TS2322" && exit 1
exit 0
EOF

# B. Build regression
#   npm run -s build >/dev/null 2>&1 || exit 1

# C. Runtime/server regression — boot on a spare port, probe, kill
#    Real server port is PI_WEB_PORT (default 4319); override it so the probe
#    never collides with a dev server you already have running.
cat > "$SCRATCH/probe.sh" <<'EOF'
#!/bin/sh
cd /Users/aishwarya/dev/pi-web || exit 125
PORT=4399
PI_WEB_PORT=$PORT node server/index.js >/dev/null 2>&1 &
PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'
RC=$?
kill $PID 2>/dev/null; wait $PID 2>/dev/null
exit $RC
EOF
chmod +x "$SCRATCH/probe.sh"
```

Rules for the predicate:

- **One observable fact**, checked non-interactively. No "looks wrong."
- Grep for the *specific* error, not any error — a broad predicate marks
  unrelated breakage as bad and bisects to the wrong commit.
- Always `kill` anything it starts, and free the port. A leaked server makes
  every later step look good.
- Exit `125` if the tree can't even be evaluated at that commit (missing deps,
  a file the probe needs doesn't exist yet) so bisect skips instead of lying.

## Step 2 — verify the predicate on both ends (non-negotiable)

```bash
git stash -u                                  # if dirty
sh "$SCRATCH/probe.sh"; echo "HEAD  -> $?"    # MUST be non-zero (bad)
git checkout <good-ref> --quiet
sh "$SCRATCH/probe.sh"; echo "GOOD  -> $?"    # MUST be 0 (good)
git checkout - --quiet
```

If both ends give the same answer, the predicate is wrong. Fix it here. A
bisect run on an unverified predicate produces a confident, wrong commit — the
single most expensive outcome available in this workflow.

## Step 3 — run it

```bash
git bisect start HEAD <good-ref>
git bisect run sh "$SCRATCH/probe.sh"
```

Then always:

```bash
git bisect reset
git stash pop        # if you stashed
```

If a run needs deps that changed mid-history, add `npm ci --silent || exit 125`
to the top of the probe, or `git bisect skip` those commits by hand.

## Step 4 — read the diff, not the codebase

```bash
git show --stat <first-bad>
git show <first-bad> -- <the one file the stat points at>
```

Now — and only now — open source, limited to what that commit touched. The
commit message plus its diff is usually the whole explanation.

Report: the first-bad commit hash and subject, the line(s) responsible, and the
fix. Do not re-derive the bug by reading unrelated files afterward.

## Caveat for pi-web today

History is short (`git log --oneline | wc -l` → 3), so bisect currently resolves
in ~2 steps and its edge over `/localize` is small. This command is the harness
for when it isn't — and commit hygiene now (small, self-contained commits) is
what keeps bisect sharp later.
