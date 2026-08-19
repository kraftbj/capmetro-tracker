# TODOS

## Replace git-committed schedule shards with a transport that does not grow history

**What:** For v1, the daily GitHub Actions job commits regenerated per-route schedule
shards into the repo, and the Linode picks them up with `git pull`. Replace this later
with a transport that does not accumulate history.

**Why:** Shards total ~4.3 MB gzipped across 71 routes. A daily rebuild that touches most
of them adds meaningful history every day, forever. Git stores each revision, so a repo
that starts small becomes a multi-gigabyte clone within a year or two. That eventually
makes the Linode's `git pull` slow and the repo unpleasant to clone.

**Pros of fixing:** Repo stays small and fast to clone. No unbounded disk growth on either
the runner or the server.

**Cons of fixing:** Loses the two properties that made option A right for v1: shards are
currently diffable (a bad CapMetro republish shows up as a readable diff) and revertable
(`git revert` rolls back to a known-good schedule in one command). Any replacement should
preserve some form of both.

**Context:** Decided during `/plan-eng-review` on 2026-08-19. Three options were weighed:
(A) commit shards and `git pull`, (B) publish to GitHub Pages and fetch over HTTPS at
runtime, (C) build shards on the Linode in PHP. A was chosen for v1 because it is
versioned, revertable, needs no secrets, and has no runtime network dependency. C was
rejected because PHP has no maintained GTFS static parsing library. B remains the most
likely replacement.

**Options when picked up:**
- Switch to option B (Pages + HTTPS fetch), keeping a small manifest with feed version and
  build timestamp so staleness stays detectable.
- Keep committing but to an orphan branch with a shallow-truncated history, periodically
  squashed. Preserves diffability; bounds growth.
- ~~Only commit shards when the upstream GTFS `feed_version` changes, rather than daily.~~
  **DONE 2026-08-19.** Implemented in `.github/workflows/gtfs.yml`: the workflow reads
  `data/manifest.json` feed_version before and after the rebuild and commits nothing when it
  is unchanged. CapMetro resets the schedule roughly three times a year, so `data/` now grows
  about three times a year instead of daily. This may defer the problem indefinitely; reassess
  only if `.git` becomes unwieldy (it was 7.1 MB with the first shard set committed).

**Depends on / blocked by:** Nothing. Can be done any time after the build pipeline works.
Do the `feed_version` check first, since it is small and may remove the urgency.

## Write a real DESIGN.md via /design-consultation

**What:** The plan carries a minimum-viable token set (six semantic colours with measured
contrast, plus glyphs) inside `docs/designs/capmetro-dispatch-board.md`. Replace it with an
actual design system.

**Why:** Pass 5 of the design review scored 2/10 because no DESIGN.md exists. Every future
decision (spacing scale, type ramp, component vocabulary, elevation, focus rings) gets made ad
hoc and inconsistently. The token set covers colour and nothing else.

**Pros:** One reference for every future decision. New panels stop being one-off designs.

**Cons:** Half a day of work upfront on a side project, and the current token set is already
enough to build v1 without embarrassment.

**Context:** Decided during `/plan-design-review` on 2026-08-19. Initial design completeness was
4/10, and the two things that most limited the ceiling were the missing design system and the
missing state coverage. State coverage is now specified in the plan; the design system is not.
Target devices are Pixel 8a and Pixel 10 Pro, dark theme only.

**Depends on / blocked by:** Nothing. Best done after v1 ships, when the real components exist to
systematise rather than being guessed at in advance.

## Resolve BOTH-direction ladder rendering

**What:** The direction control is a three-way toggle (direction A / direction B / BOTH). A and B
are specified and rendered. BOTH is not.

**Why:** BOTH is the mode that fixes the turnaround confusion, which is the most valuable feature
in the plan. Shipping the toggle with an unspecified third state means whoever implements it
stacks the two directions and produces a chart with no directional cue.

**Pros:** Closes the last open layout question and completes the feature that motivated the whole
block-continuity design.

**Cons:** Needs another render-and-look cycle; roughly doubles ladder rows.

**Context:** At 412px with timepoints only, BOTH is ~16 rows for route 7, which fits. The likely
answer is mirroring the two directions around a shared time axis so the turnaround sits at the
fold, but this is unverified. Route 7 is the worst case (66 stops one direction, 59 the other,
8-9 timepoints). Render it before deciding.

**Depends on / blocked by:** Task D3 (timepoint ladder with accordion) should land first.
