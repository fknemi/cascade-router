import type { SandboxedPostState } from "../types/pipeline";
import { AOSandbox } from "./aoSandbox";
import { DataSandbox } from "./dataSandbox";
import { ApiSandbox } from "./apiSandbox";

export interface SandboxContext {
  intentId: string;
  traceId: string;
  worktreeId?: string;
}

export interface Sandbox {
  create(intentId: string, traceId: string): Promise<void>;
  execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getState(): Partial<SandboxedPostState>;
}

export async function executeWithRollback<T>(
  sandbox: Sandbox,
  context: SandboxContext,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.log(`[Sandbox] Auto-rollback triggered for trace ${context.traceId}`);
    await sandbox.rollback();
    throw err;
  }
}

// ─── THIS is what main.ts should instantiate ───────────────────────────────
export class CompositeSandbox implements Sandbox {
  private ao   = new AOSandbox();
  private data = new DataSandbox();
  private api  = new ApiSandbox();

  async create(intentId: string, traceId: string): Promise<void> {
    console.log(`[CompositeSandbox] Creating all sandboxes — trace: ${traceId}`);
    await Promise.all([
      this.ao.create(intentId, traceId),
      this.data.create(intentId, traceId),
      this.api.create(intentId, traceId),
    ]);
  }

  async execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T> {
    return executeWithRollback(this, context, fn);
  }

  async commit(): Promise<void> {
    console.log(`[CompositeSandbox] Committing all sandboxes`);
    await Promise.all([
      this.ao.commit(),
      this.data.commit(),
      this.api.commit(),
    ]);
  }

  async rollback(): Promise<void> {
    console.log(`[CompositeSandbox] Rolling back all sandboxes`);
    await this.ao.rollback().catch(e => console.error("[ao rollback]", e.message));
    await this.data.rollback().catch(e => console.error("[data rollback]", e.message));
    await this.api.rollback().catch(e => console.error("[api rollback]", e.message));
  }

  getState(): Partial<SandboxedPostState> {
    return {
      worktree_id:      this.ao.getWorktreeId(),
      changes:          [],
      database_queries: this.data.getState().database_queries ?? [],
    };
  }

  getApiSandbox():  ApiSandbox  { return this.api;  }
  getDataSandbox(): DataSandbox { return this.data; }
}
