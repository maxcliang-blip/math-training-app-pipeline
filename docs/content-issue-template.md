# Content issue template

> Copy this into a new content issue's description. It exists because two content issues were
> closed `done` with nothing on `main` behind them — [MAX-20](/MAX/issues/MAX-20) (authored,
> unmerged) and [MAX-23](/MAX/issues/MAX-23) (never authored) — and a template is the cheapest
> place to make the next one cheap to close correctly.

## What this issue delivers

Lesson ids, one per line. These are the ids the close-out check will look for on `main`.

```
m5-l2
```

Exercises: (count)

## Scope

What the lesson covers, and what it explicitly does not. If it is a lesson in an existing series,
name the series and the lesson before it.

## Content contract

- [ ] Every field satisfies `npm run content:check` (Rendering Conventions S2–S9)
- [ ] Figures carry `asymptoteAlt` and a declared `asymptoteAspectRatio`, and the compiled box
      agrees with it to within the S5.5 tolerance
- [ ] Answers verified against the solutions, not eyeballed

## Close-out — required before setting `done`

Full procedure: [`docs/CONTENT_ISSUE_CLOSEOUT.md`](./CONTENT_ISSUE_CLOSEOUT.md).

- [ ] Work is merged; `git log --oneline origin/main..origin/<branch>` is empty
- [ ] Corpus counts moved in the same commit, if the corpus grew
      (`lib/corpus-pins.mjs`)
- [ ] Close-out comment contains a `Delivered:` line naming every lesson id above
- [ ] `npm run content:delivered -- <ids>` passes against `origin/main`, and its output is pasted
      into the close-out comment

**Delivered:** (fill in at close-out, e.g. `Delivered: m5-l2 (18 exercises)`)
