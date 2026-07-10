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

The views are intentionally separated so each one has a narrow job.

### Content

`view [commit] [--no-cache]` prints ordered content operations over moved, inserted, and deleted blocks. `content` is the default view.

```sh
blockcommit view
```

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

This is the closest readable view of the canonical digest. It answers: which line blocks moved, appeared, or disappeared?

### Identity

`view [commit] --identity [--no-cache]`, `view [commit] --identity-from [--no-cache]`, and `view [commit] --identity-to [--no-cache]` print file-continuity views over cross-path moves. Same-file moves stay in the content view.

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

This answers: where did old file content end up, and where did new file content come from across paths?

For Git reads, blockcommit normalizes the selected repo to a tiny `.git/.bgit_cache` worktree pointer. The default selected repo is the current working repo; `--cwd` only overrides that. You can point it at a worktree or directly at its `.git` directory, and blockcommit keeps that path handling internal without checking out files.

## Persistent Store

Digest-producing CLI commands maintain a local store under `.git/.bgit_cache/blockcommit` by default:

```text
index.json              tracked commit graph
digests/<commit>.json   canonical digest records
```

The default range is `HEAD`, which means every commit reachable from the current `HEAD`. A bounded range keeps the view focused:

```sh
blockcommit cache --range <base>..<tip>
blockcommit cache verify --range <base>..<tip>
blockcommit digest --range <base>..<tip> --format jsonl
```

`cache` refreshes the graph and reports state without digesting. `cache verify` checks existing cached digest records against their referenced commits. The default digest/view commands read and write per-commit cache records as they run; `digest --range` is the explicit way to compute and stream digests for a range.

```text
tracked 3 commits (digested 1, undigested 1, invalid 1, skipped 0)
D 111111111111 root
U 222222222222 111111111111
I 333333333333 222222222222 malformed_digest
```

Malformed digest JSON and records produced for an incompatible commit, schema, or algorithm are reported as `invalid`. The next digest operation for that commit recomputes and atomically replaces the record. Index updates are serialized across processes, malformed indexes are rebuilt from Git history, and interrupted temporary files are ignored.

Merge commits are tracked as skipped because the current digest format is single-parent. Use `--no-cache` on digest-producing commands when you want one-off output without touching the persistent store.

## Docs

- [Digest format](docs/digest-format.md): canonical JSON, schema, pairing policy, and unsupported files
- [Views](docs/views.md): `view`, `view --identity`, `view --identity-from`, and `view --identity-to`
- [Development](docs/development.md): release checks and library usage

## Compatibility

The current canonical schema is `blockcommit.digest.v4`, shipped as `schema/blockcommit.digest.v4.schema.json` and exported as `blockcommit/schema/blockcommit.digest.v4.schema.json`.

Version 0.7 narrows the CLI around the persistent store. History verification now lives under `cache verify`; the standalone `verify` command and the downstream-specific coupling view/export were removed.

Runtime schema validation is available to consumers:

```ts
import { validateDigest } from "blockcommit";

const result = validateDigest(JSON.parse(savedDigestJson));
```

The digest intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization.
