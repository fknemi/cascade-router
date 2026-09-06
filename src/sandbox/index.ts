import type { SandboxedPostState } from "../types/pipeline";
import { AOSandbox } from "./aoSandbox";
import { DataSandbox } from "./dataSandbox";
import { ApiSandbox } from "./apiSandbox";
import { startChainSpan, setSpanAttributes, endSpan, startAgentSpan } from "../telemetry";

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

// ─── Enhanced executeWithRollback from Branch 1 ────────────────────────────
export async function executeWithRollback<T>(
  sandbox: Sandbox,
  context: SandboxContext,
  fn: () => Promise<T>
): Promise<T> {
  const span = startChainSpan('sandbox.execute', null, {
    trace_id: context.traceId,
    intent_id: context.intentId,
  });

  try {
    const result = await fn();
    
    setSpanAttributes(span, {
      status: 'success',
      worktree_id: context.worktreeId || sandbox.getState().worktree_id,
    });
    
    return result;
  } catch (err) {
    console.log(`[Sandbox] Auto-rollback triggered for trace ${context.traceId}`);
    
    setSpanAttributes(span, {
      status: 'rolled_back',
      error: err.message,
    });
    
    await sandbox.rollback();
    throw err;
  } finally {
    endSpan(span);
  }
}

// ─── Enhanced CompositeSandbox with Branch 1 features ──────────────────────
export class CompositeSandbox implements Sandbox {
  private ao = new AOSandbox();
  private data = new DataSandbox();
  private api = new ApiSandbox();
  private isActive = false;
  private mutationsAttempted = 0;
  private createdAt: number = Date.now();

  async create(intentId: string, traceId: string): Promise<void> {
    const span = startChainSpan('sandbox.create', null, {
      trace_id: traceId,
      intent_id: intentId,
    });

    console.log(`[CompositeSandbox] Creating all sandboxes — trace: ${traceId}`);
    
    try {
      await Promise.all([
        this.ao.create(intentId, traceId),
        this.data.create(intentId, traceId),
        this.api.create(intentId, traceId),
      ]);
      
      this.isActive = true;
      this.mutationsAttempted = 0;
      
      setSpanAttributes(span, {
        status: 'created',
        worktree_id: this.ao.getWorktreeId(),
      });
    } catch (err) {
      setSpanAttributes(span, {
        status: 'error',
        error: err.message,
      });
      throw err;
    } finally {
      endSpan(span);
    }
  }

  async execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T> {
    if (!this.isActive) {
      await this.create(context.intentId, context.traceId);
    }

    const span = startAgentSpan('sandbox.execute', null, {
      trace_id: context.traceId,
      intent_id: context.intentId,
      worktree_id: this.ao.getWorktreeId(),
    });

    try {
      // Count mutations from the function execution
      const originalDataState = this.data.getState();
      const originalApiState = this.api.getState();
      
      const result = await executeWithRollback(this, context, fn);
      
      // Track mutations attempted
      const newDataState = this.data.getState();
      const newApiState = this.api.getState();
      
      this.mutationsAttempted += 
        ((newDataState.database_queries?.length || 0) - 
         (originalDataState.database_queries?.length || 0)) +
        ((newApiState.api_calls?.length || 0) - 
         (originalApiState.api_calls?.length || 0));
      
      setSpanAttributes(span, {
        status: 'executed',
        mutations_attempted: this.mutationsAttempted,
      });
      
      return result;
    } catch (err) {
      setSpanAttributes(span, {
        status: 'rolled_back',
        error: err.message,
        mutations_attempted: this.mutationsAttempted,
      });
      throw err;
    } finally {
      endSpan(span);
    }
  }

  async commit(): Promise<void> {
    const span = startChainSpan('sandbox.commit', null, {
      mutations_attempted: this.mutationsAttempted,
      worktree_id: this.ao.getWorktreeId(),
    });

    console.log(`[CompositeSandbox] Committing all sandboxes`);
    
    try {
      await Promise.all([
        this.ao.commit(),
        this.data.commit(),
        this.api.commit(),
      ]);
      
      this.isActive = false;
      
      setSpanAttributes(span, {
        status: 'committed',
        exec_ms: Date.now() - this.createdAt,
      });
    } catch (err) {
      setSpanAttributes(span, {
        status: 'commit_failed',
        error: err.message,
      });
      
      // If commit fails, attempt rollback
      await this.rollback().catch(e => console.error("[rollback after failed commit]", e.message));
      throw err;
    } finally {
      endSpan(span);
    }
  }

