# Digest Format

`git trails digest` emits the canonical machine format. It is the source of truth for storage, verification, and downstream tools.

## Canonicality

The digest excludes local checkout paths and other machine-local facts. Cached digests are stored under the selected repository's `.git/.bgit_cache/git-trails` directory and can be checked against their referenced commits:

```sh
git trails cache verify --cwd /path/to/repo
```

The current schema is `git-trails.digest.v4`, shipped as `schema/git-trails.digest.v4.schema.json` and exported as `git-trails/schema/git-trails.digest.v4.schema.json`.

Digest v4 supports SHA-1-format Git repositories. SHA-256 object-format repositories are rejected before digesting because commit, parent, and blob object IDs are canonicalized as 40-hex Git OIDs.

Any change that can alter block IDs, pairings, spans, block grouping, or identity events must bump the algorithm version or the schema version. Consumers should treat `schema_version` and `algorithm` as part of the canonical value.

## Block Shape

The v4 schema uses a discriminated `LineMoveBlock` shape:

- `kind: "move"` has both `src` and `dst` spans.
- `kind: "insert"` has `src: null` and a `dst` span.
- `kind: "delete"` has a `src` span and `dst: null`.

Coordinate semantics:

- `src` spans use parent-tree line and byte coordinates.
- `dst` spans use new-tree line and byte coordinates.
- each non-null span has a `symbol` index and `total_lines` denominator.
- `path:start+count` in rendered views means start at that line and include that many lines.

## Example

```jsonc
{
  "schema_version": "git-trails.digest.v4",
  "algorithm": {
    "name": "exact-line-sha256-identity-preserving",
    "version": 2,
    "anchor_min_alnum": 4,
    "exact_block_fallback": true,
    "whole_file_identity": true,
    "git_diff": { "algorithm": "myers", "indent_heuristic": false }
  },
  "commit": "...",
  "parent": "...",
  "symbols": ["a.txt", "b.txt"],
  "files": [
    {
      "path": "a.txt",
      "old_exists": true,
      "new_exists": true,
      "old_mode": "100644",
      "new_mode": "100644",
      "old_oid": "...",
      "new_oid": "...",
      "binary": false,
      "old_lines": 3,
      "new_lines": 1,
      "old_sha256": "...",
      "new_sha256": "...",
      "line_digest_status": "represented"
    }
  ],
  "blocks": [
    {
      "id": "gt_0123456789abcdef",
      "kind": "move",
      "src": {
        "symbol": 0,
        "path": "a.txt",
        "start_line": 2,
        "end_line": 2,
        "line_count": 1,
        "total_lines": 3,
        "byte_start": 5,
        "byte_end": 10
      },
      "dst": {
        "symbol": 1,
        "path": "b.txt",
        "start_line": 2,
        "end_line": 2,
        "line_count": 1,
        "total_lines": 3,
        "byte_start": 7,
        "byte_end": 12
      },
      "payload_encoding": "utf-8",
      "payload_text": "move\n",
      "payload_sha256": "...",
      "payload_bytes": 5,
      "payload_lines": 1
    }
  ],
  "identity": [],
  "summary": {
    "files": 2,
    "blocks": 3,
    "moves": 1,
    "insertions": 1,
    "deletions": 1
  }
}
```

For represented files, every changed line appears in exactly one block. Verification applies all source removals to the parent content, places payloads at destination spans, and byte-compares against the committed file.

## Pairing Algorithm

Pairing is identity-preserving and deterministic:

1. Exact whole-file identity moves are locked first when a removed file's full payload appears as a new file's full payload.
2. A removed line and an added line whose content is unique in the old and new snapshots anchor a pairing.
3. Each anchor extends through adjacent lines with equal content, so non-unique neighbors can join a confident block.
4. Anchoring repeats on leftovers until no unique content remains.
5. When most of an old path's changed content appears in one destination path, exact leftover blocks for that path pair are paired by dominant path identity.
6. Remaining exact delete/insert groups are paired only when doing so improves the objective. Weak one-line common leftovers stay as delete/insert blocks.

A line may only anchor a pairing if it carries enough alphanumeric content to plausibly have identity of its own. Blank lines and lone braces can travel with a larger confident block, but they do not independently become moves.

The embedded algorithm metadata is:

```json
{
  "name": "exact-line-sha256-identity-preserving",
  "version": 2,
  "anchor_min_alnum": 4,
  "exact_block_fallback": true,
  "whole_file_identity": true,
  "git_diff": { "algorithm": "myers", "indent_heuristic": false }
}
```

Git diff input is pinned with `--no-renames`, `--diff-algorithm=myers`, `--no-indent-heuristic`, `--full-index`, `--abbrev=40`, `--no-ext-diff`, `--no-color`, `--no-textconv`, `--submodule=short`, and `--unified=0`.

## Unsupported Files

When a file cannot be faithfully represented as line blocks, it remains in `files[]` with `line_digest_status: "unsupported"` and an `unsupported_reason`: `"binary"`, `"mode_only"`, `"submodule"`, `"filetype"`, or `"unparsed_diff"`.

- Binary files are not represented as line blocks. They report `old_lines: 0`, `new_lines: 0`, and `unsupported_reason: "binary"`.
- Merge commits are rejected. `cache verify --range` skips them.
- Root commits diff against the empty tree.
- Submodule pointer changes, mode-only changes, and file-type changes are represented at file level with unsupported metadata.
- Mode-plus-content changes keep `line_digest_status: "represented"` when content bytes are fully modeled.
