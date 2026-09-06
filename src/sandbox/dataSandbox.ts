import { db } from "../prisma/db";
import type { SandboxedPostState } from "../types/pipeline";
import type { Sandbox, SandboxContext } from "./index";
import { executeWithRollback } from "./index";

export class DataSandbox implements Sandbox {
  private traceId: string = "";
  private intentId: string = "";
  private queriesLog: SandboxedPostState["database_queries"] = [];
  private inTransaction: boolean = false;

  async create(intentId: string, traceId: string): Promise<void> {
    this.intentId = intentId;
    this.traceId = traceId;
    this.queriesLog = [];
  }

  /**
   * Wraps fn() in a DB transaction.
   * Any throw inside fn() triggers ROLLBACK automatically via Prisma's tx semantics.
   */
  async execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T> {
    return executeWithRollback(this, context, async () => {
      return await (db as any).$transaction(async (tx: any) => {
        this.inTransaction = true;
        console.log(`[DataSandbox] BEGIN transaction — trace: ${context.traceId}`);
        const result = await fn();
        console.log(`[DataSandbox] Transaction ready to COMMIT — trace: ${context.traceId}`);
        return result;
      });
    });
  }

  /**
   * No-op: Prisma commits automatically when the $transaction callback resolves.
   */
  async commit(): Promise<void> {
    console.log(`[DataSandbox] COMMIT — trace: ${this.traceId}`);
    this.inTransaction = false;
  }

  /**
   * Prisma rolls back automatically when the $transaction callback throws.
   * This is the explicit escape hatch for the fast-exit path.
   */
  async rollback(): Promise<void> {
    console.log(`[DataSandbox] ROLLBACK — trace: ${this.traceId}`);
    this.inTransaction = false;
    // Prisma's $transaction handles the actual ROLLBACK on throw.
    // If called outside a transaction, this is a safe no-op.
  }

  logQuery(sql: string, params?: any[]): void {
    this.queriesLog.push({ sql, params });
  }

  getState(): Partial<SandboxedPostState> {
    return {
      database_queries: this.queriesLog,
    };
  }
}
