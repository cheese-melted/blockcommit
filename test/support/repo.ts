import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories = new Set<string>();
const projectRoot = resolve(import.meta.dir, "../..");

export function cleanupTempDirectories(): void {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
}

export function makeTempDir(prefix = "git-trails-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function makeRepo(): string {
  const repo = makeTempDir();
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  return repo;
}

export function commitAll(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

export function commitCanonicalTree(repo: string, message: string, date: string, parent?: string): string {
  git(repo, ["add", "."]);
  const tree = git(repo, ["write-tree"]);
  const commit = gitWithEnvironment(
    repo,
    ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", message],
    {
      GIT_AUTHOR_NAME: "Canonical Fixture",
      GIT_AUTHOR_EMAIL: "canonical@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Canonical Fixture",
      GIT_COMMITTER_EMAIL: "canonical@example.com",
      GIT_COMMITTER_DATE: date
    }
  );
  git(repo, ["update-ref", "HEAD", commit]);
  return commit;
}

export function cli(args: string[], cwd = projectRoot, environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [join(projectRoot, "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: environment
  });
}

function gitWithEnvironment(cwd: string, args: string[], environment: Record<string, string>): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
