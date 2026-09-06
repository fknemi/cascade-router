// main.ts - Cascade v3 Router with DeepSeek Student/Teacher
import express from "express";
import axios from "axios";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.json());

// === LOAD OPENCODE CONFIG ===
function loadConfig(): any {
  const locations = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(process.cwd(), "opencode.json"),
  ];

  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const raw = readFileSync(loc, "utf-8");
        const cleanRaw = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        const config = JSON.parse(cleanRaw);
        console.log(`[Config] Loaded: ${loc}`);
        return config;
      }
    } catch (e) {
      console.log(`[Config] Failed: ${loc}`);
    }
  }
  throw new Error("opencode config not found");
}

const config = loadConfig();
const providers = config.provider || {};

// === GET DEEPSEEK PROVIDER ===
const deepseekProvider = providers["deepseek"];
const DEEPSEEK_URL =
  deepseekProvider?.options?.baseURL || "https://api.deepseek.com";
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || deepseekProvider?.options?.apiKey || "";

// Models
const STUDENT_MODEL = "deepseek-v4-flash";
const TEACHER_MODEL = "deepseek-v4-pro";

// === AO SQLITE DATABASE ===
const AO_DB_PATH = join(homedir(), ".ao", "data", "ao.db");
const AO_WORKTREES_PATH = join(homedir(), ".ao", "data", "worktrees");

// In-memory session cache
const aoSessionCache = new Map<string, any>();
let aoDb: Database | null = null;

function getAODatabase(): Database | null {
  if (aoDb) return aoDb;
  
  if (!existsSync(AO_DB_PATH)) {
    console.error(`[AO] Database not found at: ${AO_DB_PATH}`);
    return null;
  }
  
  try {
    aoDb = new Database(AO_DB_PATH, { readonly: true });
    return aoDb;
  } catch (e: any) {
    console.error(`[AO] Failed to open database: ${e.message}`);
    aoDb = null;
    return null;
  }
}

// Get worktrees with session info using correct schema
function getWorktreesFromDB(): any[] {
  const db = getAODatabase();
  if (!db) return [];
  
  try {
    // Correct query based on actual schema
    const worktrees = db.query(`
      SELECT 
        sw.session_id,
        sw.repo_name,
        sw.branch,
        sw.base_sha,
        sw.worktree_path,
        sw.state,
        sw.base_ref,
        s.id as session_id_full,
        s.project_id,
        s.num,
        s.kind,
        s.activity_state,
        s.is_terminated,
        s.display_name,
        s.prompt,
        s.latest_user_prompt,
        s.workspace_path,
        s.created_at as session_created_at,
        s.updated_at as session_updated_at
      FROM session_worktrees sw
      INNER JOIN sessions s ON sw.session_id = s.id
      WHERE sw.state = 'active'
        AND s.is_terminated = FALSE
      ORDER BY s.updated_at DESC
    `).all();
    
    return worktrees;
  } catch (e: any) {
    console.error(`[AO] Failed to query worktrees: ${e.message}`);
    return [];
  }
}

