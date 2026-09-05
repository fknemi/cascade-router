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

export interface StudentDraftPayload {
  [key: string]: any;
}

export interface SandboxedPostState {
  worktree_id: string;
  changes: Array<{
    file: string;
    action: 'add' | 'modify' | 'delete';
    diff?: string;
  }>;
  database_queries: Array<{
    sql: string;
    params?: any[];
  }>;
}

export interface DraftResult {
  draft: StudentDraftPayload;
  sandbox_state: SandboxedPostState;
  worktree_id: string;
  trace_id: string;
}

export interface GateResult {
  passed: boolean;
  layer1?: {
    passed: boolean;
    errors?: string[];
  };
  layer2?: {
    passed: boolean;
    assertion_error?: string;
  };
}
