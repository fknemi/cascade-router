// src/types/pipeline.ts
// Enhanced with Branch 1's types, mutation tracking, and performance metrics

// ─── Core Bundle Types ────────────────────────────────────────────────────
export interface IntentProfileBundle {
  routing_metadata: {
    intent_id: string;
    intent_name: string;
    domain: string;
    model_target: string;
    trace_id: string;
  };
  execution_assets: {
    sop_version: number;
    sop_text: string;
  };
  verification_assets: {
    layer1_schema: Record<string, any>;
    layer2_invariant_code: string;
  };
}

// ─── Student Draft Types ──────────────────────────────────────────────────
export interface StudentDraftPayload {
  [key: string]: any;
  result?: any;
  mutations?: DraftMutations;
}

// ─── Mutation Types (from Branch 1) ──────────────────────────────────────
export interface DbMutation {
  query: string;
  params?: any[];
  type?: 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT';
  table?: string;
}

export interface FileMutation {
  path: string;
  content: string;
  action?: 'create' | 'modify' | 'delete';
  encoding?: string;
}

export interface ApiMutation {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
}

export interface DraftMutations {
  db: DbMutation[];
  file: FileMutation[];
  api: ApiMutation[];
}

// ─── Sandbox State Types ─────────────────────────────────────────────────
export interface SandboxedPostState {
  worktree_id: string;
  workspace_path?: string;
  changes: Array<{
    file: string;
    action: 'add' | 'modify' | 'delete';
    diff?: string;
    content?: string;
  }>;
  database_queries: Array<{
    sql: string;
    params?: any[];
    result?: any;
    status?: 'executed' | 'rolled_back' | 'committed';
  }>;
  mutations_attempted?: number;
  db_status?: 'clean' | 'drafted' | 'rolled_back' | 'committed' | 'active';
  api_calls?: Array<{
    endpoint: string;
    method: string;
    status?: number;
    response?: any;
  }>;
}

// ─── Draft Result Types ──────────────────────────────────────────────────
export interface DraftResult {
  draft: StudentDraftPayload;
  sandbox_state: SandboxedPostState;
  worktree_id: string;
  trace_id: string;
  mutations?: DraftMutations;
  cost_usd?: number;
  latency_ms?: number;
  model_used?: string;
}

// ─── Gate Result Types ───────────────────────────────────────────────────
export interface GateResult {
  passed: boolean;
  layer1?: {
    passed: boolean;
    errors?: string[];
    fields_checked?: number;
    validation_type?: 'basic' | 'schema' | 'none';
    output?: string;
  };
  layer2?: {
    passed: boolean;
    assertion_error?: string;
    output?: string;
    execution_ms?: number;
    timed_out?: boolean;
    code_hash?: string;
  };
  execution_ms?: number;
  trace_id?: string;
}

// ─── Learning Loop Types (from Branch 1) ─────────────────────────────────
export interface LearningContract {
  intent_id: string;
  sop_text: string;
  invariant_code: string;
  source_query: string;
  teacher_result: any;
  created_at: string;
  version?: number;
}

export interface MutationTestResult {
  name: string;
  caught: boolean;
  payload: any;
  should_catch: boolean;
  execution_ms?: number;
  error?: string;
}

export interface LearningLoopResult {
  success: boolean;
  version?: number;
  mutation_catch_rate?: number;
  error?: string;
  trace_id?: string;
  total_mutations?: number;
  caught_mutations?: number;
  reviewer_passed?: boolean;
}

// ─── Cascade Pipeline Types ──────────────────────────────────────────────
export interface CascadeResult {
  trace_id: string;
  path: 'student_fast_path' | 'teacher_fallback' | 'no_intent' | 'mismatch' | 'error';
  status: string;
  draft?: StudentDraftPayload;
  intent?: string;
  error_caught?: string;
  worktree_id?: string;
  worktree_reused?: boolean;
  worktree_path?: string;
  task_signature?: string;
  session_id?: string | null;
  display_name?: string | null;
  latency_ms?: number;
  cost_usd?: number;
  gate_results?: {
    layer1?: GateResult['layer1'];
    layer2?: GateResult['layer2'];
  };
}

// ─── Performance Metrics Types (from Branch 1) ───────────────────────────
export interface PerformanceMetrics {
  latency_ms: number;
  cost_usd: number;
  tokens_used?: number;
  model_used: string;
  path_taken: string;
  start_time: string;
  end_time: string;
}

export interface PerformanceTargets {
  fastPathLatencyMs: number;
  fastPathCostUsd: number;
  fallbackCostUsd: number;
  mutationCatchRate: number;
}

// ─── Telemetry Span Types ────────────────────────────────────────────────
export interface TelemetrySpan {
  name: string;
  type: 'WORKFLOW' | 'CHAIN' | 'AGENT' | 'GUARDRAIL' | 'EMBEDDING';
  attributes: Record<string, any>;
  trace_output?: any;
  parent_span_id?: string;
  span_id: string;
  start_time: string;
  end_time?: string;
  status?: 'started' | 'success' | 'error' | 'rolled_back';
}

