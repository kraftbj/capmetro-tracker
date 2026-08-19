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
- Only commit shards when the upstream GTFS `feed_version` changes, rather than daily.
  CapMetro resets the schedule roughly three times a year, so most daily rebuilds are
  byte-identical and need no commit at all. **This is the cheapest mitigation and may
  defer the problem indefinitely.**

**Depends on / blocked by:** Nothing. Can be done any time after the build pipeline works.
Do the `feed_version` check first, since it is small and may remove the urgency.
