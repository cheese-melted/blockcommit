# Development

## Checks

CI installs dependencies, runs the test suite, builds the package, smoke-tests the packed npm tarball, and runs the built Node CLI against a synthetic Git repo.

Canonical golden fixtures run against both the minimum supported Git 2.29 and the current Git supplied by the `ubuntu-latest` runner.

The test suite also exercises malformed cache recovery and concurrent digest writers. Store changes should preserve the rule that `cache` remains readable after a damaged record and that a later digest operation can repair it.

Run the same high-signal checks locally with:

```sh
bun test
bun run typecheck:test
bun run build
npm pack --dry-run
```

For broader reconstruction coverage, run:

```sh
git trails cache --range <rev-range> --cwd <repo>
git trails cache verify --range <rev-range> --cwd <repo>
git trails digest --range <rev-range> --cwd <repo> --format jsonl --no-cache
```

When run inside the repo, `--cwd` is optional.

## Benchmarks

Run the generated performance corpus with:

```sh
bun run bench
```

The JSON report covers many changed files, large files, repeated lines, and one-to-many/many-to-one movement. It records cold-cache and cache-hit wall time plus peak RSS. CI uploads the report as an artifact without enforcing thresholds; canonical behavior remains guarded separately by complete digest fixtures.

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
} from "git-trails";

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
