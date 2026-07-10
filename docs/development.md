# Development

## Checks

CI installs dependencies, runs the test suite, builds the package, smoke-tests the packed npm tarball, and runs the built Node CLI against a synthetic Git repo.

Run the same high-signal checks locally with:

```sh
bun test
bun run build
npm pack --dry-run
```

For broader reconstruction coverage, run:

```sh
blockcommit cache --range <rev-range> --cwd <repo>
blockcommit cache verify --range <rev-range> --cwd <repo>
blockcommit digest --range <rev-range> --cwd <repo> --format jsonl --no-cache
```

When run inside the repo, `--cwd` is optional.

## Library

```ts
import {
  digestCommit,
  identityFlows,
  renderContent,
  renderIdentity,
  renderIdentityFrom,
  renderIdentityTo,
  commitStoreView,
  validateDigest,
  verifyCommit,
  verifyDigest
} from "blockcommit";

const digest = digestCommit({ commit: "HEAD" });

console.log(renderContent(digest));
console.log(renderIdentity(digest));
console.log(renderIdentityFrom(digest));
console.log(renderIdentityTo(digest));
console.log(identityFlows(digest));
console.log(commitStoreView("/path/to/repo", "HEAD"));
console.log(validateDigest(digest));

const result = verifyCommit({ commit: "HEAD" });
const saved = verifyDigest({ cwd: "/path/to/repo", digest });
```

The package is ESM-only. It exposes an `import` condition and does not ship a CommonJS compatibility surface.
