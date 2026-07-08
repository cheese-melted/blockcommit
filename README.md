# blockcommit

`blockcommit` converts a single-parent git commit into a **line-move digest**: instead of the `+++`/`---` view a normal diff gives you, it expresses the commit as a compact deterministic set of block operations, so line identity is preserved across commits as much as possible.

The primitive is:

```text
src line span -> dst line span    (move)
      (none) -> dst line span    (insert)
src line span -> (none)          (delete)
```

A plain diff forgets where lines came from: moving a function to another file looks like an unrelated deletion plus insertion. `blockcommit` re-pairs identical removed and added lines across the whole commit — including across files — so that moved code keeps its identity, and only genuinely new or gone lines remain as insertions and deletions. Adjacent moved lines are grouped into blocks to keep the digest compact.

The tool serves three related functions:

1. **digest**: canonical JSON for tools, storage, and verification
2. **content**: readable block operations over moved, inserted, and deleted lines
3. **identity**: readable file-continuity views derived from cross-path moves

## Usage

From npm, after the package is published:

```sh
npm install -g blockcommit
blockcommit digest HEAD --pretty
blockcommit content HEAD
blockcommit identity HEAD
blockcommit identity-from HEAD
blockcommit identity-to HEAD

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
blockcommit identity-from HEAD              # where old file content moved
blockcommit identity-to HEAD                # where new file content came from
blockcommit digest --range v1.0..main --format jsonl
blockcommit verify HEAD                     # round-trip check one commit
blockcommit verify HEAD --format json
blockcommit verify digest.json --cwd .      # verify a saved digest against its commit
blockcommit verify digest.json --cwd . --format json
blockcommit verify --range v1.0..main       # round-trip check a whole range
```

`digest [commit] [--cwd <repo>] [--pretty]` prints the canonical JSON digest: the full source of truth for tools, storage, and verification. It includes commit metadata, algorithm/schema metadata, changed file facts, content blocks with spans and payload metadata, derived identity events, and summary counts.

`content [commit] [--cwd <repo>]`, `identity [commit] [--cwd <repo>]`, `identity-from [commit] [--cwd <repo>]`, and `identity-to [commit] [--cwd <repo>]` are readable views over that digest. `content` prints the block-operation layer. `identity` prints the raw pairwise path-flow layer. `identity-from` groups by old file, and `identity-to` groups by new file.

`digest --range <rev-range> --format jsonl` prints one canonical digest JSON record per line.

`verify [commit]` rebuilds every represented changed file from its parent-commit content plus the digest blocks and byte-compares the result against what the commit actually contains. Files that cannot be represented as line blocks are still checked for explicit unsupported metadata. `verify digest.json --cwd <repo>` recomputes the digest for the referenced commit and fails if algorithm metadata, payload encodings, hashes, spans, file facts, block facts, or identity events do not match. Saved digests do not store local checkout paths, so `--cwd` is required when verifying a JSON file. When an argument names both an existing file and a resolvable commit (a stray file named `main`, say), the commit wins; the argument is only read as a saved digest when it does not resolve as a commit. Add `--format json` to return the structured `VerifyResult` instead of human-readable lines. `verify --range <rev-range>` verifies every non-merge commit `git rev-list` produces for the range.

## Canonicality and compatibility

The canonical digest is the JSON value emitted by `blockcommit digest`. It intentionally excludes local checkout paths and other machine-local facts. Two users digesting the same commit from different checkout directories should get byte-identical JSON after normal JSON serialization, and shared digests should not leak filesystem paths. Because saved digests do not identify a local checkout, `blockcommit verify digest.json --cwd <repo>` requires an explicit repository.

The current canonical schema is `blockcommit.digest.v2`, shipped as `schema/blockcommit.digest.v2.schema.json` and exported in the npm package as `blockcommit/schema/blockcommit.digest.v2.schema.json`. The v2 schema includes the discriminated `LineMoveBlock` shape:

- `kind: "move"` has both `src` and `dst` spans.
- `kind: "insert"` has `src: null` and a `dst` span.
- `kind: "delete"` has a `src` span and `dst: null`.

Any change that can alter block IDs, pairings, spans, block grouping, or identity events must bump the algorithm version or the schema version. Consumers should treat `schema_version` and `algorithm` as part of the canonical value, not comments.

## How lines are paired

Pairing is identity-preserving and deterministic:

1. Exact whole-file identity moves are locked first when a removed file's full payload appears as a new file's full payload. This covers ordinary renames and path reuse before line-level pairing can fragment them.
2. A removed line and an added line whose content is **unique** in the old and new snapshots anchor a pairing.
3. Each anchor **extends** through adjacent lines with equal content, so non-unique neighbors (blank lines, lone braces) join a moved block when its context carries them.
4. Anchoring repeats on the leftovers until no unique content remains.
5. When most of an old path's changed content appears in one destination path, exact leftover blocks for that path pair are paired by the internal `dominant_path_identity` stage.
6. Remaining contiguous delete/insert groups with a unique exact payload match are paired as moves only when doing so improves the objective. Multi-line exact blocks with enough alphanumeric content are kept; weak one-line common leftovers are left as honest delete/insert blocks.

