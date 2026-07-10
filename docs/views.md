# Views

The readable views are derived from the canonical digest. They do not replace the JSON format.

## Content

`view --view content` renders the content layer as compact movement tuples. `content` is the default view:

```sh
blockcommit view
```

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

`src` coordinates are parent-image coordinates. `dst` coordinates are post-image coordinates. The content view drops payload text, payload hashes, byte offsets, and derived identity events.

## Identity

`view --identity` renders pairwise file-continuity flow between paths. Same-file moves stay in the content view:

```sh
blockcommit view --identity
```

```text
a.ts:10 -> b.ts:12 (6)
```

This means old `a.ts` had 10 lines, new `b.ts` has 12 lines, and 6 lines moved from `a.ts` to `b.ts` in this commit.

The text view is derived from cross-path move blocks. It does not label events as rename, reuse, exact, or partial; those interpretations can be computed from the counts and content operations.

## Identity From/To

`view --identity-from` answers where each old file's moved lines ended up:

```sh
blockcommit view --identity-from
```

```text
old.ts:10  ->  new.ts  (10/10, 100%)
a.ts:10    ->  b.ts    (6/10, 60%)
```

`view --identity-to` answers where each new file's moved lines came from:

```sh
blockcommit view --identity-to
```

```text
new.ts:10  <-  old.ts    (10/10, 100%)
b.ts:20    <-  a.ts      (6/20, 30%)
app.ts:20  <-  model.ts  (5/20, 25%)
                view.ts   (3/20, 15%)
```

The canonical JSON still includes derived identity events for exact or majority path continuity, such as whole-file rename or path reuse. The text views intentionally emphasize counts because they are usually the more useful reading surface.

## Cache

`cache` is the query-only view over cached Git history:

```sh
blockcommit cache --range <base>..<tip>
blockcommit cache verify --range <base>..<tip>
blockcommit cache --format json
```

Digest-producing commands fill the store by default. `cache` refreshes the tracked commit graph and reports `digested`, `undigested`, `invalid`, and `skipped` states. Invalid records carry either `malformed_digest` or `incompatible_digest`; the next digest operation recomputes them. `cache verify` checks existing cached digest records against their referenced commits and reports malformed records as failures rather than aborting the range. Run `digest --range <base>..<tip> --format jsonl` to compute and stream digests for a range. Add `--no-cache` to digest/view commands to bypass store reads and writes for that run.

The cache status JSON uses `blockcommit.commit-store.v2`. Store files are written through atomic renames, index updates are serialized across processes, malformed indexes are rebuilt from the selected Git history, and leftover temporary files from interrupted writes are ignored.
