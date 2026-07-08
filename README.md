# blockcommit

`blockcommit` converts a single-parent git commit into a **line-move digest**: instead of the `+++`/`---` view a normal diff gives you, it expresses the commit as a compact deterministic set of block operations, so line identity is preserved across commits as much as possible.

The primitive is:

```text
src line span -> dst line span    (move)
      (none) -> dst line span    (insert)
src line span -> (none)          (delete)
```

A plain diff forgets where lines came from: moving a function to another file looks like an unrelated deletion plus insertion. `blockcommit` re-pairs identical removed and added lines across the whole commit — including across files — so that moved code keeps its identity, and only genuinely new or gone lines remain as insertions and deletions. Adjacent moved lines are grouped into blocks to keep the digest compact.

The tool is layered:

1. **JSON digest** (core, canonical): exact spans, hashes, payloads, and match metadata
2. **content view**: compact movement tuples, one line per block
3. **identity view**: pairwise file-continuity flow between paths
4. **identity summary**: reduced path-flow labels and percentages
5. **blockpatch view**: patch-faithful rendering where representable

## Usage

From npm, after the package is published:

```sh
npm install -g blockcommit
blockcommit digest HEAD --pretty
blockcommit content HEAD
blockcommit identity HEAD
blockcommit identity-summary HEAD

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
blockcommit identity-summary HEAD           # labeled identity percentages
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

`content [commit] [--cwd <repo>]`, `identity [commit] [--cwd <repo>]`, and `identity-summary [commit] [--cwd <repo>]` are readable views over that digest. `content` prints the block-operation layer. `identity` prints the raw pairwise path-flow layer. `identity-summary` reduces those flows into labels and source/destination percentages.

`digest --range <rev-range> --format jsonl` prints one canonical digest JSON record per line. `digest --format blockpatch` prints a derived `.blockpatch` rendering for blocks the current `blockpatch` format can represent directly; blocks that cannot be rendered remain JSON-only with an `unsupported` reason, and a summary of omitted blocks is printed to stderr. Add `--strict` to exit nonzero instead of emitting an incomplete blockpatch stream.

`verify [commit]` rebuilds every represented changed file from its parent-commit content plus the digest blocks and byte-compares the result against what the commit actually contains. Files that cannot be represented as line blocks are still checked for explicit unsupported metadata. `verify digest.json --cwd <repo>` recomputes the digest for the referenced commit and fails if algorithm metadata, payload encodings, hashes, spans, file facts, block facts, or identity events do not match. Saved digests do not store local checkout paths, so `--cwd` is required when verifying a JSON file. When an argument names both an existing file and a resolvable commit (a stray file named `main`, say), the commit wins; the argument is only read as a saved digest when it does not resolve as a commit. Add `--format json` to return the structured `VerifyResult` instead of human-readable lines. `verify --range <rev-range>` verifies every non-merge commit `git rev-list` produces for the range.

## Canonicality and compatibility

The canonical digest is the JSON value emitted by `blockcommit digest`. It intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization, and shared digests should not leak filesystem paths. Because saved digests do not identify a local checkout, `blockcommit verify digest.json --cwd <repo>` requires an explicit repository.

The current canonical schema is `blockcommit.digest.v2`, shipped as `schema/blockcommit.digest.v2.schema.json` and exported in the npm package as `blockcommit/schema/blockcommit.digest.v2.schema.json`. The v2 schema includes the discriminated `LineMoveBlock` shape:

- `kind: "move"` has both `src` and `dst` spans.
- `kind: "insert"` has `src: null` and a `dst` span.
- `kind: "delete"` has a `src` span and `dst: null`.

Any change that can alter block IDs, pairings, spans, block grouping, match metadata, or identity events must bump the algorithm version or the schema version. Consumers should treat `schema_version` and `algorithm` as part of the canonical value, not comments.

## How lines are paired

Pairing is identity-preserving and deterministic:

1. Exact whole-file identity moves are locked first when a removed file's full payload appears as a new file's full payload. This covers ordinary renames and path reuse before line-level pairing can fragment them.
2. A removed line and an added line whose content is **unique** in the old and new snapshots anchor a pairing.
3. Each anchor **extends** through adjacent lines with equal content, so non-unique neighbors (blank lines, lone braces) join a moved block when its context carries them.
4. Anchoring repeats on the leftovers until no unique content remains.
5. When most of an old path's changed content appears in one destination path, exact leftover blocks for that path pair are paired with `dominant_path_identity` metadata.
6. Remaining contiguous delete/insert groups with a unique exact payload match are paired as moves only when doing so improves the objective. Multi-line exact blocks with enough alphanumeric content are kept; weak one-line common leftovers are left as honest delete/insert blocks.

A line may only *anchor* a pairing if it carries enough alphanumeric content to plausibly have an identity of its own (compare git's `--color-moved` heuristics). This keeps coincidentally identical trivial lines — a blank line deleted here, an unrelated blank line added there — from pairing into phantom moves. In practice this also minimizes the op count: pairing trivial lines would shatter contiguous insert/delete blocks into many fragments.

The digest is exact about bytes and spans. Identity is best-effort: when several byte-correct pairings are possible, blockcommit chooses the most identity-preserving deterministic pairing it can justify and marks weak or ambiguous choices in `match`. A bogus weak move is worse than an honest delete plus insert, so common one-line leftovers are not promoted to moves unless stronger context carries them.

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

Git diff input is pinned with `--no-renames`, `--diff-algorithm=myers`, `--no-indent-heuristic`, `--full-index`, `--abbrev=40`, `--no-ext-diff`, `--no-color`, `--no-textconv`, `--submodule=short`, and `--unified=0`.

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

Every block carries `match` metadata:

- `algorithm` repeats the pairing algorithm name used for the digest.
- `confidence` is `"exact"`, `"strong"`, `"weak"`, or `"ambiguous"`.
- `ambiguous` is true when equal content had duplicate candidates on either side or a prior stage marked the choice ambiguous.
- `duplicate_removed_candidates` and `duplicate_added_candidates` count same-content alternatives beyond the chosen line.
- `identity_preserving_score` is a deterministic internal score used to prefer larger, clearer moves.
- `chosen_by` records the stage that selected the match: `whole_file_identity`, `unique_anchor`, `dominant_path_identity`, `exact_block_fallback`, `best_effort_tiebreak`, or `unpaired`.

When a file cannot be faithfully represented as line blocks, it remains in `files[]` with `line_digest_status: "unsupported"` or `"partial"` and an `unsupported_reason`: `"binary"`, `"mode_only"`, `"submodule"`, `"filetype"`, or `"unparsed_diff"`. Agents should treat those entries as explicit "known unknowns" rather than infer from missing blocks.

The published JSON Schema describes the canonical digest only; blockpatch document text is derived output from `--format blockpatch`, not cached inside JSON digests.

## Content view

`content` renders the content layer as compact movement tuples — the `+++`/`---` of a diff reduced to deterministic `->` ops. `src` coordinates are parent-image, `dst` coordinates are post-image, and `path:start+count` means start at that line and include that many lines:

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

## Identity summary

`identity-summary` reduces the raw identity flow into per-edge source coverage and destination makeup:

```text
rename old.ts -> new.ts src=100% dst=100% (10/10 -> 10/10)
flow a.ts -> b.ts src=60% dst=30% (6/10 -> 6/20)
split page.ts -> header.ts src=40% dst=100% (4/10 -> 4/4)
merge model.ts -> app.ts src=100% dst=25% (5/5 -> 5/20)
```

`src` is the percentage of the old source file that moved to the destination. `dst` is the percentage of the new destination file that came from the source. Labels are derived from the identity graph: whole-file transfers become `rename` or `reuse`, one source to multiple destinations becomes `split`, multiple sources to one destination becomes `merge`, pairs that are both split and merge become `split+merge`, and everything else is `flow`.

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

## Development and release checks

CI installs dependencies, runs the test suite, builds the package, smoke-tests the packed npm tarball, and then runs the built Node CLI against a synthetic git repo. The npm-pack smoke test checks package contents, the `blockcommit` bin, library exports, and the exported v2 schema path. Locally, the same high-signal checks are:

```sh
bun test
bun run build
npm pack --dry-run
```

For broader reconstruction coverage, run `blockcommit verify --range <rev-range> --cwd <repo>` against a real repository history.

## Library

```ts
import {
  digestCommit,
  identityFlows,
  renderIdentity,
  renderIdentitySummary,
  renderOps,
  verifyCommit,
  verifyDigest
} from "blockcommit";

const digest = digestCommit({ cwd: "/path/to/repo", commit: "HEAD" });
console.log(digest.identity);                                          // derived identity events
console.log(renderOps(digest));                                        // compact content view
console.log(renderIdentity(digest));                                   // pairwise identity flow
console.log(renderIdentitySummary(digest));                            // labeled identity percentages
console.log(identityFlows(digest));                                     // structured pairwise identity flow
const result = verifyCommit({ cwd: "/path/to/repo", commit: "HEAD" }); // { ok, files: [...] }
const saved = verifyDigest({ cwd: "/path/to/repo", digest });          // verify a saved JSON digest
```