// ─── Router Types ────────────────────────────────────────────────────────
export interface RouteResult {
  matched: boolean;
  bundle?: IntentProfileBundle;
  distance?: number;
  top_matches?: Array<{
    intent_id: string;
    name: string;
    distance: number;
  }>;
  latency_ms?: number;
  error?: string;
}

// ─── Sandbox Types ───────────────────────────────────────────────────────
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

// ─── Model Types ─────────────────────────────────────────────────────────
export interface ModelConfig {
  name: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  costPerToken?: number;
}

export interface ModelResponse {
  content: string;
  toolCalls?: any[];
  finishReason: string;
  latency_ms: number;
  cost_usd: number;
  tokens_used?: number;
}

// ─── Database Types ──────────────────────────────────────────────────────
export interface IntentRecord {
  intent_id: string;
  name: string;
  domain: string;
  description?: string;
  schema_json?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface SOPRecord {
  intent_id: string;
  version: number;
  content: string;
  status: 'active' | 'deprecated' | 'draft';
  created_at?: string;
}

export interface InvariantRecord {
  intent_id: string;
  version: number;
  code: string;
  status: 'active' | 'deprecated' | 'draft';
  created_at?: string;
}

// ─── Utility Types ───────────────────────────────────────────────────────
export type PathTaken = 
  | 'student_fast_path' 
  | 'teacher_fallback' 
  | 'no_intent' 
  | 'mismatch' 
  | 'ao_internal_bypass'
  | 'direct_deepseek'
  | 'error';

export type GateType = 'layer1' | 'layer2';

export type MutationType = 'db' | 'file' | 'api';

export type SandboxStatus = 
  | 'created' 
  | 'executing' 
  | 'committed' 
  | 'rolled_back' 
  | 'error';

// ─── Constants ────────────────────────────────────────────────────────────
export const PERFORMANCE_TARGETS: PerformanceTargets = {
  fastPathLatencyMs: 1500,    // < 1.5s target
  fastPathCostUsd: 0.005,     // < $0.005 target
  fallbackCostUsd: 0.12,      // ~ $0.12 target
  mutationCatchRate: 10,      // 10/10 mutations must be caught
};

export const GATE_TIMEOUTS = {
  layer1Ms: 100,              // Layer 1 structural validation timeout
  layer2Ms: 100,              // Layer 2 invariant validation timeout (from Branch 1)
  layer2MemoryMB: 50,         // Memory limit for layer 2
  layer2CPUSeconds: 1,        // CPU time limit for layer 2
};

export const ROUTER_CONSTANTS = {
  MAX_DISTANCE: 0.35,         // Reject matches above this distance
  WARN_DISTANCE: 0.65,        // Warn on weak matches above this
  MIN_MARGIN: 0.03,           // Minimum margin between top-1 and runner-up
  TOP_K: 3,                   // Number of top matches to fetch
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_DIMENSIONS: 768,  // nomic-embed-text dimension
};

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  student: {
    name: 'deepseek-v4-flash',
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    temperature: 0.2,
    costPerToken: 0.000001,
  },
  teacher: {
    name: 'deepseek-v4-pro',
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    temperature: 0.1,
    costPerToken: 0.00001,
  },
};

// ─── Type Guards ──────────────────────────────────────────────────────────
export function isDraftMutations(obj: any): obj is DraftMutations {
  return (
    obj &&
    Array.isArray(obj.db) &&
    Array.isArray(obj.file) &&
    Array.isArray(obj.api)
  );
}

export function isSandboxedPostState(obj: any): obj is SandboxedPostState {
  return (
    obj &&
    typeof obj.worktree_id === 'string' &&
    Array.isArray(obj.changes) &&
    Array.isArray(obj.database_queries)
  );
}

export function isGateResult(obj: any): obj is GateResult {
  return obj && typeof obj.passed === 'boolean';
}

export function isCascadeResult(obj: any): obj is CascadeResult {
  return (
    obj &&
    typeof obj.trace_id === 'string' &&
    typeof obj.path === 'string' &&
    typeof obj.status === 'string'
  );
}

// ─── Helper Functions ─────────────────────────────────────────────────────
export function createEmptyMutations(): DraftMutations {
  return {
    db: [],
    file: [],
    api: [],
  };
}

export function createEmptySandboxState(worktreeId: string): SandboxedPostState {
  return {
    worktree_id: worktreeId,
    workspace_path: '',
    changes: [],
    database_queries: [],
    mutations_attempted: 0,
    db_status: 'clean',
    api_calls: [],
  };
}

export function countTotalMutations(mutations: DraftMutations): number {
  return (
    mutations.db.length +
    mutations.file.length +
    mutations.api.length
  );
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
