# blockcommit

`blockcommit` converts a single-parent git commit into a **line-move digest**: instead of the `+++`/`---` view a normal diff gives you, it expresses the commit as a minimal set of block operations, so line identity is preserved across commits as much as possible.

The primitive is:

```text
src line span -> dst line span    (move)
      (none) -> dst line span    (insert)
src line span -> (none)          (delete)
```

A plain diff forgets where lines came from: moving a function to another file looks like an unrelated deletion plus insertion. `blockcommit` re-pairs identical removed and added lines across the whole commit — including across files — so that moved code keeps its identity, and only genuinely new or gone lines remain as insertions and deletions. Adjacent moved lines are grouped into blocks to keep the digest compact.

The tool is layered:

1. **JSON digest** (core, canonical): exact spans, hashes, payloads
2. **content view**: compact movement tuples, one line per block
3. **identity view**: pairwise file-continuity flow between paths
4. **blockpatch view**: patch-faithful rendering where representable

## Usage

From npm, after the package is published:

```sh
npm install -g blockcommit
blockcommit digest HEAD --pretty
blockcommit content HEAD
blockcommit identity HEAD

# or without a global install
npx blockcommit content HEAD
```

For local development:

```sh
bun install
bun test
bun run build

blockcommit digest HEAD --pretty            # JSON digest
blockcommit content HEAD                    # compact content-op view
blockcommit identity HEAD                   # pairwise file-identity flow
blockcommit digest HEAD --format blockpatch # blockpatch rendering
blockcommit digest HEAD --format blockpatch --strict
blockcommit digest --range v1.0..main --format jsonl
blockcommit verify HEAD                     # round-trip check one commit
blockcommit verify HEAD --format json
blockcommit verify digest.json --cwd .      # verify a saved digest against its commit
blockcommit verify digest.json --cwd . --format json
blockcommit verify --range v1.0..main       # round-trip check a whole range
```

`digest [commit] [--cwd <repo>] [--pretty]` prints the canonical JSON digest: the full source of truth for tools, storage, and verification. It includes commit metadata, algorithm/schema metadata, changed file facts, content blocks with spans and payload metadata, derived identity events, and summary counts.

`content [commit] [--cwd <repo>]` and `identity [commit] [--cwd <repo>]` are readable views over that digest. `content` prints the block-operation layer; `identity` prints the pairwise path-flow layer.

`digest --range <rev-range> --format jsonl` prints one canonical digest JSON record per line. `digest --format blockpatch` prints a derived `.blockpatch` rendering for blocks the current `blockpatch` format can represent directly; blocks that cannot be rendered remain JSON-only with an `unsupported` reason, and a summary of omitted blocks is printed to stderr. Add `--strict` to exit nonzero instead of emitting an incomplete blockpatch stream.

`verify [commit]` rebuilds every represented changed file from its parent-commit content plus the digest blocks and byte-compares the result against what the commit actually contains. Files that cannot be represented as line blocks are still checked for explicit unsupported metadata. `verify digest.json --cwd <repo>` recomputes the digest for the referenced commit and fails if algorithm metadata, payload encodings, hashes, spans, file facts, block facts, or identity events do not match. Saved digests do not store local checkout paths, so `--cwd` is required when verifying a JSON file. When an argument names both an existing file and a resolvable commit (a stray file named `main`, say), the commit wins; the argument is only read as a saved digest when it does not resolve as a commit. Add `--format json` to return the structured `VerifyResult` instead of human-readable lines. `verify --range <rev-range>` verifies every non-merge commit `git rev-list` produces for the range.

## How lines are paired

Pairing is identity-preserving and deterministic:

1. Exact whole-file identity moves are locked first when a removed file's full payload appears as a new file's full payload. This covers ordinary renames and path reuse before line-level pairing can fragment them.
2. A removed line and an added line whose content is **unique** in the old and new snapshots anchor a pairing.
3. Each anchor **extends** through adjacent lines with equal content, so non-unique neighbors (blank lines, lone braces) join a moved block when its context carries them.
4. Anchoring repeats on the leftovers until no unique content remains.
5. When most of an old path's changed content appears in one destination path, exact leftover blocks for that path pair are paired with `dominant_path_identity` metadata.
6. Remaining contiguous delete/insert groups with a unique exact payload match are paired as moves only when doing so improves the objective. Multi-line exact blocks with enough alphanumeric content are kept; weak one-line common leftovers are left as honest delete/insert blocks.

A line may only *anchor* a pairing if it carries enough alphanumeric content to plausibly have an identity of its own (compare git's `--color-moved` heuristics). This keeps coincidentally identical trivial lines — a blank line deleted here, an unrelated blank line added there — from pairing into phantom moves. In practice this also minimizes the op count: pairing trivial lines would shatter contiguous insert/delete blocks into many fragments.

The digest is exact about bytes and spans. Identity is best-effort: when several byte-correct pairings are possible, blockcommit chooses the most identity-preserving deterministic pairing it can justify and marks weak or ambiguous choices in `match`.

The canonical algorithm metadata is embedded in every digest:

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

Any change that can alter block IDs, pairings, spans, block grouping, or identity events must bump the algorithm version or the schema version. Git diff input is pinned with `--no-renames`, `--diff-algorithm=myers`, `--no-indent-heuristic`, `--full-index`, `--abbrev=40`, `--no-ext-diff`, `--no-color`, `--no-textconv`, `--submodule=short`, and `--unified=0`.

## Digest format

Coordinate semantics, since consumers will otherwise guess: `src` spans use **parent-tree** line/byte coordinates and `dst` spans use **new-tree** coordinates.

```jsonc
{
  "schema_version": "blockcommit.digest.v2",
  "algorithm": {
    "name": "exact-line-sha256-identity-preserving",
    "version": 2,
    "anchor_min_alnum": 4,
    "exact_block_fallback": true,
    "whole_file_identity": true,
    "git_diff": { "algorithm": "myers", "indent_heuristic": false }
  },
  "commit": "…", "parent": "…",
  "files": [
    { "path": "a.txt",
      "old_exists": true, "new_exists": true,
      "old_mode": "100644", "new_mode": "100644",
      "old_oid": "…", "new_oid": "…",
      "binary": false,
      "old_lines": 3, "new_lines": 1,
      "old_sha256": "…", "new_sha256": "…",
      "line_digest_status": "represented" }   // or "partial" / "unsupported"
  ],
  "blocks": [
    {
      "id": "bc_0123456789abcdef",
      "kind": "move",                    // "move" | "insert" | "delete"
      "src": { "path": "a.txt", "start_line": 2, "end_line": 2, "line_count": 1,
               "byte_start": 5, "byte_end": 10 },
      "dst": { "path": "b.txt", "start_line": 2, "end_line": 2, "line_count": 1,
               "byte_start": 7, "byte_end": 12 },
      "payload_encoding": "utf-8",       // "utf-8" | "base64"
      "payload_text": "move\n",          // or payload_base64 for non-UTF-8 bytes
      "payload_sha256": "…", "payload_bytes": 5, "payload_lines": 1,
      "match": {
        "algorithm": "exact-line-sha256-identity-preserving",
        "confidence": "exact",
        "ambiguous": false,
        "duplicate_removed_candidates": 0,
        "duplicate_added_candidates": 0,
        "identity_preserving_score": 501,
        "chosen_by": "unique_anchor"
      },
      "blockpatch": { "status": "rendered" }
    }
  ],
  "identity": [ /* derived identity events, see below */ ],
  "summary": { "files": 2, "blocks": 3, "moves": 1, "insertions": 1, "deletions": 1,
               "rendered_blockpatches": 2, "unsupported_blockpatches": 1 }
}
```

For represented files, every changed line of the commit appears in exactly one block, which is what makes `verify` possible: parent content minus all `src` spans, with payloads placed at their `dst` spans, must reproduce the new tree byte-for-byte.

The canonical digest intentionally omits the local repository path. Two checkouts of the same commit should produce byte-identical JSON, and shared digests should not leak filesystem paths.

When a file cannot be faithfully represented as line blocks, it remains in `files[]` with `line_digest_status: "unsupported"` or `"partial"` and an `unsupported_reason`: `"binary"`, `"mode_only"`, `"submodule"`, `"filetype"`, or `"unparsed_diff"`. Agents should treat those entries as explicit "known unknowns" rather than infer from missing blocks.

The published JSON Schema lives at `schema/blockcommit.digest.v2.schema.json` and is included in the npm package. It describes the canonical digest only; blockpatch document text is derived output from `--format blockpatch`, not cached inside JSON digests.

## Content view

`content` renders the content layer as compact movement tuples — the `+++`/`---` of a diff reduced to a minimal set of `->` ops. `src` coordinates are parent-image, `dst` coordinates are post-image, and `path:start+count` means start at that line and include that many lines:

```text
M a.ts:1+6 -> b.ts:1+6
+ a.ts:1+2
- src/dead.ts:1+20
```

This is a display/agent format; the JSON digest stays canonical. The content view drops payload text, payload hashes, byte offsets, and derived identity events.

## Identity view

`identity` renders the file-continuity layer as pairwise line flow between paths:

```text
a.ts:10 -> b.ts:12 (6)
```

This means old `a.ts` had 10 lines, new `b.ts` has 12 lines, and 6 lines moved from `a.ts` to `b.ts` in this commit. A whole-file transfer is just the same notation with matching counts:

```text
a.ts:6 -> b.ts:6 (6)
```

The text view is derived from all cross-path `M` blocks. It does not label events as rename, reuse, exact, or partial; those interpretations can be computed from the counts and the content ops.

The motivating case: cut-paste a whole file to a new name, then create *different* content under the old name. Line moves make this visible; the identity layer makes it explicit:

```jsonc
{
  "kind": "path_reused",               // or "renamed" when the old path vacated
  "old_identity": { "path": "a.ts", "lines": 6, "sha256": "2be6…" },
  "moved_to":     { "path": "b.ts", "lines_moved": 6, "blocks": ["bc_0123456789abcdef"] },
  "new_identity": { "path": "a.ts", "lines": 2, "sha256": "bd9f…" },  // null for renamed
  "confidence": "exact",               // or "partial"
  "coverage": { "old_file_lines_moved": 1, "new_file_lines_from_old": 1 }
}
```

An event is emitted when a strict majority of a file's parent-image lines moved to a single other path. `confidence` is `"exact"` only when *all* old lines moved there and *all* of the destination's post-image lines came from them; anything looser is `"partial"` with floored coverage ratios. For a whole-file move, `old_identity.sha256` equals the move block's `payload_sha256`, tying the layers together. Splits across several destinations and merges below majority are intentionally not named yet — the blocks still carry the raw signal.

## Binary files, and other edges

- **Binary files** (NUL byte in the first 8000 bytes, or files git itself reports as binary) are not represented as line blocks. The file entry includes modes, object IDs, content hashes when blob bytes are available, and `unsupported_reason: "binary"`.
- **Merge commits** are rejected (`verify --range` skips them); the digest is defined against exactly one parent. Root commits diff against the empty tree.
- **Submodule pointer changes**, mode-only changes, and file-type changes are represented at file level with unsupported metadata. Symlink content changes digest the link target as blob content when the file type itself does not change.

## Library

```ts
import { digestCommit, renderIdentity, renderOps, verifyCommit, verifyDigest } from "blockcommit";

const digest = digestCommit({ cwd: "/path/to/repo", commit: "HEAD" });
console.log(digest.identity);                                          // derived identity events
console.log(renderOps(digest));                                        // compact content view
console.log(renderIdentity(digest));                                   // pairwise identity flow
const result = verifyCommit({ cwd: "/path/to/repo", commit: "HEAD" }); // { ok, files: [...] }
const saved = verifyDigest({ cwd: "/path/to/repo", digest });          // verify a saved JSON digest
```
