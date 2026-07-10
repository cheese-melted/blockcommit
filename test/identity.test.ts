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

describe("identity", () => {
  test("names path reuse: whole file cut-pasted elsewhere, old name given new content", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "b.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\n");
    writeFileSync(join(repo, "a.ts"), "export const replacement = true;\nexport const fresh = 1;\n");
    const commit = commitAll(repo, "cut-paste a.ts to b.ts, reuse the name");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "path_reused",
      old_identity: { path: "a.ts", lines: 3 },
      moved_to: { path: "b.ts", lines_moved: 3 },
      new_identity: { path: "a.ts", lines: 2 },
      confidence: "exact"
    });

    const oldA = digest.files.find((file) => file.path === "a.ts");
    const newB = digest.files.find((file) => file.path === "b.ts");
    expect(oldA?.old_sha256).toBe(newB?.new_sha256 ?? "");
    expect(digest.identity[0].old_identity.sha256).toBe(oldA?.old_sha256 ?? "");
    expect(verifyCommit({ cwd: repo, commit }).ok).toBe(true);
  });

  test("names a delete/add rename as an exact renamed event", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "old.txt"), "alpha\nbeta\n");
    commitAll(repo, "base");

    git(repo, ["rm", "old.txt"]);
    writeFileSync(join(repo, "new.txt"), "alpha\nbeta\n");
    const commit = commitAll(repo, "rename without git mv");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      old_identity: { path: "old.txt", lines: 2 },
      moved_to: { path: "new.txt", lines_moved: 2 },
      new_identity: null,
      confidence: "exact"
    });
  });

  test("reports partial confidence when a move is not whole-file", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "moved one()\nmoved two()\nmoved three()\nstays behind()\n");
    commitAll(repo, "base");

    git(repo, ["rm", "a.ts"]);
    writeFileSync(join(repo, "b.ts"), "moved one()\nmoved two()\nmoved three()\n");
    const commit = commitAll(repo, "move most of a.ts");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toHaveLength(1);
    expect(digest.identity[0]).toMatchObject({
      kind: "renamed",
      old_identity: { path: "a.ts", lines: 4 },
      moved_to: { path: "b.ts", lines_moved: 3 },
      new_identity: null,
      confidence: "partial"
    });
    expect(renderIdentity(digest)).toBe("a.ts:4 -> b.ts:3 (3)\n");
  });

  test("emits no identity event for in-file reordering or minority moves", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "function alpha() {}\nfunction bravo() {}\nfunction charlie() {}\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.ts"), "function charlie() {}\nfunction alpha() {}\nfunction bravo() {}\n");
    const commit = commitAll(repo, "reorder in place");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.summary.moves).toBeGreaterThan(0);
    expect(digest.identity).toEqual([]);
  });

  test("renders minority cross-path movement in the pairwise identity view", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "move alpha()\nstay bravo()\nstay charlie()\n");
    writeFileSync(join(repo, "b.ts"), "target delta()\n");
    commitAll(repo, "base");

    writeFileSync(join(repo, "a.ts"), "stay bravo()\nstay charlie()\n");
    writeFileSync(join(repo, "b.ts"), "target delta()\nmove alpha()\n");
    const commit = commitAll(repo, "move one line across paths");

    const digest = digestCommit({ cwd: repo, commit });
    expect(digest.identity).toEqual([]);
    expect(renderIdentity(digest)).toBe("a.ts:3 -> b.ts:2 (1)\n");
    expect(renderIdentityFrom(digest)).toBe("from a.ts:3 => b.ts (1/3, 33.3%), unmoved (2/3, 66.7%)\n");
    expect(renderIdentityFrom(digest, { pretty: true })).toBe(
      "a.ts:3  ->  b.ts     (1/3, 33.3%)\n" +
      "            unmoved  (2/3, 66.7%)\n"
    );
    expect(renderIdentityTo(digest)).toBe("to b.ts:2 <= a.ts (1/2, 50%), new (1/2, 50%)\n");
    expect(renderIdentityTo(digest, { pretty: true })).toBe(
      "b.ts:2  <-  a.ts  (1/2, 50%)\n" +
      "            new   (1/2, 50%)\n"
    );
  });

  test("summarizes new-file identity makeup", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "part one()\npart two()\n");
    writeFileSync(join(repo, "b.ts"), "part three()\npart four()\n");
    commitAll(repo, "base");

    git(repo, ["rm", "a.ts"]);
    git(repo, ["rm", "b.ts"]);
    writeFileSync(join(repo, "c.ts"), "part one()\npart two()\npart three()\npart four()\n");
    const mergeCommit = commitAll(repo, "merge files");

    const mergeDigest = digestCommit({ cwd: repo, commit: mergeCommit });
    expect(renderIdentityFrom(mergeDigest)).toBe(
      "from a.ts:2 => c.ts (2/2, 100%)\n" +
      "from b.ts:2 => c.ts (2/2, 100%)\n"
    );
    expect(renderIdentityTo(mergeDigest)).toBe("to c.ts:4 <= a.ts (2/4, 50%), b.ts (2/4, 50%)\n");

    git(repo, ["rm", "c.ts"]);
    writeFileSync(join(repo, "d.ts"), "part one()\npart two()\n");
    writeFileSync(join(repo, "e.ts"), "part three()\npart four()\n");
    const splitCommit = commitAll(repo, "split file");

    const splitDigest = digestCommit({ cwd: repo, commit: splitCommit });
    expect(renderIdentityFrom(splitDigest)).toBe("from c.ts:4 => d.ts (2/4, 50%), e.ts (2/4, 50%)\n");
    expect(renderIdentityTo(splitDigest)).toBe(
      "to d.ts:2 <= c.ts (2/2, 100%)\n" +
      "to e.ts:2 <= c.ts (2/2, 100%)\n"
    );
  });
});
