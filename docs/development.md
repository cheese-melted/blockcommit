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
blockcommit verify --range <rev-range> --cwd <repo>
```

## Library

```ts
import {
  couplingPayload,
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

console.log(renderContent(digest));
console.log(renderIdentity(digest));
console.log(renderIdentityFrom(digest));
console.log(renderIdentityTo(digest));
console.log(identityFlows(digest));
console.log(couplingPayload(digest));

const result = verifyCommit({ cwd: "/path/to/repo", commit: "HEAD" });
const saved = verifyDigest({ cwd: "/path/to/repo", digest });
```

The package is ESM-only. It exposes an `import` condition and does not ship a CommonJS compatibility surface.
