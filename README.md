# blockcommit

`blockcommit` converts a single-parent git commit into a line-move digest.

The primitive is:

```text
src line span -> dst line span
/dev/null -> dst line span
src line span -> /dev/null
```

Identical removed and added lines are paired as moves. Unpaired added lines are insertions, and unpaired removed lines are deletions. Adjacent line moves are grouped into blocks to keep the digest compact.

```sh
bun install
bun test
bun run build

bun src/cli.ts digest HEAD --pretty
bun src/cli.ts digest HEAD --format blockpatch
```

The JSON digest is the stable first output. A `.blockpatch` rendering is included for blocks that the current `blockpatch` format can represent directly; blocks that need path creation/deletion around moved lines remain in JSON with an `unsupported` reason.
