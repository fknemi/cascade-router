// src/sandbox/aoSandbox.ts
import type { SandboxedPostState } from "../types/pipeline";

const AO_URL = "http://localhost:3000";

export class AOSandbox {
  private worktreeId: string = "";
  private traceId: string = "";
  private sandboxActive: boolean = false;

  /**
   * Initializes a new worktree on the AO server for the Student's execution.
   */
  async create(intentId: string, traceId: string): Promise<void> {
    this.traceId = traceId;
    
    try {
      const response = await fetch(`${AO_URL}/cascade/worktree/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent_id: intentId,
          trace_id: traceId,
        }),
      });

      if (!response.ok) {
        // Server exists but endpoint failed - use local sandbox
        console.log("[Sandbox] AO server rejected worktree - using local sandbox");
        this.worktreeId = `local-${traceId}`;
        this.sandboxActive = true;
        return;
      }

      const data = await response.json();
      this.worktreeId = data.worktree_id;
      this.sandboxActive = true;
    } catch (error) {
      // Server not running - use local sandbox
      console.log("[Sandbox] AO server not available - using local sandbox");
      this.worktreeId = `local-${traceId}`;
      this.sandboxActive = true;
    }
  }

  /**
   * Discards the worktree. Called when the Student fails Layer 2 Validation.
   */
  async rollback(): Promise<void> {
    if (!this.worktreeId || !this.sandboxActive) return;

    try {
      await fetch(`${AO_URL}/cascade/worktree/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worktree_id: this.worktreeId,
          trace_id: this.traceId,
        }),
      });
      console.log(`[Sandbox] Worktree ${this.worktreeId} rolled back successfully.`);
    } catch (e) {
      console.log("[Sandbox] Rollback skipped (no AO server)");
    }
  }

  /**
   * Merges the worktree. Called when the Student passes Layer 2 Validation.
   */
  async commit(): Promise<void> {
    if (!this.worktreeId || !this.sandboxActive) return;

    try {
      await fetch(`${AO_URL}/cascade/worktree/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worktree_id: this.worktreeId,
          trace_id: this.traceId,
        }),
      });
      console.log(`[Sandbox] Worktree ${this.worktreeId} committed successfully.`);
    } catch (e) {
      console.log("[Sandbox] Commit skipped (no AO server)");
    }
  }

  /**
   * Retrieves the current active worktree ID for routing DB queries.
   */
  getWorktreeId(): string {
    return this.worktreeId;
  }
}
