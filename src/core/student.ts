// src/core/student.ts
import { callStudentModel } from "../models/ollama";
import type {
  IntentProfileBundle,
  StudentDraftPayload,
  DraftResult,
} from "../types/pipeline";
import { 
  startAgentSpan, 
  startChainSpan,
  setSpanAttributes, 
  setTraceOutput, 
  endSpan 
} from "../telemetry";

// ─── Performance target from Branch 1 ─────────────────────────────────────
const STUDENT_COST_USD = 0.005; // Fast path cost target

function extractJSON(text: string): any {
  // 1. Try parsing raw text directly
  try {
    return JSON.parse(text);
  } catch (e) {}

  // 2. Try extracting from markdown code blocks (handles both {} and [])
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e2) {}
  }

  // 3. Loose match: grab everything from the first { or [ to the last } or ]
  const looseMatch = text.match(/([\{\[][\s\S]*[\}\]])/);
  if (looseMatch) {
    try {
      return JSON.parse(looseMatch[0]);
    } catch (e3) {}
  }

  return null;
}

// ─── Parse mutations from draft (from Branch 1) ───────────────────────────
function parseMutations(draft: StudentDraftPayload): {
  db: Array<{ query: string; params?: any[] }>;
  file: Array<{ path: string; content: string }>;
  api: Array<{ endpoint: string; method: string; body?: any }>;
} {
  const mutations = {
    db: [],
    file: [],
    api: [],
  };

  try {
    // Check if draft has mutations field
    const draftAny = draft as any;
    
    if (draftAny.mutations) {
      // Parse DB mutations
      if (draftAny.mutations.db && Array.isArray(draftAny.mutations.db)) {
        mutations.db = draftAny.mutations.db;
      }
      
      // Parse File mutations
      if (draftAny.mutations.file && Array.isArray(draftAny.mutations.file)) {
        mutations.file = draftAny.mutations.file;
      }
      
      // Parse API mutations
      if (draftAny.mutations.api && Array.isArray(draftAny.mutations.api)) {
        mutations.api = draftAny.mutations.api;
      }
    }
    
    // Also check for nested mutations in response
    if (draftAny.response?.mutations) {
      const nestedMutations = draftAny.response.mutations;
      
      if (nestedMutations.db && Array.isArray(nestedMutations.db)) {
        mutations.db.push(...nestedMutations.db);
      }
      
      if (nestedMutations.file && Array.isArray(nestedMutations.file)) {
        mutations.file.push(...nestedMutations.file);
      }
      
      if (nestedMutations.api && Array.isArray(nestedMutations.api)) {
        mutations.api.push(...nestedMutations.api);
      }
    }
  } catch (error) {
    console.log('[Student] No mutations found in draft');
  }

  return mutations;
}

