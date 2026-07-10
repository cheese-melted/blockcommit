# blockcommit

`blockcommit` converts a git commit into a deterministic set of line moves. It pairs exact lines across the whole commit so moved code can keep its identity.

## Install

Install globally from npm:

```sh
npm install -g blockcommit
```

Or run without a global install:

```sh
npx blockcommit view
```

## Usage

All commands default to the current working repo. Use `--cwd <path>` only when reading another worktree or a `.git` directory directly.

By default, commands that compute commit digests read from and write to `.git/.bgit_cache/blockcommit`. Add `--no-cache` to bypass the persistent store for a single run.

### Digest

```sh
blockcommit digest
blockcommit digest <commit>
blockcommit digest --no-cache
```

`digest [commit] [--no-cache]` prints canonical JSON for one commit. The commit defaults to `HEAD`.

For bulk export, pass a Git revision range and print one JSON object per line:

```sh
blockcommit digest --range <base>..<tip> --format jsonl
```

### Cache

```sh
blockcommit cache
blockcommit cache --range <base>..<tip>
blockcommit cache verify
blockcommit cache verify --range <base>..<tip>
blockcommit cache --format json
```

`cache [--range <rev-range>]` refreshes and prints cache state: which commits are digested, undigested, invalid, or skipped. `cache verify [--range <rev-range>]` verifies cached digest records against their referenced commits. Run `digest --range <rev-range> --format jsonl` to compute missing records and replace invalid ones.

## Views

Views are readable projections of the canonical digest. They do not replace the JSON format.

### Content

`view [commit]` prints ordered moves, insertions, and deletions. This is the default view.

```sh
blockcommit view
```

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

Source coordinates refer to the parent tree; destination coordinates refer to the selected commit.

### Identity

Identity views summarize cross-path movement. Same-file moves remain in the content view.

```sh
blockcommit view --identity
blockcommit view --identity-from
blockcommit view --identity-to
```

```text
a.ts:10 -> b.ts:12 (6)
a.ts:10  ->  b.ts     (6/10, 60%)
b.ts:12  <-  a.ts  (6/12, 50%)
```

`--identity` shows pairwise flow. `--identity-from` groups destinations by old path, while `--identity-to` groups sources by new path. See [Views](docs/views.md) for the full output semantics.

## Persistent Store

Digest and view commands use a repository-local store by default:

```text
index.json              tracked commit graph
digests/<commit>.json   canonical digest records
```

```sh
blockcommit cache
blockcommit cache --range <base>..<tip>
blockcommit cache verify --range <base>..<tip>
blockcommit digest --range <base>..<tip> --format jsonl
```

`cache` reports state without computing missing digests. `digest --range` computes and streams a range, filling the store as it goes. `cache verify` checks records already present in the store.

```text
tracked 3 commits (digested 1, undigested 1, invalid 1, skipped 0)
D 111111111111 root
U 222222222222 111111111111
I 333333333333 222222222222 malformed_digest
```

- `D`: a compatible digest is present.
- `U`: no digest is present.
- `I`: the record is malformed or incompatible and will be replaced when next digested.
- `S`: the commit is unsupported; currently this means a merge commit.

The default range is every commit reachable from `HEAD`. Use a bounded Git revision range for focused work, or `--no-cache` on digest and view commands for a one-off read.

## Library and Schema

The canonical format is `blockcommit.digest.v4`. Its JSON Schema ships at `blockcommit/schema/blockcommit.digest.v4.schema.json`, and runtime validation is available from the package:


```ts
import { digestCommit, validateDigest } from "blockcommit";

const digest = digestCommit({ commit: "HEAD" });
const result = validateDigest(digest);
```

The package is ESM-only. Digests exclude checkout paths and other machine-local facts, so the same commit and algorithm produce byte-identical serialized JSON across checkouts.

## Documentation

- [Digest format](docs/digest-format.md): canonical fields, pairing policy, and unsupported files
- [Views](docs/views.md): content, identity, and cache output
- [Development](docs/development.md): library API and release checks
