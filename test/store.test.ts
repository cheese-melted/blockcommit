import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("store", () => {
  test("keeps the worktree clean even when the old cache path is tracked", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".git-trails"), "tracked project file\n");
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "change");

    const result = cli(["view", commit, "--cwd", repo]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(repo, ".git-trails"), "utf8")).toBe("tracked project file\n");
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, ".git", "git-trails", "index.json"))).toBe(true);
  });

  test("refuses file and symlink collisions at the private cache path", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "change");
    const root = join(repo, ".git", "git-trails");

    writeFileSync(root, "collision\n");
    const fileResult = cli(["view", commit, "--cwd", repo]);
    expect(fileResult.status).toBe(1);
    expect(fileResult.stderr).toContain("Git cache path because it is not a directory");
    rmSync(root);

    if (process.platform !== "win32") {
      const target = makeTempDir("git-trails-cache-target-");
      symlinkSync(target, root, "dir");
      const symlinkResult = cli(["view", commit, "--cwd", repo]);
      expect(symlinkResult.status).toBe(1);
      expect(symlinkResult.stderr).toContain("Git cache path because it is a symbolic link");
    }
  });

  test("builds the cache by default and supports --no-cache", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const commit = commitAll(repo, "two");
    const root = join(repo, ".git", "git-trails");

    const uncached = cli(["view", commit, "--cwd", repo, "--no-cache"]);
    expect(uncached.status).toBe(0);
    expect(existsSync(root)).toBe(false);

    const cached = cli(["view", commit, "--cwd", repo]);
    expect(cached.status).toBe(0);
    expect(existsSync(join(root, "index.json"))).toBe(true);
    expect(existsSync(join(root, "digests", `${commit}.json`))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "digests")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "index.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "digests", `${commit}.json`)).mode & 0o777).toBe(0o600);
    }

    const view = cli(["cache", "--range", `${commit}^..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(view.status).toBe(0);
    expect(JSON.parse(view.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 1, undigested: 0, skipped: 0 }
    });
  });

  test("reports cache state and lets digest ranges warm the cache", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");

    const tracked = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(tracked.status).toBe(0);
    expect(JSON.parse(tracked.stdout)).toMatchObject({
      schema_version: "git-trails.commit-store.v2",
      summary: { tracked: 1, digested: 0, undigested: 1, skipped: 0 },
      commits: [{ commit: second, status: "undigested" }]
    });

    const root = join(repo, ".git", "git-trails");
    expect(existsSync(join(root, "index.json"))).toBe(true);

    const warmed = cli(["digest", "--range", `${first}..${second}`, "--cwd", repo, "--format", "jsonl"]);
    expect(warmed.status).toBe(0);
    expect(warmed.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(root, "digests", `${second}.json`))).toBe(true);

    const cached = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(cached.status).toBe(0);
    expect(JSON.parse(cached.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 1, undigested: 0, skipped: 0 },
      commits: [{ commit: second, status: "digested" }]
    });

    const text = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("tracked 1 commits (digested 1, undigested 0, invalid 0, skipped 0)");
    expect(text.stdout).toContain(`D ${second.slice(0, 12)} ${first.slice(0, 12)}`);
  });

  test("ignores and overwrites cached digests that do not match the requested commit info", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");
    const root = join(repo, ".git", "git-trails");

    const cached = cli(["digest", second, "--cwd", repo]);
    expect(cached.status).toBe(0);
    const original = JSON.parse(cached.stdout);
    expect(original.parent).toBe(first);

    const digestPath = join(root, "digests", `${second}.json`);
    const poisoned = { ...original, parent: "0".repeat(40) };
    writeFileSync(digestPath, `${JSON.stringify(poisoned)}\n`);

    const status = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 0, undigested: 0, invalid: 1, skipped: 0 },
      commits: [{ commit: second, status: "invalid", reason: "incompatible_digest" }]
    });

    const repaired = cli(["digest", second, "--cwd", repo]);
    expect(repaired.status).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ commit: second, parent: first });
    expect(JSON.parse(readFileSync(digestPath, "utf8"))).toMatchObject({ commit: second, parent: first });
  });

  test("reports malformed store files and repairs them on the next digest", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "one\n");
    const first = commitAll(repo, "one");
    writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
    const second = commitAll(repo, "two");
    const root = join(repo, ".git", "git-trails");

    expect(cli(["digest", second, "--cwd", repo]).status).toBe(0);
    writeFileSync(join(root, "index.json"), JSON.stringify({
      schema_version: "git-trails.commit-store.v1",
      commits: {}
    }));

    const upgradedIndex = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(upgradedIndex.status).toBe(0);
    expect(JSON.parse(upgradedIndex.stdout).schema_version).toBe("git-trails.commit-store.v2");

    writeFileSync(join(root, "index.json"), "{\n");
    writeFileSync(join(root, "index.lock"), "999999999\n");

    const rebuiltIndex = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(rebuiltIndex.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))).toMatchObject({
      schema_version: "git-trails.commit-store.v2",
      commits: { [second]: { commit: second, parents: [first] } }
    });

    const digestPath = join(root, "digests", `${second}.json`);
    writeFileSync(digestPath, "{\n");
    writeFileSync(`${digestPath}.interrupted.tmp`, "partial");

    const invalid = cli(["cache", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(invalid.status).toBe(0);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      summary: { tracked: 1, digested: 0, undigested: 0, invalid: 1, skipped: 0 },
      commits: [{ commit: second, status: "invalid", reason: "malformed_digest" }]
    });

    const verification = cli(["cache", "verify", "--range", `${first}..${second}`, "--cwd", repo, "--format", "json"]);
    expect(verification.status).toBe(1);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      summary: { checked: 1, ok: 0, failed: 1, missing: 0, skipped: 0 },
      results: [{ commit: second, ok: false }]
    });

    const repaired = cli(["digest", second, "--cwd", repo]);
    expect(repaired.status).toBe(0);
    expect(JSON.parse(readFileSync(digestPath, "utf8"))).toMatchObject({ commit: second, parent: first });
  });

  test("preserves every index update from concurrent digest writers", async () => {
    const repo = makeRepo();
    const commits: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(repo, "file.txt"), `${index}\n`);
      commits.push(commitAll(repo, `commit ${index}`));
    }

    const executable = join(import.meta.dir, "..", "src", "cli.ts");
    const processes = commits.map((commit) => Bun.spawn(
      ["bun", executable, "digest", commit, "--cwd", repo],
      { stdout: "ignore", stderr: "pipe" }
    ));
    const statuses = await Promise.all(processes.map((process) => process.exited));
    expect(statuses).toEqual(commits.map(() => 0));

    const index = JSON.parse(readFileSync(
      join(repo, ".git", "git-trails", "index.json"),
      "utf8"
    ));
    expect(index.schema_version).toBe("git-trails.commit-store.v2");
    expect(Object.keys(index.commits).sort()).toEqual([...commits].sort());
  });

  test("verifies cached digests against their referenced commits", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    const first = commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");

    const missing = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schema_version: "git-trails.cache-verify.v1",
      summary: { checked: 0, ok: 0, failed: 0, missing: 1, skipped: 0 },
      results: []
    });

    const warmed = cli(["digest", commit, "--cwd", repo]);
    expect(warmed.status).toBe(0);

    const ok = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`ok ${commit.slice(0, 12)}`);
    expect(ok.stdout).toContain("verified 1/1 cached commits");

    const okJson = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo, "--format", "json"]);
    expect(okJson.status).toBe(0);
    expect(JSON.parse(okJson.stdout)).toMatchObject({
      schema_version: "git-trails.cache-verify.v1",
      summary: { checked: 1, ok: 1, failed: 0, missing: 0, skipped: 0 },
      results: [{ commit, ok: true }]
    });

    const digestPath = join(repo, ".git", "git-trails", "digests", `${commit}.json`);
    const tampered = JSON.parse(readFileSync(digestPath, "utf8"));
    tampered.blocks[0].payload_sha256 = "0".repeat(64);
    writeFileSync(digestPath, JSON.stringify(tampered));

    const fail = cli(["cache", "verify", "--range", `${first}..${commit}`, "--cwd", repo]);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("payload_sha256");
  });


});
