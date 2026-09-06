import { execSync, exec } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import type { SandboxedPostState } from "../types/pipeline";
import type { Sandbox, SandboxContext } from "./index";
import { executeWithRollback } from "./index";

const execAsync = promisify(exec);

export class FileSandbox implements Sandbox {
  private traceId: string = "";
  private intentId: string = "";
  private worktreePath: string = "";
  private worktreeActive: boolean = false;
  private changesLog: SandboxedPostState["changes"] = [];

  private get repoRoot(): string {
    return process.cwd();
  }

  async create(intentId: string, traceId: string): Promise<void> {
    this.intentId = intentId;
    this.traceId = traceId;
    this.changesLog = [];

    const branchName = `sandbox/${traceId.slice(0, 8)}`;
    this.worktreePath = join(this.repoRoot, ".sandboxes", traceId);

    try {
      mkdirSync(join(this.repoRoot, ".sandboxes"), { recursive: true });

      // Create an orphan worktree branch
      execSync(
        `git worktree add -b ${branchName} "${this.worktreePath}" HEAD`,
        { cwd: this.repoRoot, stdio: "pipe" }
      );

      this.worktreeActive = true;
      console.log(`[FileSandbox] Worktree created: ${this.worktreePath}`);
    } catch (err: any) {
      // Git not available or not a repo — degrade gracefully to temp dir
      console.log(`[FileSandbox] Git worktree unavailable, using temp dir: ${err.message}`);
      mkdirSync(this.worktreePath, { recursive: true });
      this.worktreeActive = true;
    }
  }

  async execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T> {
    return executeWithRollback(this, context, fn);
  }

  /**
   * Write a file into the sandbox worktree (not main working tree).
   */
  writeFile(relativePath: string, content: string): void {
    if (!this.worktreeActive) throw new Error("[FileSandbox] No active worktree");

    const fullPath = join(this.worktreePath, relativePath);
    const existing = existsSync(fullPath);
    writeFileSync(fullPath, content, "utf-8");

    this.changesLog.push({
      file: relativePath,
      action: existing ? "modify" : "add",
    });

    console.log(`[FileSandbox] Wrote ${relativePath} to worktree`);
  }

  /**
   * Merge worktree branch back into HEAD (fast-forward).
   */
  async commit(): Promise<void> {
    if (!this.worktreeActive) return;

    try {
      const branchName = `sandbox/${this.traceId.slice(0, 8)}`;
      await execAsync(`git merge --ff-only ${branchName}`, { cwd: this.repoRoot });
      console.log(`[FileSandbox] Committed worktree branch: ${branchName}`);
    } catch (err: any) {
      console.log(`[FileSandbox] Commit skipped (no git): ${err.message}`);
    } finally {
      await this._pruneWorktree();
    }
  }

  /**
   * Drop the worktree, discarding all sandboxed file writes.
   */
  async rollback(): Promise<void> {
    if (!this.worktreeActive) return;
    console.log(`[FileSandbox] Rolling back worktree: ${this.worktreePath}`);
    await this._pruneWorktree();
  }

  private async _pruneWorktree(): Promise<void> {
    const branchName = `sandbox/${this.traceId.slice(0, 8)}`;
    try {
      await execAsync(`git worktree remove --force "${this.worktreePath}"`, {
        cwd: this.repoRoot,
      });
      await execAsync(`git branch -D ${branchName}`, { cwd: this.repoRoot });
    } catch {
      // Not a git repo or already cleaned — just nuke the dir
      if (existsSync(this.worktreePath)) {
        rmSync(this.worktreePath, { recursive: true, force: true });
      }
    }
    this.worktreeActive = false;
    console.log(`[FileSandbox] Worktree pruned`);
  }

  getWorktreePath(): string {
    return this.worktreePath;
  }

  getState(): Partial<SandboxedPostState> {
    return {
      worktree_id: this.worktreePath,
      changes: this.changesLog,
    };
  }
}
