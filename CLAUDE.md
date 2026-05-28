# CLAUDE.md — repo-root pointers

Most of this repo's working code lives under `wasm/`. Start with
**[wasm/CLAUDE.md](./wasm/CLAUDE.md)** for the project's full
engineering rules, testing discipline, LO-build workflow, etc.

## Working lists (per-dev, gitignored)

The AI-skill queues live under `ai/`. Each is folder-based; status is
the parent subfolder.

```
ai/
├── tasks/        todo/ in-progress/ parked/ done/
├── proposals/    proposed/ promoted/ rejected/
└── questions/    pending/ answered/
```

- **Pick work from `ai/tasks/todo/`.** Skills `/dev-iterate` and
  `/fix-bug` read it as their source of truth. Status changes use
  `git mv` so history is preserved.
- **File sideways findings as proposals**, not tasks. Write a new
  `ai/proposals/proposed/<slug>.md`. The user reviews proposals and
  promotes accepted ones to `ai/tasks/todo/` themselves.
- **Park-with-question** instead of `AskUserQuestion`. Write
  `ai/questions/pending/<slug>.md` — the single ntfy.sh hook
  (`~/.claude/hooks/ntfy-new-question.sh`) pushes a notification.
  No other event notifies anymore (Stop / Notification hooks removed
  2026-05-28 to cut noise).

See `ai/README.md` and each subdir's README for the full conventions.

## Autonomous default

**While `ai/tasks/todo/` is non-empty, iterate autonomously.** Skills
`/dev-iterate` and `/fix-bug` handle the loop: branch → failing E2E
test via `/write-test` → fix → snapshot gate → PR → move task to
`done/` → pick the next. Don't pause between iterations to ask "what's
next" — the answer is in `ai/tasks/todo/`.

If you genuinely cannot decide and the question is a tradeoff a human
must make, park-with-question (see above). Otherwise: pick and ship.

## Do NOT auto-create tasks

Skills file findings as PROPOSALS, never as tasks. New `ai/tasks/`
entries appear only when the user explicitly says so OR when they
promote a proposal. This keeps the backlog curated rather than
flooded.

## Skill index

Local skills under `.claude/skills/` (themselves gitignored):

- `/dev-iterate` — pick next task, ship it, repeat.
- `/fix-bug` — disciplined bugfix workflow (branch → failing test →
  root cause → fix → verify → snapshot gate → PR).
- `/write-test` — author E2E tests. Enforces the hard rule: every
  test must be a real Puppeteer simulation of user input. **No
  `sendUnoCommand`, no `app.dispatcher.dispatch`, no
  `page.evaluate(()=>el.click())`, no internal-state assertions.**
- `/local-deploy`, `/test-deploy`, `/ci-deploy`, `/lo-roll` — deploy
  pipeline helpers.

The skill files (`SKILL.md` in each subdir) have the full prompts;
read them when invoking.