  async rollback(): Promise<void> {
    const span = startChainSpan('sandbox.rollback', null, {
      mutations_attempted: this.mutationsAttempted,
      worktree_id: this.ao.getWorktreeId(),
    });

    console.log(`[CompositeSandbox] Rolling back all sandboxes`);
    
    const rollbackPromises = [
      this.ao.rollback().catch(e => ({ type: 'ao', error: e.message })),
      this.data.rollback().catch(e => ({ type: 'data', error: e.message })),
      this.api.rollback().catch(e => ({ type: 'api', error: e.message })),
    ];

    const results = await Promise.all(rollbackPromises);
    const failures = results.filter(r => r && r.error);
    
    this.isActive = false;
    
    if (failures.length > 0) {
      setSpanAttributes(span, {
        status: 'partial_rollback',
        failures: JSON.stringify(failures),
      });
      console.error(`[CompositeSandbox] Partial rollback failures:`, failures);
    } else {
      setSpanAttributes(span, {
        status: 'rolled_back',
      });
    }
    
    endSpan(span);
  }

  getState(): Partial<SandboxedPostState> {
    const state: Partial<SandboxedPostState> = {
      worktree_id: this.ao.getWorktreeId(),
      changes: [],
      database_queries: this.data.getState().database_queries ?? [],
      mutations_attempted: this.mutationsAttempted,
      db_status: this.isActive ? 'active' : 'rolled_back',
      workspace_path: this.ao.getWorktreePath?.() || '',
    };
    
    return state;
  }

  // ─── Additional Branch 1 helpers ────────────────────────────────────────
  getApiSandbox(): ApiSandbox {
    return this.api;
  }

  getDataSandbox(): DataSandbox {
    return this.data;
  }

  getAOSandbox(): AOSandbox {
    return this.ao;
  }

  isSandboxActive(): boolean {
    return this.isActive;
  }

  getMutationsAttempted(): number {
    return this.mutationsAttempted;
  }

  getCreatedAt(): number {
    return this.createdAt;
  }

  // ─── Branch 1: Direct mutation execution ─────────────────────────────────
  async executeDbMutation(query: string, params: any[] = []): Promise<void> {
    if (!this.isActive) {
      throw new Error('Sandbox not active. Call create() first.');
    }
    
    this.mutationsAttempted++;
    await this.data.executeQuery(query, params);
  }

  async executeFileMutation(filePath: string, content: string): Promise<void> {
    if (!this.isActive) {
      throw new Error('Sandbox not active. Call create() first.');
    }
    
    this.mutationsAttempted++;
    await this.ao.writeFile(filePath, content);
  }

  async executeApiMutation(endpoint: string, method: string, body: any): Promise<void> {
    if (!this.isActive) {
      throw new Error('Sandbox not active. Call create() first.');
    }
    
    this.mutationsAttempted++;
    await this.api.executeCall(endpoint, method, body);
  }

  // ─── Branch 1: Shadow API client ─────────────────────────────────────────
  createShadowApiClient(originalClient: any): any {
    return this.api.createShadowClient(originalClient);
  }

  // ─── Branch 1: Git worktree helpers ──────────────────────────────────────
  getWorktreeId(): string | undefined {
    return this.ao.getWorktreeId();
  }

  getWorktreePath(): string | undefined {
    return this.ao.getWorktreePath?.();
  }

  // ─── Branch 1: Cleanup ───────────────────────────────────────────────────
  async cleanup(): Promise<void> {
    if (this.isActive) {
      await this.rollback();
    }
    
    await Promise.all([
      this.ao.cleanup?.().catch(e => console.error("[ao cleanup]", e.message)),
      this.data.cleanup?.().catch(e => console.error("[data cleanup]", e.message)),
      this.api.cleanup?.().catch(e => console.error("[api cleanup]", e.message)),
    ]);
  }
}

// ─── Factory function for easier instantiation ─────────────────────────────
export async function createSandbox(
  intentId: string,
  traceId: string
): Promise<CompositeSandbox> {
  const sandbox = new CompositeSandbox();
  await sandbox.create(intentId, traceId);
  return sandbox;
}

// ─── Enhanced context helper ───────────────────────────────────────────────
export function createSandboxContext(
  intentId: string,
  traceId: string,
  worktreeId?: string
): SandboxContext {
  return {
    intentId,
    traceId,
    worktreeId,
  };
}
