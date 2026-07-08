# blockcommit

`blockcommit` converts a single-parent git commit into a deterministic **line-move digest**. Instead of only saying "these lines were deleted" and "these lines were added", it pairs exact identical lines across the whole commit so moved code keeps its identity.

The primitive is:

```text
src line span -> dst line span    (move)
      (none) -> dst line span    (insert)
src line span -> (none)          (delete)
```

The tool has three core surfaces:

1. **digest**: canonical JSON for tools, storage, and verification
2. **content**: readable moved/inserted/deleted block operations
3. **identity**: readable file-continuity views derived from cross-path moves

## Install

From npm, after the package is published:

```sh
npm install -g blockcommit
blockcommit digest HEAD --pretty
blockcommit content HEAD
blockcommit identity HEAD
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

blockcommit verify HEAD
blockcommit verify HEAD --format json
blockcommit verify digest.json --cwd .
blockcommit verify --range v1.0..main
```

`digest [commit] [--cwd <repo>] [--pretty]` prints the canonical JSON digest. `digest --range <rev-range> --format jsonl` prints one digest per line.

`content [commit] [--cwd <repo>]` prints compact content operations over moved, inserted, and deleted blocks.

`identity [commit] [--cwd <repo>]`, `identity-from [commit] [--cwd <repo>] [--pretty]`, and `identity-to [commit] [--cwd <repo>] [--pretty]` print file-continuity views over cross-path moves.

`verify [commit]` rebuilds represented files from the parent tree plus digest blocks and byte-compares against the commit. `verify digest.json --cwd <repo>` verifies a saved digest against its referenced commit.

## Docs

- [Digest format](docs/digest-format.md): canonical JSON, schema, pairing policy, and unsupported files
- [Views](docs/views.md): `content`, `identity`, `identity-from`, and `identity-to`
- [Development](docs/development.md): release checks and library usage

## Compatibility

The current canonical schema is `blockcommit.digest.v3`, shipped as `schema/blockcommit.digest.v3.schema.json` and exported as `blockcommit/schema/blockcommit.digest.v3.schema.json`.

The digest intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization.
