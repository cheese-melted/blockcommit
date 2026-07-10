import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { renderContent } from "../src/content.js";
import { digestCommit } from "../src/digest.js";
import { listCommits } from "../src/git.js";
import { renderIdentity, renderIdentityFrom, renderIdentityTo } from "../src/identity-view.js";
import { validateDigest } from "../src/index.js";
import { schemaVersion } from "../src/types.js";
import { verifyCommit, verifyDigest } from "../src/verify.js";
import { applyFiles, generatedCommitCase, replaceFiles } from "./support/generated-case.js";
import { cleanupTempDirectories, cli, commitAll, commitCanonicalTree, git, makeRepo, makeTempDir } from "./support/repo.js";

afterEach(cleanupTempDirectories);

describe("cli", () => {
  test("reports a missing Git executable clearly", () => {
    const repo = makeRepo();
    const emptyPath = makeTempDir("git-trails-empty-path-");
    const result = cli(
      ["digest", "HEAD", "--cwd", repo, "--no-cache"],
      repo,
      { ...process.env, PATH: emptyPath }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git executable not found on PATH");
  });

  test("rejects unsupported Git versions clearly", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const commit = commitAll(repo, "base");
    const realGit = Bun.which("git");
    expect(realGit).not.toBeNull();
    const fakeBin = makeTempDir("git-trails-old-git-");
    const fakeGit = join(fakeBin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "git version 2.28.0"\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`
    );
    chmodSync(fakeGit, 0o755);

    const result = cli(
      ["digest", commit, "--cwd", repo, "--no-cache"],
      repo,
      { ...process.env, PATH: fakeBin }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Git 2.29 or newer; found git version 2.28.0");
  });

  test("supports --cwd for digesting another repository", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const result = cli(["view", commit, "--cwd", repo]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\+ file\.txt:2\+1$/m);
  });

  test("prints pairwise identity flows", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\ngamma\n");
    const commit = commitAll(repo, "rename without git mv");

    const result = cli(["view", commit, "--cwd", repo, "--view", "identity"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("old.txt:2 -> new.txt:3 (2)\n");

    const alias = cli(["view", commit, "--cwd", repo, "--identity"]);
    expect(alias.status).toBe(0);
    expect(alias.stdout).toBe(result.stdout);

    const from = cli(["view", commit, "--cwd", repo, "--view", "identity-from"]);
    expect(from.status).toBe(0);
    expect(from.stdout).toBe("old.txt:2  ->  new.txt  (2/2, 100%)\n");

    const to = cli(["view", commit, "--cwd", repo, "--view", "identity-to"]);
    expect(to.status).toBe(0);
    expect(to.stdout).toBe("new.txt:3  <-  old.txt  (2/3, 66.7%)\n");

    const toAlias = cli(["view", commit, "--cwd", repo, "--identity-to"]);
    expect(toAlias.status).toBe(0);
    expect(toAlias.stdout).toBe(to.stdout);
  });

  test("prints empty identity view messages", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "add line");

    const identity = cli(["view", commit, "--cwd", repo, "--identity"]);
    expect(identity.status).toBe(0);
    expect(identity.stdout).toBe("no cross-path identity flows\n");

    const from = cli(["view", commit, "--cwd", repo, "--identity-from"]);
    expect(from.status).toBe(0);
    expect(from.stdout).toBe("no cross-path identity sources\n");

    const to = cli(["view", commit, "--cwd", repo, "--identity-to"]);
    expect(to.status).toBe(0);
    expect(to.stdout).toBe("no cross-path identity destinations\n");
  });

  test("supports pointing --cwd at a .git directory", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "two");
    const gitDir = join(repo, ".git");

    const worktreeResult = cli(["view", commit, "--cwd", repo]);
    expect(worktreeResult.status).toBe(0);
    expect(existsSync(join(gitDir, "git-trails", "index.json"))).toBe(true);
    expect(existsSync(join(repo, ".git-trails"))).toBe(false);
    expect(existsSync(join(gitDir, ".bgit_cache"))).toBe(false);

    const result = cli(["view", commit, "--cwd", gitDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("+ file.txt:2+1\n");
  });

  test("shares the cache through the Git common directory across linked worktrees", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");
    const worktreeParent = makeTempDir("git-trails-worktree-");
    const linked = join(worktreeParent, "linked");
    git(repo, ["worktree", "add", "--detach", linked, second]);

    const linkedResult = cli(["view", second, "--cwd", linked]);
    expect(linkedResult.status).toBe(0);
    expect(existsSync(join(linked, ".git-trails"))).toBe(false);

    const commonStore = join(repo, ".git", "git-trails");
    expect(existsSync(join(commonStore, "digests", `${second}.json`))).toBe(true);

    const mainResult = cli([
      "cache",
      "--range",
      `${first}..${second}`,
      "--cwd",
      repo,
      "--format",
      "json"
    ]);
    expect(mainResult.status).toBe(0);
    expect(JSON.parse(mainResult.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 1, undigested: 0 }
    });
  });

  test("prints canonical digest ranges as JSONL", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const result = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const digest = JSON.parse(lines[0]);
    expect(digest.commit).toBe(second);
    expect(digest.schema_version).toBe("git-trails.digest.v4");
  });

  test("reports bad commits and unknown options", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");

    const badCommit = cli(["digest", "not-a-commit", "--cwd", repo]);
    expect(badCommit.status).toBe(1);
    expect(badCommit.stderr).toContain("git rev-parse");

    const unknownOption = cli(["digest", "--definitely-unknown"], repo);
    expect(unknownOption.status).toBe(1);
    expect(unknownOption.stderr).toContain("unknown option");

    const noCacheStoreCommand = cli(["cache", "--no-cache", "--cwd", repo]);
    expect(noCacheStoreCommand.status).toBe(1);
    expect(noCacheStoreCommand.stderr).toContain("cache does not support --no-cache");
  });

  test("rejects removed commands and invalid view options", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const content = cli(["content", second, "--cwd", repo]);
    expect(content.status).toBe(1);
    expect(content.stderr).toContain("unknown command: content");

    const identity = cli(["identity", second, "--cwd", repo]);
    expect(identity.status).toBe(1);
    expect(identity.stderr).toContain("unknown command: identity");

    const commits = cli(["commits", "--range", `${first}..${second}`, "--cwd", repo]);
    expect(commits.status).toBe(1);
    expect(commits.stderr).toContain("unknown command: commits");

    const verify = cli(["verify", second, "--cwd", repo]);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain("unknown command: verify");

    const digestRange = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl", "--pretty"]);
    expect(digestRange.status).toBe(1);
    expect(digestRange.stderr).toContain("unknown option: --pretty");

    const digestJsonl = cli(["digest", second, "--cwd", repo, "--format", "jsonl", "--pretty"]);
    expect(digestJsonl.status).toBe(1);
    expect(digestJsonl.stderr).toContain("unknown option: --pretty");

    const viewRange = cli(["view", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(viewRange.status).toBe(1);
    expect(viewRange.stderr).toContain("view does not support --range");

    const removedView = cli(["view", second, "--cwd", repo, "--view", "coupling", "--format", "jsonl"]);
    expect(removedView.status).toBe(1);
    expect(removedView.stderr).toContain("unknown view: coupling");

    const removedFlag = cli(["view", second, "--cwd", repo, "--coupling"]);
    expect(removedFlag.status).toBe(1);
    expect(removedFlag.stderr).toContain("unknown option: --coupling");

    const cacheVerify = cli(["cache", "verify", "--cwd", repo, "--pretty"]);
    expect(cacheVerify.status).toBe(1);
    expect(cacheVerify.stderr).toContain("unknown option: --pretty");
  });


});
