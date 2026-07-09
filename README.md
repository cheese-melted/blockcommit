# blockcommit

`blockcommit` converts a single-parent git commit into a deterministic **line-move digest**. Instead of only saying "these lines were deleted" and "these lines were added", it pairs exact identical lines across the whole commit so moved code keeps its identity.

The primitive is:

```text
src line span -> dst line span    (move)
      (none) -> dst line span    (insert)
src line span -> (none)          (delete)
```

The canonical digest is the source of truth. From it, blockcommit exposes three layers:

1. **content**: ordered moved, inserted, and deleted line blocks
2. **identity**: file-DNA flow derived from cross-path moves
3. **coupling handoff**: ordered symbols and ops for VPEL to map/reduce into adjacency

## Install

From npm, after the package is published:

```sh
npm install -g blockcommit
blockcommit digest HEAD --pretty
blockcommit content HEAD
blockcommit identity HEAD
blockcommit coupling HEAD --pretty
```

Without a global install:

```sh
npx blockcommit content HEAD
```

For local development:

```sh
bun install
bun test
bun run build
```

## CLI

```sh
blockcommit digest HEAD --pretty
blockcommit digest --range v1.0..main --format jsonl

blockcommit content HEAD

blockcommit identity HEAD
blockcommit identity-from HEAD
blockcommit identity-to HEAD
blockcommit identity-from HEAD --pretty
blockcommit identity-to HEAD --pretty

blockcommit coupling HEAD --pretty
blockcommit coupling --range v1.0..main --format jsonl

blockcommit verify HEAD
blockcommit verify HEAD --format json
blockcommit verify digest.json --cwd .
blockcommit verify --range v1.0..main
```

`digest [commit] [--cwd <repo>] [--pretty]` prints canonical JSON. `digest --range <rev-range> --format jsonl` prints one digest per commit.

`content [commit] [--cwd <repo>]` prints layer 1: ordered content operations over moved, inserted, and deleted blocks.

`identity [commit] [--cwd <repo>]`, `identity-from [commit] [--cwd <repo>] [--pretty]`, and `identity-to [commit] [--cwd <repo>] [--pretty]` print layer 2: file-continuity views over cross-path moves.

`coupling [commit] [--cwd <repo>] [--pretty]` and `coupling --range <rev-range> --format jsonl` print layer 3: a lean transition payload for VPEL. It preserves local symbols and the ordered operation list, but leaves relation mapping and score reduction to VPEL.

`verify [commit]` rebuilds represented files from the parent tree plus digest blocks and byte-compares against the commit. `verify digest.json --cwd <repo>` verifies a saved digest against its referenced commit.

## Layers

The layers are intentionally separated so each one has a narrow job.

### 1. Content

Content is the byte-correct operation layer:

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

This is the closest readable view of the canonical digest. It answers: which line blocks moved, appeared, or disappeared?

### 2. Identity

Identity summarizes cross-path content movement as file-DNA flow:

```text
a.ts:10 -> b.ts:12 (6)
from a.ts:10 => b.ts (6/10, 60%), unmoved (4/10, 40%)
to b.ts:12 <= a.ts (6/12, 50%), new (6/12, 50%)
```

This answers: where did old file content end up, and where did new file content come from?

### 3. Coupling Handoff

Coupling is the compact machine handoff for downstream relation systems:

```json
{
  "schema_version": "blockcommit.coupling.v1",
  "commit": "abc123",
  "parent": "def456",
  "symbols": {
    "s1": "a.ts",
    "s2": "b.ts",
    "s3": "a.ts"
  },
  "ops": [
    ["move", "s1", "s2", 6, 6, 8],
    ["insert", null, "s3", 2, 0, 2]
  ]
}
```

Each op is:

```text
[kind, from_symbol, to_symbol, lines, from_total, to_total]
```

The totals are integer denominators. VPEL can compute percentages exactly, map ordered ops into relation events, and reduce those events into coupling/adjacency scores.

## Docs

- [Digest format](docs/digest-format.md): canonical JSON, schema, pairing policy, and unsupported files
- [Views](docs/views.md): `content`, `identity`, `identity-from`, `identity-to`, and `coupling`
- [Development](docs/development.md): release checks and library usage

## Compatibility

The current canonical schema is `blockcommit.digest.v3`, shipped as `schema/blockcommit.digest.v3.schema.json` and exported as `blockcommit/schema/blockcommit.digest.v3.schema.json`.

The digest intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization.
