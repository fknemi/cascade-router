import type { SandboxedPostState } from "../types/pipeline";
import type { Sandbox, SandboxContext } from "./index";
import { executeWithRollback } from "./index";

interface ShadowCall {
  url: string;
  method: string;
  body?: any;
  redirectedTo: string;
  response?: any;
  timestamp: string;
}

const SHADOW_REGISTRY: Record<string, string> = {
  // Real endpoint → shadow/mock endpoint
  "https://api.stripe.com":       "http://localhost:9001/mock/stripe",
  "https://api.quickbooks.com":   "http://localhost:9001/mock/quickbooks",
  "https://api.xero.com":         "http://localhost:9001/mock/xero",
  // Add more as needed
};

function resolveShadow(url: string): string {
  for (const [real, shadow] of Object.entries(SHADOW_REGISTRY)) {
    if (url.startsWith(real)) {
      return url.replace(real, shadow);
    }
  }
  // No shadow registered — intercept and dry-run (return no-op)
  return `http://localhost:9001/mock/noop`;
}

export class ApiSandbox implements Sandbox {
  private traceId: string = "";
  private intentId: string = "";
  private callLog: ShadowCall[] = [];
  private active: boolean = false;

  async create(intentId: string, traceId: string): Promise<void> {
    this.intentId = intentId;
    this.traceId = traceId;
    this.callLog = [];
    this.active = true;
    console.log(`[ApiSandbox] Active — all api_calls will be shadowed. trace: ${traceId}`);
  }

  async execute<T>(context: SandboxContext, fn: () => Promise<T>): Promise<T> {
    return executeWithRollback(this, context, fn);
  }

  /**
   * Drop-in replacement for fetch() that redirects to shadow endpoints.
   * Pass this into any code that needs to make external API calls during sandbox.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.active) {
      return globalThis.fetch(url, init);
    }

    const shadowUrl = resolveShadow(url);
    const method = init?.method || "GET";

    console.log(`[ApiSandbox] Intercepting ${method} ${url} → ${shadowUrl}`);

    let response: Response;
    try {
      response = await globalThis.fetch(shadowUrl, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          "X-Sandbox-Trace": this.traceId,
          "X-Shadow-Original-URL": url,
        },
      });
    } catch (err: any) {
      // Shadow server also unavailable — return a safe mock 200
      console.log(`[ApiSandbox] Shadow endpoint unreachable, returning mock 200`);
      response = new Response(
        JSON.stringify({ sandboxed: true, noop: true, trace: this.traceId }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    this.callLog.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      redirectedTo: shadowUrl,
      response: response.status,
      timestamp: new Date().toISOString(),
    });

    return response;
  }

  /**
   * Commit: sandbox API calls are already no-ops against shadow endpoints.
   * Log them as accepted.
   */
  async commit(): Promise<void> {
    console.log(`[ApiSandbox] Commit — ${this.callLog.length} shadowed call(s) accepted`);
    this.active = false;
  }

  /**
   * Rollback: discard the log; shadow calls are already isolated.
   */
  async rollback(): Promise<void> {
    console.log(`[ApiSandbox] Rollback — discarding ${this.callLog.length} shadowed call(s)`);
    this.callLog = [];
    this.active = false;
  }

  getCallLog(): ShadowCall[] {
    return this.callLog;
  }

  getState(): Partial<SandboxedPostState> {
    // SandboxedPostState doesn't have an api_calls field yet,
    // but we return what maps to it for composite state capture
    return {
      database_queries: this.callLog.map((c) => ({
        sql: `${c.method} ${c.url}`,
        params: [c.body],
      })),
    };
  }
}