// Find existing worktree for a task
function findExistingWorktree(taskSignature: string, userQuery: string): any | null {
  // Check cache first
  const cached = aoSessionCache.get(taskSignature);
  if (cached) {
    console.log(`[AO] ✅ Found cached worktree for ${taskSignature}`);
    return cached;
  }
  
  // Check database
  const worktrees = getWorktreesFromDB();
  
  if (worktrees.length > 0) {
    console.log(`[AO] Checking ${worktrees.length} active worktrees for "${taskSignature}"`);
    
    // Extract invoice number from signature
    const invoiceNum = taskSignature.replace('invoice-', '');
    
    // Look for matching worktree
    const matchingWorktree = worktrees.find((wt: any) => {
      // Check if the session prompt or display name contains the invoice number
      const prompt = (wt.prompt || '').toLowerCase();
      const displayName = (wt.display_name || '').toLowerCase();
      const latestPrompt = (wt.latest_user_prompt || '').toLowerCase();
      const branch = (wt.branch || '').toLowerCase();
      const worktreePath = (wt.worktree_path || '').toLowerCase();
      
      // Check for invoice number in various fields
      return (
        prompt.includes(invoiceNum) ||
        displayName.includes(invoiceNum) ||
        latestPrompt.includes(invoiceNum) ||
        branch.includes(invoiceNum) ||
        worktreePath.includes(invoiceNum) ||
        prompt.includes('reconcile') && prompt.includes(invoiceNum)
      );
    });
    
    if (matchingWorktree) {
      console.log(`[AO] ✅ Found matching worktree for invoice #${invoiceNum}`);
      console.log(`[AO] Session: ${matchingWorktree.display_name || matchingWorktree.session_id}`);
      console.log(`[AO] Worktree: ${matchingWorktree.worktree_path}`);
      aoSessionCache.set(taskSignature, matchingWorktree);
      return matchingWorktree;
    }
  }
  
  // Check filesystem as fallback
  try {
    if (existsSync(AO_WORKTREES_PATH)) {
      const projects = readdirSync(AO_WORKTREES_PATH);
      const invoiceNum = taskSignature.replace('invoice-', '');
      
      for (const project of projects) {
        const projectPath = join(AO_WORKTREES_PATH, project);
        if (existsSync(projectPath)) {
          const worktrees = readdirSync(projectPath);
          
          for (const worktree of worktrees) {
            if (worktree.includes(invoiceNum) || worktree.toLowerCase().includes(invoiceNum)) {
              const session: any = {
                session_id: worktree,
                worktree_path: join(projectPath, worktree),
                branch: worktree,
                state: 'active',
                project_name: project,
              };
              console.log(`[AO] ✅ Found worktree on filesystem: ${worktree}`);
              aoSessionCache.set(taskSignature, session);
              return session;
            }
          }
        }
      }
    }
  } catch (e) {
    // Ignore filesystem errors
  }
  
  console.log(`[AO] No existing worktree found for "${taskSignature}"`);
  return null;
}

// Generate task signature from query
function generateTaskSignature(query: string): string {
  const normalized = query.toLowerCase().trim();
  
  // Extract key identifiers
  const invoiceMatch = normalized.match(/invoice\s*#?(\d+)/i);
  const poMatch = normalized.match(/po\s*#?(\d+)/i);
  const ticketMatch = normalized.match(/ticket\s*#?(\d+)/i);
  
  if (invoiceMatch) return `invoice-${invoiceMatch[1]}`;
  if (poMatch) return `po-${poMatch[1]}`;
  if (ticketMatch) return `ticket-${ticketMatch[1]}`;
  
  // Fallback: use key terms
  const words = normalized
    .split(/\s+/)
    .filter(word => word.length > 3 && !['please', 'reconcile', 'the', 'amount', 'with'].includes(word))
    .slice(0, 3)
    .join('-');
  
  return words || `task-${randomUUID().substring(0, 8)}`;
}

// === AO INTERNAL MESSAGE PREFIXES ===
const AO_INTERNAL_PREFIXES = [
  "AO TASK TITLE UPDATE",
  "AO TASK COMPLETE",
  "AO TASK FAILED",
  "AO WORKER SPAWNED",
  "AO WORKER COMPLETE",
  "AO SYSTEM",
  "A worker was already spawned",
];

function isAOInternalMessage(query: string): boolean {
  const trimmed = query.trimStart();
  return AO_INTERNAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// === RESOLVE BACKEND ===
function resolveBackend(modelString: string): {
  baseURL: string;
  apiKey: string;
  actualModel: string;
} {
  const parts = modelString.split("/");
  if (parts.length >= 2) {
    const providerName = parts[0];
    const modelName = parts.slice(1).join("/");
    const provider = providers[providerName];
    if (provider) {
      return {
        baseURL: provider.options?.baseURL || "",
        apiKey: provider.options?.apiKey || "",
        actualModel: modelName,
      };
    }
  }

  return {
    baseURL: DEEPSEEK_URL,
    apiKey: DEEPSEEK_API_KEY,
    actualModel: STUDENT_MODEL,
  };
}

// === TOOL TYPES ===
interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekChatResult {
  content: string | null;
  toolCalls: ToolCall[] | null;
  finishReason: string;
}

// === CALL DEEPSEEK API (structured result) ===
async function callDeepSeekRaw(
  model: string,
  messages: any[],
  options: {
    temperature?: number;
    tools?: any[];
    tool_choice?: any;
  } = {},
): Promise<DeepSeekChatResult> {
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
    throw new Error("DeepSeek API key not set");
  }

  const body: any = {
    model,
    messages,
    stream: false,
    temperature: options.temperature ?? 0.2,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    if (options.tool_choice !== undefined) {
      body.tool_choice = options.tool_choice;
    }
  }

  const response = await axios.post(`${DEEPSEEK_URL}/chat/completions`, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
  });

  const choice = response.data.choices?.[0];
  const message = choice?.message || {};

  return {
    content: message.content ?? null,
    toolCalls: message.tool_calls ?? null,
    finishReason: choice?.finish_reason || "stop",
  };
}

// === CALL DEEPSEEK API (back-compat, plain text) ===
async function callDeepSeek(
  model: string,
  messages: any[],
  temperature = 0.2,
): Promise<string> {
  const result = await callDeepSeekRaw(model, messages, { temperature });
  return result.content || "";
}

// === EXTRACT JSON ===
function extractJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {}

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e2) {}
  }

  const looseMatch = text.match(/([\{\[][\s\S]*[\}\]])/);
  if (looseMatch) {
    try {
      return JSON.parse(looseMatch[0]);
    } catch (e3) {}
  }

  return null;
}

