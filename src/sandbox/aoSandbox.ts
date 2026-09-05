import type { SandboxedPostState } from "../types/pipeline";

const AO_URL = "http://localhost:3000";

export class AOSandbox {
  private worktreeId: string = "";
  private traceId: string = "";

  async create(intentId: string, traceId: string): Promise<void> {
    this.traceId = traceId;
    
    const response = await fetch(`${AO_URL}/cascade/worktree/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent_id: intentId,
        trace_id: traceId,
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to create AO worktree");
    }

    const data = await response.json();
    this.worktreeId = data.worktree_id;
  }

  async rollback(): Promise<void> {
    if (!this.worktreeId) return;

    await fetch(`${AO_URL}/cascade/worktree/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktree_id: this.worktreeId,
        trace_id: this.traceId,
      }),
    });
  }

  async commit(): Promise<void> {
    if (!this.worktreeId) return;

    await fetch(`${AO_URL}/cascade/worktree/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktree_id: this.worktreeId,
        trace_id: this.traceId,
      }),
    });
  }

  getWorktreeId(): string {
    return this.worktreeId;
  }
}