// ─── Enhanced generateDraft with telemetry ────────────────────────────────
export async function generateDraft(
  userQuery: string,
  bundle: IntentProfileBundle,
  parentSpan?: any,
): Promise<DraftResult> {
  const { trace_id, intent_id } = bundle.routing_metadata;
  const sopText = bundle.execution_assets.sop_text;
  const schema = bundle.verification_assets.layer1_schema;

  // Start AGENT span for student draft
  const span = startAgentSpan('studentDraft', parentSpan, {
    model: 'deepseek-v4-flash',
    intent_id,
    intent_name: bundle.routing_metadata.intent_name,
    trace_id,
    query: userQuery.substring(0, 200),
  });

  const startTime = Date.now();

  console.log(
    `[Student] Generating draft for intent: ${bundle.routing_metadata.intent_name}`,
  );

  let worktreeId = `local-${trace_id}`;
  
  // Create worktree with telemetry
  const worktreeSpan = startChainSpan('worktree.create', span, {
    trace_id,
    intent_id,
  });

  try {
    const response = await fetch(
      "http://localhost:3000/cascade/worktree/create",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent_id, trace_id }),
      },
    );
    if (response.ok) {
      const data = await response.json();
      worktreeId = data.worktree_id;
      
      setSpanAttributes(worktreeSpan, {
        status: 'created',
        worktree_id: worktreeId,
      });
    }
  } catch (e) {
    setSpanAttributes(worktreeSpan, {
      status: 'local_fallback',
      worktree_id: worktreeId,
    });
  } finally {
    endSpan(worktreeSpan);
  }

  try {
    const schemaPrompt = schema
      ? `\n\nRequired output schema (follow this EXACTLY):\n${JSON.stringify(schema, null, 2)}`
      : "";

    // Inject REAL time so it overrides any database examples, and strictly forbid tools
    const systemPrompt = `You are a precise task execution agent. 
Output ONLY a valid JSON object matching the schema. No markdown, no arrays, no extra fields, no explanations.

CRITICAL INSTRUCTION: You DO NOT have access to any external tools, bash, or git environments. 
DO NOT output <｜｜DSML｜｜tool_calls> tags. 
DO NOT attempt to run commands. 
Just generate the final JSON draft.

CURRENT SYSTEM CONTEXT:
- Current Date/Time: ${new Date().toISOString()}
- Local Timezone: Asia/Kolkata (Indore, Madhya Pradesh, India)`;

    const rawOutput = await callStudentModel(
      userQuery,
      `${sopText}${schemaPrompt}`,
      systemPrompt,
    );

    // Scrub out any accidental DSML tool calls before parsing
    const cleanOutput = rawOutput
      .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, "")
      .replace(/<｜｜DSML｜｜invoke[\s\S]*?<\/｜｜DSML｜｜invoke>/g, "")
      .trim();

    // DONT truncate this string! We need to see it to fix the JSON error.
    console.log(
      `\n=== STUDENT RAW OUTPUT ===\n${cleanOutput}\n==========================\n`,
    );

    const draft: StudentDraftPayload = extractJSON(cleanOutput);

    if (!draft) {
      console.log(
        `[Cascade] Student produced invalid JSON (extractJSON returned null)`,
      );
      
      setSpanAttributes(span, {
        status: 'invalid_json',
        latency_ms: Date.now() - startTime,
        raw_output_length: cleanOutput.length,
      });
      
      throw new Error('Student failed to produce valid JSON');
    }

    // Parse mutations for sandbox execution
    const mutations = parseMutations(draft);
    
    const latency_ms = Date.now() - startTime;
    
    console.log(`[Student] Draft generated in ${latency_ms}ms`);
    console.log(`[Student] Mutations found - db: ${mutations.db.length}, file: ${mutations.file.length}, api: ${mutations.api.length}`);

    const result: DraftResult = {
      draft,
      sandbox_state: {
        worktree_id: worktreeId,
        changes: [],
        database_queries: [],
        mutations_attempted: mutations.db.length + mutations.file.length + mutations.api.length,
        db_status: 'drafted',
        workspace_path: '',
      },
      worktree_id: worktreeId,
      trace_id,
      mutations, // Include mutations in result for sandbox execution
    };

    // Set telemetry attributes
    setSpanAttributes(span, {
      status: 'success',
      latency_ms,
      cost_usd: STUDENT_COST_USD,
      draft_size: JSON.stringify(draft).length,
      mutations_db: mutations.db.length,
      mutations_file: mutations.file.length,
      mutations_api: mutations.api.length,
      worktree_id: worktreeId,
    });

    // Set trace output with draft details
    setTraceOutput(span, {
      intent: bundle.routing_metadata.intent_name,
      draft_preview: JSON.stringify(draft).substring(0, 500),
      mutations: {
        db: mutations.db.length,
        file: mutations.file.length,
        api: mutations.api.length,
      },
      worktree_id: worktreeId,
    });

    return result;
  } catch (error: any) {
    // Rollback worktree on error
    const rollbackSpan = startChainSpan('worktree.rollback', span, {
      worktree_id: worktreeId,
      trace_id,
    });

    try {
      await fetch("http://localhost:3000/cascade/worktree/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktree_id: worktreeId, trace_id }),
      });
      
      setSpanAttributes(rollbackSpan, {
        status: 'rolled_back',
      });
    } catch (e: any) {
      setSpanAttributes(rollbackSpan, {
        status: 'rollback_failed',
        error: e.message,
      });
    } finally {
      endSpan(rollbackSpan);
    }

    setSpanAttributes(span, {
      status: 'error',
      error: error.message,
      latency_ms: Date.now() - startTime,
    });

    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Batch draft generation (from Branch 1) ───────────────────────────────
export async function generateDraftsBatch(
  userQuery: string,
  bundles: IntentProfileBundle[],
  parentSpan?: any
): Promise<DraftResult[]> {
  const span = startChainSpan('generateDraftsBatch', parentSpan, {
    bundle_count: bundles.length,
  });

  const startTime = Date.now();

  try {
    const results = await Promise.all(
      bundles.map(bundle => generateDraft(userQuery, bundle, span))
    );
    
    setSpanAttributes(span, {
      status: 'success',
      latency_ms: Date.now() - startTime,
      drafts_generated: results.length,
    });
    
    return results;
  } catch (error: any) {
    setSpanAttributes(span, {
      status: 'error',
      error: error.message,
      latency_ms: Date.now() - startTime,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Validate draft structure (helper from Branch 1) ──────────────────────
export function validateDraftStructure(draft: any): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  
  if (!draft) {
    return { valid: false, issues: ['Draft is null or undefined'] };
  }
  
  if (typeof draft !== 'object') {
    return { valid: false, issues: ['Draft must be an object'] };
  }
  
  if (Array.isArray(draft)) {
    return { valid: false, issues: ['Draft must be an object, not an array'] };
  }
  
  // Check for empty object
  if (Object.keys(draft).length === 0) {
    issues.push('Draft is empty');
  }
  
  // Check for null values in top-level fields
  for (const [key, value] of Object.entries(draft)) {
    if (value === null) {
      issues.push(`Field '${key}' is null`);
    }
  }
  
  return {
    valid: issues.length === 0,
    issues,
  };
}

// ─── Extract and validate mutations ───────────────────────────────────────
export function extractMutations(draft: StudentDraftPayload): {
  db: Array<{ query: string; params?: any[] }>;
  file: Array<{ path: string; content: string }>;
  api: Array<{ endpoint: string; method: string; body?: any }>;
  total: number;
} {
  const mutations = parseMutations(draft);
  
  return {
    ...mutations,
    total: mutations.db.length + mutations.file.length + mutations.api.length,
  };
}

// ─── Cost estimation helper ───────────────────────────────────────────────
export function estimateDraftCost(
  draftSize: number,
  model: string = 'deepseek-v4-flash'
): number {
  // Rough cost estimation based on model and output size
  const baseCost = model.includes('pro') ? 0.12 : 0.005;
  const sizeFactor = Math.ceil(draftSize / 1000); // Per 1KB
  
  return baseCost * sizeFactor;
}

// ─── Export mutation types for TypeScript ─────────────────────────────────
export interface DraftMutations {
  db: Array<{ query: string; params?: any[] }>;
  file: Array<{ path: string; content: string }>;
  api: Array<{ endpoint: string; method: string; body?: any }>;
}