// === IMPORT CASCADE COMPONENTS ===
let routeIntentFn: any = null;
let layer1ValidateFn: any = null;
let layer2ValidateFn: any = null;
let CompositeSandboxClass: any = null;

async function loadCascadeComponents() {
  if (!routeIntentFn) {
    const routerModule = await import("./src/core/router");
    routeIntentFn = routerModule.routeIntent;
  }
  if (!layer1ValidateFn) {
    const layer1Module = await import("./src/gate/layer1");
    layer1ValidateFn = layer1Module.layer1Validate;
  }
  if (!layer2ValidateFn) {
    const layer2Module = await import("./src/gate/layer2");
    layer2ValidateFn = layer2Module.layer2Validate;
  }
  if (!CompositeSandboxClass) {
    try {
      const sandboxModule = await import("./src/sandbox/index");
      CompositeSandboxClass = sandboxModule.CompositeSandbox;
    } catch (e) {
      console.log("[Cascade] Warning: CompositeSandbox not found, using mock");
      CompositeSandboxClass = class MockSandbox {
        getState() { return {}; }
        async create() {}
        async commit() {}
        async rollback() {}
      };
    }
  }
}

// === CASCADE PIPELINE (TENSORMUX PATTERN) ===
async function cascadePipeline(
  userQuery: string,
  modelRequested: string,
): Promise<any> {
  const traceId = randomUUID();
  console.log(`\n=== CASCADE PIPELINE ===`);
  console.log(`Trace: ${traceId}`);

  await loadCascadeComponents();

  // Step 1: Route intent
  const bundle = await routeIntentFn(userQuery);

  if (!bundle) {
    console.log("[Cascade] No intent matched → forward to DeepSeek");
    return { trace_id: traceId, path: "no_intent", status: "forward" };
  }

  const intentName = bundle.routing_metadata.intent_name;
  const queryLower = userQuery.toLowerCase();

  const codeKeywords = [
    "docs",
    "write",
    "api",
    "code",
    "test",
    "debug",
    "refactor",
  ];

  const isCodeQuery = codeKeywords.some((kw) => queryLower.includes(kw));
  const isDomainIntent =
    intentName.includes("invoice") ||
    intentName.includes("ticket") ||
    intentName.includes("reconcile") ||
    intentName.includes("accrual");

  if (isCodeQuery && isDomainIntent) {
    console.log(
      `[Cascade] Query "${userQuery.substring(0, 50)}" doesn't match domain intent "${intentName}" → forward to DeepSeek`,
    );
    return { trace_id: traceId, path: "no_intent", status: "mismatch" };
  }

  console.log(`[Cascade] Intent: ${intentName}`);

  // === CHECK FOR EXISTING WORKTREE ===
  const taskSignature = generateTaskSignature(userQuery);
  const existingWorktree = findExistingWorktree(taskSignature, userQuery);
  
  let worktreeId: string;
  let worktreeReused = false;
  let worktreePath: string | null = null;
  let sessionInfo: any = null;

  if (existingWorktree) {
    worktreeId = existingWorktree.session_id || existingWorktree.id;
    worktreePath = existingWorktree.worktree_path;
    sessionInfo = existingWorktree;
    worktreeReused = true;
    console.log(`[Cascade] ✅ Reusing existing AO worktree`);
    console.log(`[Cascade] Session ID: ${worktreeId}`);
    console.log(`[Cascade] Worktree path: ${worktreePath}`);
    if (existingWorktree.display_name) {
      console.log(`[Cascade] Display name: ${existingWorktree.display_name}`);
    }
  } else {
    worktreeId = randomUUID();
    console.log(`[Cascade] No existing worktree for "${taskSignature}"`);
    console.log(`[Cascade] AO will manage worktree creation for this session`);
  }

  const schema = bundle.verification_assets.layer1_schema;
  const schemaPrompt = schema
    ? `\n\nRequired output schema:\n${JSON.stringify(schema, null, 2)}`
    : "";

  const schemaProperties = schema?.properties || schema?.fields || {};
  const schemaRequired = schema?.required || [];
  const hasRealSchema =
    Object.keys(schemaProperties).length > 0 || schemaRequired.length > 0;

  const systemContext = `\n\nCURRENT SYSTEM CONTEXT:\n- Current Date/Time: ${new Date().toISOString()}\n- Local Timezone: Asia/Kolkata (Indore, Madhya Pradesh, India)\n${worktreePath ? `- AO Worktree: ${worktreePath}` : ''}\n\nIMPORTANT: If the schema requires a date or timestamp, use the CURRENT SYSTEM CONTEXT above. DO NOT use example dates from the schema.`;

  // Use in-memory sandbox only - AO manages worktrees
  const sandbox = new CompositeSandboxClass();
  sandbox.worktreeId = worktreeId;
  sandbox.traceId = traceId;
  sandbox.isAOHandled = true;

  try {
    // Step 2: Student draft (Speculative Execution)
    console.log(`[Cascade] Student (${STUDENT_MODEL}) drafting...`);
    const studentMessages = [
      {
        role: "system",
        content:
          "You are a task execution agent. Follow the SOP exactly. Output ONLY a valid JSON object matching the schema. No markdown, no arrays, no explanations." +
          systemContext,
      },
      {
        role: "user",
        content: `SOP Instructions:\n${bundle.execution_assets.sop_text}${schemaPrompt}\n\nUser Query:\n${userQuery}\n\nOutput the result as JSON:`,
      },
    ];

    const studentRaw = await callDeepSeek(STUDENT_MODEL, studentMessages, 0.2);
    console.log(`[Cascade] Student raw: ${studentRaw.substring(0, 150)}...`);

    const studentDraft = extractJSON(studentRaw);
    if (!studentDraft) {
      throw new Error("Student failed to produce parseable JSON");
    }

    // Step 3: Layer 1 Gate Validation (Structural)
    const layer1 = await layer1ValidateFn(
      studentDraft,
      bundle.verification_assets.layer1_schema,
    );
    if (!layer1.passed) {
      throw new Error(`Layer 1 Structural Check Failed: ${layer1.output}`);
    }

    if (!hasRealSchema) {
      console.log(
        `[Cascade] "${intentName}" has no real layer1 schema — unverified structural pass.`,
      );
    }

    // Step 4: Layer 2 Gate Validation (Semantic Invariant)
    const dbState = sandbox.getState ? sandbox.getState() : {};
    const layer2 = await layer2ValidateFn(
      studentDraft,
      bundle.verification_assets.layer2_invariant_code,
      dbState,
    );

    if (!layer2.passed) {
      throw new Error(`Layer 2 Invariant Check Failed: ${layer2.output}`);
    }

    // --- FAST PATH (SUCCESS) ---
    console.log(`[Cascade] FAST PATH - Student passed all gates!`);
    console.log(`[Cascade] ✅ No local worktree operations needed (AO manages it)`);

    return {
      trace_id: traceId,
      path: "student_fast_path",
      status: "passed",
      draft: studentDraft,
      intent: bundle.routing_metadata.intent_name,
      gated: hasRealSchema,
      worktree_id: worktreeId,
      worktree_reused: worktreeReused,
      worktree_path: worktreePath,
      task_signature: taskSignature,
      session_id: existingWorktree?.session_id || null,
      display_name: existingWorktree?.display_name || null,
    };
  } catch (gateError: any) {
    // --- FALLBACK PATH (FAILURE) ---
    console.log(`\n[Cascade] GATE TRIGGERED: ${gateError.message}`);
    console.log(
      `[Cascade] Routing to Teacher (${TEACHER_MODEL})...`,
    );

    // Step 5: Execute Teacher Model
    const teacherMessages = [
      {
        role: "system",
        content:
          "You are a highly capable execution agent. Execute the task correctly. Output ONLY valid JSON matching the schema." +
          systemContext,
      },
      {
        role: "user",
        content: `SOP Instructions:\n${bundle.execution_assets.sop_text}${schemaPrompt}\n\nUser Query:\n${userQuery}\n\nExecute correctly and output JSON:`,
      },
    ];

    const teacherRaw = await callDeepSeek(TEACHER_MODEL, teacherMessages, 0.1);
    const teacherDraft = extractJSON(teacherRaw);

    return {
      trace_id: traceId,
      path: "teacher_fallback",
      status: "completed",
      draft: teacherDraft,
      intent: bundle.routing_metadata.intent_name,
      error_caught: gateError.message,
      worktree_id: worktreeId,
      worktree_reused: worktreeReused,
      worktree_path: worktreePath,
      task_signature: taskSignature,
      session_id: existingWorktree?.session_id || null,
      display_name: existingWorktree?.display_name || null,
    };
  }
}

