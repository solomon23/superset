import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listExternalWorktrees, removeWorktree } from "../utils/git";

const TEST_DIR = join(
	realpathSync(tmpdir()),
	`superset-test-delete-wt-${process.pid}`,
);

function createTestRepo(name: string): string {
	const repoPath = join(TEST_DIR, name);
	mkdirSync(repoPath, { recursive: true });
	execSync("git init", { cwd: repoPath, stdio: "ignore" });
	execSync("git config user.email 'test@test.com'", {
		cwd: repoPath,
		stdio: "ignore",
	});
	execSync("git config user.name 'Test'", {
		cwd: repoPath,
		stdio: "ignore",
	});
	return repoPath;
}

function seedCommit(repoPath: string, message = "init"): void {
	writeFileSync(join(repoPath, "README.md"), `# test\n${message}\n`);
	execSync(`git add . && git commit -m '${message}'`, {
		cwd: repoPath,
		stdio: "ignore",
	});
}

describe("Workspace deletion worktree cleanup (#2863)", () => {
	let mainRepoPath: string;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });

		mainRepoPath = createTestRepo("main-repo");
		seedCommit(mainRepoPath, "initial commit");
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	test("listExternalWorktrees returns Superset-created worktrees (the root cause)", async () => {
		// Simulate what Superset does: create a worktree via git
		const worktreePath = join(TEST_DIR, "worktrees", "my-workspace");
		mkdirSync(join(TEST_DIR, "worktrees"), { recursive: true });
		execSync(`git worktree add "${worktreePath}" -b feature-branch`, {
			cwd: mainRepoPath,
			stdio: "ignore",
		});

		// listExternalWorktrees returns ALL worktrees, including Superset-created ones.
		// This was the root cause: the delete handler used this list to "safety check"
		// whether a worktree was external, but since ALL worktrees appear here,
		// the check always triggered, skipping disk cleanup.
		const externalWorktrees = await listExternalWorktrees(mainRepoPath);
		const found = externalWorktrees.find((wt) => wt.path === worktreePath);

		expect(found).toBeDefined();
		expect(found?.branch).toBe("feature-branch");
	});

	test("removeWorktree removes a Superset-created worktree from disk", async () => {
		const worktreePath = join(TEST_DIR, "worktrees", "my-workspace");
		mkdirSync(join(TEST_DIR, "worktrees"), { recursive: true });
		execSync(`git worktree add "${worktreePath}" -b feature-branch`, {
			cwd: mainRepoPath,
			stdio: "ignore",
		});

		// Add a file to simulate real workspace content
		writeFileSync(join(worktreePath, "work.txt"), "important work\n");
		execSync("git add . && git commit -m 'workspace work'", {
			cwd: worktreePath,
			stdio: "ignore",
		});

		expect(existsSync(worktreePath)).toBe(true);

		// removeWorktree should rename, prune, and schedule background deletion
		await removeWorktree(mainRepoPath, worktreePath);

		// The original directory should be gone (renamed to .superset-delete-*)
		expect(existsSync(worktreePath)).toBe(false);

		// git worktree list should no longer show the worktree
		const worktreeList = execSync("git worktree list --porcelain", {
			cwd: mainRepoPath,
			encoding: "utf-8",
		});
		expect(worktreeList).not.toContain(worktreePath);
	});

	test("removeWorktree creates a .superset-delete-* temp directory", async () => {
		const worktreesDir = join(TEST_DIR, "worktrees");
		const worktreePath = join(worktreesDir, "my-workspace");
		mkdirSync(worktreesDir, { recursive: true });
		execSync(`git worktree add "${worktreePath}" -b feature-branch`, {
			cwd: mainRepoPath,
			stdio: "ignore",
		});

		await removeWorktree(mainRepoPath, worktreePath);

		// A .superset-delete-* temp directory should exist (background rm may not have finished)
		const entries = readdirSync(worktreesDir);
		const tempDirs = entries.filter((e) => e.startsWith(".superset-delete-"));
		expect(tempDirs.length).toBe(1);
	});

	test("removeWorktree handles already-removed worktree gracefully", async () => {
		const worktreePath = join(TEST_DIR, "worktrees", "nonexistent");

		// Should not throw for a non-existent path
		await removeWorktree(mainRepoPath, worktreePath);
	});
});
