# Views

The readable views are derived from the canonical digest. They do not replace the JSON format.

## Content

`content` renders the content layer as compact movement tuples:

```sh
blockcommit content HEAD
```

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

`src` coordinates are parent-image coordinates. `dst` coordinates are post-image coordinates. The content view drops payload text, payload hashes, byte offsets, and derived identity events.

## Identity

`identity` renders pairwise file-continuity flow between paths:

```sh
blockcommit identity HEAD
```

```text
a.ts:10 -> b.ts:12 (6)
```

This means old `a.ts` had 10 lines, new `b.ts` has 12 lines, and 6 lines moved from `a.ts` to `b.ts` in this commit.

The text view is derived from cross-path move blocks. It does not label events as rename, reuse, exact, or partial; those interpretations can be computed from the counts and content operations.

## Identity From/To

`identity-from` answers where each old file's moved lines ended up:

```text
from old.ts:10 => new.ts (10/10, 100%)
from a.ts:10 => b.ts (6/10, 60%), unmoved (4/10, 40%)
```

`identity-to` answers where each new file's moved lines came from:

```text
to new.ts:10 <= old.ts (10/10, 100%)
to b.ts:20 <= a.ts (6/20, 30%), new (14/20, 70%)
to app.ts:20 <= model.ts (5/20, 25%), view.ts (3/20, 15%), new (12/20, 60%)
```

Add `--pretty` for aligned rows:

```sh
blockcommit identity-from HEAD --pretty
blockcommit identity-to HEAD --pretty
```

```text
a.ts:10  =>  b.ts     (6/10, 60%)
            unmoved  (4/10, 40%)
```

```text
app.ts:20  <=  model.ts  (5/20, 25%)
             view.ts   (3/20, 15%)
             new       (12/20, 60%)
```

The canonical JSON still includes derived identity events for exact or majority path continuity, such as whole-file rename or path reuse. The text views intentionally emphasize counts because they are usually the more useful reading surface.
