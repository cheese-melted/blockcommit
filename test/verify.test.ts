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

describe("verifyCommit", () => {
  test("round-trips a commit mixing moves, edits, creations, and deletions", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(repo, "gone.txt"), "so long\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.txt"), "one\nthree\nfour!\nfive\ntwo\n");
    git(repo, ["rm", "gone.txt"]);
    writeFileSync(join(repo, "fresh.txt"), "brand new\nno trailing newline");
    const commit = commitAll(repo, "mixed change");

    const result = verifyCommit({ cwd: repo, commit });
    expect(result.ok).toBe(true);
    expect(result.files.map((file) => file.path).sort()).toEqual(["a.txt", "fresh.txt", "gone.txt"]);
  });

  test("generated hard commits verify, validate, and digest deterministically across paths", () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "schema", `${schemaVersion}.schema.json`), "utf8")
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);

    for (let seed = 1; seed <= 12; seed += 1) {
      const repo = makeRepo();
      git(repo, ["config", "core.filemode", "true"]);
      const generated = generatedCommitCase(seed);
      applyFiles(repo, generated.oldFiles);
      commitAll(repo, `generated base ${seed}`);

      replaceFiles(repo, generated.oldFiles, generated.newFiles);
      const commit = commitAll(repo, `generated change ${seed}`);

      const digest = digestCommit({ cwd: repo, commit });
      const verifyResult = verifyCommit({ cwd: repo, commit });
      expect(verifyResult.files.filter((file) => !file.ok)).toEqual([]);
      expect(validate(digest)).toBe(true);

      const clone = makeTempDir("git-trails-fuzz-clone-");
      git(repo, ["clone", repo, clone]);
      expect(JSON.stringify(digestCommit({ cwd: clone, commit }))).toBe(JSON.stringify(digest));
    }
  }, 30_000);

  test("round-trips every commit in this repository's history", () => {
    const commits = listCommits(import.meta.dir, "HEAD");
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      const result = verifyCommit({ cwd: import.meta.dir, commit });
      const failures = result.files.filter((file) => !file.ok);
      expect(failures).toEqual([]);
    }
  });

  test("verifyDigest rejects stale or malicious identity events", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const digest = digestCommit({ cwd: repo, commit });
    expect(verifyDigest({ cwd: repo, digest }).ok).toBe(true);

    const tampered = JSON.parse(JSON.stringify(digest)) as typeof digest;
    tampered.identity[0].kind = "path_reused";
    const result = verifyDigest({ cwd: repo, digest: tampered });
    expect(result.ok).toBe(false);
    expect(result.files).toContainEqual({
      path: "<digest>",
      ok: false,
      reason: "identity does not match recomputed digest"
    });
  });

  test("validateDigest reports schema failures before saved digest verification", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "file.txt"), "base\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "file.txt"), "base\nnext\n");
    const commit = commitAll(repo, "add line");
    const digest = digestCommit({ cwd: repo, commit });

    expect(validateDigest(digest)).toEqual({ ok: true, errors: [] });

    const malformed: Record<string, unknown> = { ...digest };
    delete malformed.blocks;
    const validation = validateDigest(malformed);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      path: "/",
      keyword: "required",
      message: expect.stringContaining("blocks")
    }));

    const result = verifyDigest({ cwd: repo, digest: malformed });
    expect(result).toMatchObject({
      commit,
      ok: false,
      files: [
        {
          path: "<digest>",
          ok: false,
          reason: expect.stringContaining("schema validation failed")
        }
      ]
    });
  });
});
