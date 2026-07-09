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
blockcommit cache --format json
```

`cache [--range <rev-range>]` refreshes and prints cache state: which commits are digested, undigested, or skipped. Run `digest --range <rev-range> --format jsonl` to compute and cache missing digest records.

### Verify

```sh
blockcommit verify
blockcommit verify --format json
blockcommit verify digest.json --cwd .
blockcommit verify --range <base>..<tip>
```

`verify [commit]` rebuilds represented files from the parent tree plus digest blocks and byte-compares against the commit. `verify digest.json --cwd <path>` verifies a saved digest against its referenced commit.

## Views

```sh
blockcommit view

blockcommit view --view identity
blockcommit view --view identity-from
blockcommit view --view identity-to

blockcommit view --view coupling
blockcommit view --view coupling --range <base>..<tip> --format jsonl
```

`view [commit] [--view content] [--no-cache]` prints ordered content operations over moved, inserted, and deleted blocks. `content` is the default view.

`view [commit] --view identity [--no-cache]`, `view [commit] --view identity-from [--no-cache]`, and `view [commit] --view identity-to [--no-cache]` print file-continuity views over cross-path moves.

`view [commit] --view coupling [--no-cache]` and `view --view coupling --range <rev-range> --format jsonl [--no-cache]` print a lean projection of the digest's symbols and ordered block list for VPEL. It leaves relation mapping and score reduction to VPEL.

The views are intentionally separated so each one has a narrow job.

### Content

Content is the byte-correct operation layer:

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

This is the closest readable view of the canonical digest. It answers: which line blocks moved, appeared, or disappeared?

### Identity

Identity summarizes cross-path content movement as file-DNA flow:

```text
a.ts:10 -> b.ts:12 (6)
from a.ts:10 => b.ts (6/10, 60%), unmoved (4/10, 40%)
to b.ts:12 <= a.ts (6/12, 50%), new (6/12, 50%)
```

This answers: where did old file content end up, and where did new file content come from?

### Coupling Handoff

Coupling is the compact machine handoff for downstream relation systems. It is projected directly from the digest's canonical `symbols` and block endpoints:

```json
{
  "schema_version": "blockcommit.coupling.v1",
  "commit": "abc123",
  "parent": "def456",
  "symbols": ["a.ts", "b.ts", "a.ts"],
  "ops": [
    ["move", 0, 1, 6, 6, 8],
    ["insert", null, 2, 2, 0, 2]
  ]
}
```

Each op is:

```text
[kind, from_symbol_index, to_symbol_index, lines, from_total, to_total]
```

The totals are integer denominators copied from digest block endpoint `total_lines`. VPEL can compute percentages exactly, map ordered ops into relation events, and reduce those events into coupling/adjacency scores.

For Git reads, blockcommit normalizes the selected repo to a tiny `.git/.bgit_cache` worktree pointer. The default selected repo is the current working repo; `--cwd` only overrides that. You can point it at a worktree or directly at its `.git` directory, and blockcommit keeps that path handling internal without checking out files.

## Persistent Store

Digest-producing CLI commands maintain a local store under `.git/.bgit_cache/blockcommit` by default:

```text
index.json              tracked commit graph
digests/<commit>.json   canonical digest records
coupling/<commit>.json  compact coupling handoff records
```

The default range is `HEAD`, which means every commit reachable from the current `HEAD`. A bounded range keeps the view focused:

```sh
blockcommit cache --range <base>..<tip>
blockcommit digest --range <base>..<tip> --format jsonl
```

`cache` refreshes the graph and reports state without digesting. The default digest/view commands read and write per-commit cache records as they run; `digest --range` is the explicit way to compute and stream digests for a range.

```text
tracked 2 commits (digested 1, undigested 1, skipped 0)
D 111111111111 root
U 222222222222 111111111111
```

Merge commits are tracked as skipped because the current digest format is single-parent. Use `--no-cache` on digest-producing commands when you want one-off output without touching the persistent store.

## Docs

- [Digest format](docs/digest-format.md): canonical JSON, schema, pairing policy, and unsupported files
- [Views](docs/views.md): `view --view content`, `identity`, `identity-from`, `identity-to`, and `coupling`
- [Development](docs/development.md): release checks and library usage

## Compatibility

The current canonical schema is `blockcommit.digest.v4`, shipped as `schema/blockcommit.digest.v4.schema.json` and exported as `blockcommit/schema/blockcommit.digest.v4.schema.json`.

Runtime schema validation is available to consumers:

```ts
import { validateDigest } from "blockcommit";

const result = validateDigest(JSON.parse(savedDigestJson));
```

The digest intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization.
