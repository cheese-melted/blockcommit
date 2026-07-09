# Views

The readable views are derived from the canonical digest. They do not replace the JSON format.

## Content

`view --view content` renders the content layer as compact movement tuples. `content` is the default view:

```sh
blockcommit view HEAD
```

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

`src` coordinates are parent-image coordinates. `dst` coordinates are post-image coordinates. The content view drops payload text, payload hashes, byte offsets, and derived identity events.

## Identity

`view --view identity` renders pairwise file-continuity flow between paths:

```sh
blockcommit view HEAD --view identity
```

```text
a.ts:10 -> b.ts:12 (6)
```

This means old `a.ts` had 10 lines, new `b.ts` has 12 lines, and 6 lines moved from `a.ts` to `b.ts` in this commit.

The text view is derived from cross-path move blocks. It does not label events as rename, reuse, exact, or partial; those interpretations can be computed from the counts and content operations.

## Identity From/To

`view --view identity-from` answers where each old file's moved lines ended up:

```sh
blockcommit view HEAD --view identity-from
```

```text
from old.ts:10 => new.ts (10/10, 100%)
from a.ts:10 => b.ts (6/10, 60%), unmoved (4/10, 40%)
```

`view --view identity-to` answers where each new file's moved lines came from:

```sh
blockcommit view HEAD --view identity-to
```

```text
to new.ts:10 <= old.ts (10/10, 100%)
to b.ts:20 <= a.ts (6/20, 30%), new (14/20, 70%)
to app.ts:20 <= model.ts (5/20, 25%), view.ts (3/20, 15%), new (12/20, 60%)
```

The canonical JSON still includes derived identity events for exact or majority path continuity, such as whole-file rename or path reuse. The text views intentionally emphasize counts because they are usually the more useful reading surface.

## Coupling

`view --view coupling` renders the third layer: a lean ordered payload for VPEL or another downstream relation system. It is a projection of the digest's canonical `symbols` and block endpoint totals.

```sh
blockcommit view HEAD --view coupling
blockcommit view --view coupling --range v1.0..main --format jsonl
blockcommit view HEAD --view coupling --no-cache
```

```json
{
  "schema_version": "blockcommit.coupling.v1",
  "commit": "abc123",
  "parent": "def456",
  "symbols": ["a.ts", "b.ts"],
  "ops": [
    ["move", 0, 1, 6, 6, 8]
  ]
}
```

Each op is:

```text
[kind, from_symbol_index, to_symbol_index, lines, from_total, to_total]
```

`kind` is `move`, `insert`, or `delete`. Symbol indexes point into the `symbols` array; duplicate path strings are allowed when one pathname has different old/new identity in the same commit. The line totals come from digest block endpoint `total_lines`. Blockcommit stops at deterministic symbols and ordered ops; VPEL owns relation mapping and score reduction.

## Commit Store

`commits` is the persistent view over Git history:

```sh
blockcommit commits --range v1.0..HEAD
blockcommit commits --cache --range v1.0..HEAD
```

Digest-producing commands fill the store by default. `commits` refreshes the tracked commit graph and reports `digested`, `undigested`, and `skipped` states. `commits --cache` explicitly backfills the undigested non-merge commits and writes both canonical digest records and coupling records under `.git/.bgit_cache/blockcommit`. Add `--no-cache` to digest/view commands to bypass store reads and writes for that run.