A line may only *anchor* a pairing if it carries enough alphanumeric content to plausibly have an identity of its own (compare git's `--color-moved` heuristics). This keeps coincidentally identical trivial lines — a blank line deleted here, an unrelated blank line added there — from pairing into phantom moves. In practice this also minimizes the op count: pairing trivial lines would shatter contiguous insert/delete blocks into many fragments.

The digest is exact about bytes and spans. Identity is best-effort: when several byte-correct pairings are possible, blockcommit chooses the most identity-preserving deterministic pairing it can justify. A bogus weak move is worse than an honest delete plus insert, so common one-line leftovers are not promoted to moves unless stronger context carries them.

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
      "line_digest_status": "represented" }   // or "unsupported"
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
      "payload_sha256": "…", "payload_bytes": 5, "payload_lines": 1
    }
  ],
  "identity": [ /* derived identity events, see below */ ],
  "summary": { "files": 2, "blocks": 3, "moves": 1, "insertions": 1, "deletions": 1 }
}
```

For represented files, every changed line of the commit appears in exactly one block, which is what makes `verify` possible: parent content minus all `src` spans, with payloads placed at their `dst` spans, must reproduce the new tree byte-for-byte. Move blocks always carry exact byte-identical source and destination payloads.

When several exact block candidates compete, the matcher uses internal tie-breaks rather than public per-block metadata: prefer more lines, then more bytes, add a small bonus when the source/destination path pair already has dominant identity evidence, and sort by path/line coordinates as a deterministic final tie-break. That scoring is not part of the canonical digest because it is an implementation detail, not a consumer contract.

When a file cannot be faithfully represented as line blocks, it remains in `files[]` with `line_digest_status: "unsupported"` and an `unsupported_reason`: `"binary"`, `"mode_only"`, `"submodule"`, `"filetype"`, or `"unparsed_diff"`. Mode changes are already captured by `old_mode` and `new_mode`; a mode-only change is unsupported because there are no line blocks to emit, while a mode-plus-content change remains `represented` when the content bytes are fully modeled.

## Content view

`content` renders the content layer as compact movement tuples — the `+++`/`---` of a diff reduced to deterministic `->` operations. `src` coordinates are parent-image, `dst` coordinates are post-image, and `path:start+count` means start at that line and include that many lines:

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

The text view is derived from all cross-path `M` blocks. It does not label events as rename, reuse, exact, or partial; those interpretations can be computed from the counts and the content operations.

## Identity from/to

`identity-from` and `identity-to` group raw identity flow in opposite directions. `identity-from` answers where each old file's moved lines ended up. `identity-to` answers where each new file's moved lines came from.

```text
from old.ts:10 => new.ts 100% (10/10)
from a.ts:10 => b.ts 60% (6/10), unmoved 40% (4/10)
to new.ts:10 <= old.ts 100% (10/10)
to b.ts:20 <= a.ts 30% (6/20), new 70% (14/20)
to app.ts:20 <= model.ts 25% (5/20), view.ts 15% (3/20), new 60% (12/20)
```

The number after a `from` path is the old file's line count; each destination entry is the share of that old file that moved there. `unmoved` is old content that did not move to another path. The number after a `to` path is the new file's line count; each source entry is the share of that new file that came from that source. `new` is destination content that was not moved from another path.

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
- **Submodule pointer changes**, mode-only changes, and file-type changes are represented at file level with unsupported metadata. Mode-plus-content changes keep `line_digest_status: "represented"` when the content bytes are fully modeled. Symlink content changes digest the link target as blob content when the file type itself does not change.

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
  renderContent,
  renderIdentity,
  renderIdentityFrom,
  renderIdentityTo,
  verifyCommit,
  verifyDigest
} from "blockcommit";

const digest = digestCommit({ cwd: "/path/to/repo", commit: "HEAD" });
console.log(digest.identity);                                          // derived identity events
console.log(renderContent(digest));                                    // compact content view
console.log(renderIdentity(digest));                                   // pairwise identity flow
console.log(renderIdentityFrom(digest));                               // where old file content moved
console.log(renderIdentityTo(digest));                                 // where new file content came from
console.log(identityFlows(digest));                                     // structured pairwise identity flow
const result = verifyCommit({ cwd: "/path/to/repo", commit: "HEAD" }); // { ok, files: [...] }
const saved = verifyDigest({ cwd: "/path/to/repo", digest });          // verify a saved JSON digest
```