// Request logging
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log("Model:", req.body?.model);
  next();
});

// === STRUCTURED RESPONSE SENDER ===
function sendChatResponse(
  res: express.Response,
  args: {
    traceId: string;
    modelUsed: string;
    content: string | null;
    toolCalls: any[] | null;
    finishReason: string;
    isStreaming: boolean;
    cascadeMetadata: any;
  },
) {
  const {
    traceId,
    modelUsed,
    content,
    toolCalls,
    finishReason,
    isStreaming,
    cascadeMetadata,
  } = args;
  const hasToolCalls = !!toolCalls && toolCalls.length > 0;
  const effectiveFinishReason = hasToolCalls
    ? "tool_calls"
    : finishReason || "stop";

  if (hasToolCalls) {
    console.log(
      `[Router] Response contains ${toolCalls!.length} tool_call(s) — returning as structured tool_calls, not content text`,
    );
  }

  if (isStreaming) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const delta: any = { role: "assistant" };
    if (hasToolCalls) {
      delta.tool_calls = toolCalls;
    } else {
      delta.content = content;
    }

    res.write(
      `data: ${JSON.stringify({
        id: "cascade-" + traceId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelUsed,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        id: "cascade-" + traceId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelUsed,
        choices: [
          { index: 0, delta: {}, finish_reason: effectiveFinishReason },
        ],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const message: any = {
    role: "assistant",
    content: hasToolCalls ? null : content,
  };
  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }

  res.json({
    id: "cascade-" + traceId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelUsed,
    choices: [{ index: 0, message, finish_reason: effectiveFinishReason }],
    cascade_metadata: cascadeMetadata,
  });
}

// === MAIN ENDPOINT ===
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const modelRequested = req.body.model || "auto";
    const messages = req.body.messages || [];
    const isStreaming = req.body.stream === true;
    const incomingTools = Array.isArray(req.body.tools) ? req.body.tools : null;
    const incomingToolChoice = req.body.tool_choice;

    // Extract user query
    const userMessages = messages.filter((m: any) => m.role === "user");
    const lastUserMessage = userMessages[userMessages.length - 1];
    let userQuery = "";

    if (lastUserMessage?.content) {
      if (typeof lastUserMessage.content === "string") {
        userQuery = lastUserMessage.content;
      } else if (Array.isArray(lastUserMessage.content)) {
        userQuery = lastUserMessage.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
      }
    }
    if (!userQuery) userQuery = "No query";

    console.log(`[Router] Query: "${userQuery.substring(0, 100)}..."`);

    // === AO INTERNAL BYPASS ===
    if (isAOInternalMessage(userQuery)) {
      console.log("[Router] AO internal message — bypassing Cascade, forwarding direct");
      const result = await callDeepSeekRaw(STUDENT_MODEL, messages, {
        tools: incomingTools && incomingTools.length > 0 ? incomingTools : undefined,
        tool_choice: incomingToolChoice,
      });
      return sendChatResponse(res, {
        traceId: randomUUID(),
        modelUsed: "deepseek-direct",
        content: result.content,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        isStreaming,
        cascadeMetadata: { path: "ao_internal_bypass" },
      });
    }

    // Check if this query should use Cascade
    const cascadeResult = await cascadePipeline(userQuery, modelRequested);

    let content = "";
    let modelUsed = modelRequested;

    // === ROUTING LOGIC ===
    if (
      cascadeResult.path === "no_intent" ||
      cascadeResult.path === "mismatch" ||
      cascadeResult.path === "forward_to_backend"
    ) {
      console.log(
        "[Router] Forwarding to DeepSeek directly (preserving tools)",
      );

      const result = await callDeepSeekRaw(STUDENT_MODEL, messages, {
        tools:
          incomingTools && incomingTools.length > 0 ? incomingTools : undefined,
        tool_choice: incomingToolChoice,
      });

      return sendChatResponse(res, {
        traceId: cascadeResult.trace_id || randomUUID(),
        modelUsed: "deepseek-direct",
        content: result.content,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        isStreaming,
        cascadeMetadata: cascadeResult,
      });
    } else if (
      cascadeResult.path === "student_fast_path" &&
      cascadeResult.draft
    ) {
      content = JSON.stringify(cascadeResult.draft);
      modelUsed = "cascade-student";
    } else if (
      cascadeResult.path === "teacher_fallback" &&
      cascadeResult.draft
    ) {
      content = JSON.stringify(cascadeResult.draft);
      modelUsed = "cascade-teacher";
    } else {
      // Last resort - call DeepSeek directly
      console.log("[Router] Cascade failed, falling back to DeepSeek");
      try {
        const response = await axios.post(
          `${DEEPSEEK_URL}/chat/completions`,
          {
            model: STUDENT_MODEL,
            messages,
            stream: false,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            },
          },
        );
        content = response.data.choices?.[0]?.message?.content || "";
        modelUsed = "deepseek-fallback";
      } catch (e: any) {
        content = JSON.stringify({
          error: "All paths failed",
          message: e.message,
        });
      }
    }

    // Send response for non-forwarded paths
    if (isStreaming) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(
        `data: ${JSON.stringify({
          id: "cascade-" + cascadeResult.trace_id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelUsed,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );

      res.write(
        `data: ${JSON.stringify({
          id: "cascade-" + cascadeResult.trace_id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelUsed,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );

      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: "cascade-" + cascadeResult.trace_id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelUsed,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        cascade_metadata: cascadeResult,
      });
    }
  } catch (error: any) {
    console.error("Router error:", error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

// === DEBUG ENDPOINTS ===
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "cascade",
    student: STUDENT_MODEL,
    teacher: TEACHER_MODEL,
    ao_database: AO_DB_PATH,
    ao_database_exists: existsSync(AO_DB_PATH),
    worktrees_path: AO_WORKTREES_PATH,
    worktrees_path_exists: existsSync(AO_WORKTREES_PATH),
    cached_sessions: aoSessionCache.size,
  });
});

app.get("/ao/worktrees", (req, res) => {
  const worktrees = getWorktreesFromDB();
  res.json({
    count: worktrees.length,
    worktrees: worktrees.map(wt => ({
      session_id: wt.session_id,
      display_name: wt.display_name,
      worktree_path: wt.worktree_path,
      branch: wt.branch,
      state: wt.state,
      activity_state: wt.activity_state,
      prompt_preview: wt.prompt?.substring(0, 100),
      latest_prompt_preview: wt.latest_user_prompt?.substring(0, 100),
    })),
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`Cascade v3 Router on http://localhost:${PORT}`);
  console.log(`Student: ${STUDENT_MODEL} (DeepSeek Flash)`);
  console.log(`Teacher: ${TEACHER_MODEL} (DeepSeek Pro)`);
  console.log(`AO Database: ${AO_DB_PATH}`);
  console.log(`AO Worktrees: ${AO_WORKTREES_PATH}`);
  console.log(`========================================\n`);
});
