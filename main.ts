// main.ts - Cascade v3 Router with DeepSeek Student/Teacher (Optimized)
import express from "express";
import axios from "axios";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import {
  initTelemetry,
  flushTelemetry,
  startWorkflowSpan,
  startAgentSpan,
  startChainSpan,
  setSpanAttributes,
  setTraceOutput,
  endSpan,
  isTelemetryReady,
} from "./src/telemetry";

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// === PERFORMANCE TARGETS ===
const PERFORMANCE_TARGETS = {
  fastPathLatencyMs: 1500,
  fastPathCostUsd: 0.005,
  fallbackCostUsd: 0.12,
};

// === RESPONSE CACHE ===
const responseCache = new Map<string, { result: any; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(query: string, intent: string): string {
  return `${intent}:${query.toLowerCase().trim()}`;
}

function getCachedResponse(key: string): any | null {
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }
  if (cached) {
    responseCache.delete(key);
  }
  return null;
}

function deleteCachedResponse(key: string) {
  responseCache.delete(key);
}

function setCachedResponse(key: string, result: any): void {
  responseCache.set(key, { result, timestamp: Date.now() });
  if (responseCache.size > 1000) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
}

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

const deepseekProvider = providers["deepseek"];
const DEEPSEEK_URL =
  deepseekProvider?.options?.baseURL || "https://api.deepseek.com";
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || deepseekProvider?.options?.apiKey || "";

const STUDENT_MODEL = "deepseek-v4-flash";
const TEACHER_MODEL = "deepseek-v4-pro";

// Log API key status (masked)
console.log(`[Config] DeepSeek URL: ${DEEPSEEK_URL}`);
console.log(
  `[Config] API Key: ${DEEPSEEK_API_KEY ? "✅ Present" : "❌ Missing"}`,
);
console.log(`[Config] Student Model: ${STUDENT_MODEL}`);
console.log(`[Config] Teacher Model: ${TEACHER_MODEL}`);

// === AO SQLITE DATABASE ===
const AO_DB_PATH = join(homedir(), ".ao", "data", "ao.db");

const aoSessionCache = new Map<string, any>();
let aoDb: Database | null = null;

function getAODatabase(): Database | null {
  if (aoDb) return aoDb;
  if (!existsSync(AO_DB_PATH)) return null;
  try {
    aoDb = new Database(AO_DB_PATH, { readonly: true });
    return aoDb;
  } catch (e: any) {
    console.error(`[AO] Failed to open database: ${e.message}`);
    aoDb = null;
    return null;
  }
}

function getWorktreesFromDB(): any[] {
  const db = getAODatabase();
  if (!db) return [];
  try {
    return db
      .query(
        `
      SELECT sw.session_id, sw.repo_name, sw.branch, sw.base_sha, sw.worktree_path, sw.state, sw.base_ref,
             s.id as session_id_full, s.project_id, s.num, s.kind, s.activity_state, s.is_terminated,
             s.display_name, s.prompt, s.latest_user_prompt, s.workspace_path,
             s.created_at as session_created_at, s.updated_at as session_updated_at
      FROM session_worktrees sw
      INNER JOIN sessions s ON sw.session_id = s.id
      WHERE sw.state = 'active' AND s.is_terminated = FALSE
      ORDER BY s.updated_at DESC
    `,
      )
      .all();
  } catch (e: any) {
    console.error(`[AO] Failed to query worktrees: ${e.message}`);
    return [];
  }
}

function findExistingWorktree(
  taskSignature: string,
  userQuery: string,
): any | null {
  const cached = aoSessionCache.get(taskSignature);
  if (cached) return cached;

  const worktrees = getWorktreesFromDB();
  if (worktrees.length > 0) {
    const invoiceNum = taskSignature.replace("invoice-", "");
    const matchingWorktree = worktrees.find((wt: any) => {
      const prompt = (wt.prompt || "").toLowerCase();
      const displayName = (wt.display_name || "").toLowerCase();
      const latestPrompt = (wt.latest_user_prompt || "").toLowerCase();
      const branch = (wt.branch || "").toLowerCase();
      const worktreePath = (wt.worktree_path || "").toLowerCase();
      return (
        prompt.includes(invoiceNum) ||
        displayName.includes(invoiceNum) ||
        latestPrompt.includes(invoiceNum) ||
        branch.includes(invoiceNum) ||
        worktreePath.includes(invoiceNum)
      );
    });
    if (matchingWorktree) {
      aoSessionCache.set(taskSignature, matchingWorktree);
      return matchingWorktree;
    }
  }
  return null;
}

function generateTaskSignature(query: string): string {
  const normalized = query.toLowerCase().trim();
  const invoiceMatch = normalized.match(/invoice\s*#?(\d+)/i);
  const poMatch = normalized.match(/po\s*#?(\d+)/i);
  const ticketMatch = normalized.match(/ticket\s*#?(\d+)/i);
  if (invoiceMatch) return `invoice-${invoiceMatch[1]}`;
  if (poMatch) return `po-${poMatch[1]}`;
  if (ticketMatch) return `ticket-${ticketMatch[1]}`;
  return `task-${randomUUID().substring(0, 8)}`;
}

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

// === HISTORY SANITIZATION (no-intent / direct-answer path) ===
const DSML_BLOCK_PATTERN =
  /<｜｜DSML｜｜[^>]*>[\s\S]*?<\/｜｜DSML｜｜[^>]*>|<｜｜DSML｜｜[^>]*>/g;

const DIRECT_ANSWER_HISTORY_LIMIT = 40; // Increased from 20 to reduce pair-breaking

function sanitizeMessageContent(content: any): any {
  if (typeof content === "string") {
    if (!content.includes("｜｜DSML｜｜")) return content;
    const cleaned = content.replace(DSML_BLOCK_PATTERN, "").trim();
    return cleaned;
  }
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part && typeof part === "object" && typeof part.text === "string") {
        return { ...part, text: sanitizeMessageContent(part.text) };
      }
      return part;
    });
  }
  return content;
}

/**
 * Trims an array of non‑system messages to `limit` entries,
 * but ensures that any `tool` message at the start of the trimmed
 * window is preceded by its corresponding assistant `tool_calls` message.
 */
function trimMessagesPreservingTools(messages: any[], limit: number): any[] {
  if (messages.length <= limit) return messages;

  let startIndex = messages.length - limit;
  // Look for the first tool message in the trimmed range
  for (let i = startIndex; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      // Back up to find the preceding assistant message
      let j = i - 1;
      while (j >= 0 && messages[j].role !== "assistant") {
        j--;
      }
      // If that assistant message is before our current start, adjust
      if (j >= 0 && j < startIndex) {
        startIndex = j;
      }
      break; // Only need to fix the first orphan
    }
  }
  return messages.slice(startIndex);
}

function sanitizeMessagesForDirectAnswer(messages: any[]): any[] {
  // We no longer filter out messages that contain DSML tool calls,
  // because we now parse and return proper tool_calls to the client.
  // Instead, we only sanitize content strings to remove any residual DSML.

  const systemMessages = messages.filter((m: any) => m.role === "system");
  const nonSystemMessages = messages.filter((m: any) => m.role !== "system");

  const trimmedHistory = trimMessagesPreservingTools(
    nonSystemMessages,
    DIRECT_ANSWER_HISTORY_LIMIT,
  );

  if (nonSystemMessages.length > DIRECT_ANSWER_HISTORY_LIMIT) {
    console.log(
      `[Sanitize] Trimmed direct-answer history: ${nonSystemMessages.length} -> ${trimmedHistory.length} messages`,
    );
  }

  const combined = [...systemMessages, ...trimmedHistory];

  let strippedCount = 0;
  const sanitized = combined.map((m: any) => {
    if (typeof m.content === "string" && m.content.includes("｜｜DSML｜｜")) {
      strippedCount++;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (
          part &&
          typeof part === "object" &&
          typeof part.text === "string" &&
          part.text.includes("｜｜DSML｜｜")
        ) {
          strippedCount++;
          break;
        }
      }
    }
    return { ...m, content: sanitizeMessageContent(m.content) };
  });

  if (strippedCount > 0) {
    console.log(
      `[Sanitize] Stripped DSML-style delimiter content from ${strippedCount} message(s)`,
    );
  }

  return sanitized;
}

// Additional sanitization for direct answer path
function sanitizeAndPrepareDirectMessages(messages: any[]): any[] {
  // First sanitize existing messages
  const sanitized = sanitizeMessagesForDirectAnswer(messages);

  // Ensure the LAST message (user query) has explicit instructions
  const lastMessage = sanitized[sanitized.length - 1];
  if (lastMessage && lastMessage.role === "user") {
    const originalContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    // Add explicit instruction to prevent tool call syntax in output
    lastMessage.content = `${originalContent}\n\n---\nIMPORTANT INSTRUCTIONS FOR YOUR RESPONSE:\n1. Respond with plain text only - DO NOT output any XML tags, function calls, or tool syntax\n2. DO NOT use format like <invoke> or <parameter> or any similar markers\n3. If you need to reference a file, just mention its path in plain text\n4. Answer directly and conversationally`;
  }

  // Modify system message with stronger instructions
  const systemIndex = sanitized.findIndex((m: any) => m.role === "system");

  if (systemIndex >= 0) {
    sanitized[systemIndex] = {
      ...sanitized[systemIndex],
      content:
        sanitized[systemIndex].content +
        "\n\nCRITICAL RESPONSE FORMAT RULES:\n- Respond in plain text only\n- NEVER output XML tags like <invoke>, <parameter>, or <name>\n- NEVER attempt to make function calls or tool calls\n- If asked about files or code, describe them in prose\n- Do not output JSON or any structured format",
    };
  } else {
    sanitized.unshift({
      role: "system",
      content:
        "You are a helpful AI assistant. Respond with plain text only. Never output XML tags, function calls, or tool syntax. Describe files and code in natural language.",
    });
  }

  return sanitized;
}
// Add this function after the sanitization functions

function extractToolCallsFromDSML(content: string): {
  content: string | null;
  toolCalls: any[] | null;
} {
  if (!content || !content.includes("<｜｜DSML｜｜tool_calls>")) {
    return { content, toolCalls: null };
  }

  console.log("[DSML] Detected DSML-style tool calls in content, parsing...");

  const toolCalls: any[] = [];
  const invokeRegex =
    /<｜｜DSML｜｜invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  let match;

  // Extract all invoke blocks
  const invokeBlocks: {
    start: number;
    end: number;
    name: string;
    args: any;
  }[] = [];

  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[1];
    const paramsBlock = match[2];

    // Parse parameters
    const params: any = {};
    const paramRegex =
      /<｜｜DSML｜｜parameter name="([^"]+)"(?: string="([^"]*)")?>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
    let paramMatch;

    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const paramName = paramMatch[1];
      // const stringValue = paramMatch[2]; // unused, kept for clarity
      const contentValue = paramMatch[3];

      // Use string attribute if present, otherwise use content
      params[paramName] = contentValue.trim();
    }

    invokeBlocks.push({
      start: match.index,
      end: match.index + match[0].length,
      name,
      args: params,
    });
  }

  // Build tool calls
  invokeBlocks.forEach((block, index) => {
    toolCalls.push({
      id: `call_${randomUUID().substring(0, 8)}`,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.args),
      },
    });
  });

  // Extract clean content (text before the tool calls)
  const toolCallsStart = content.indexOf("<｜｜DSML｜｜tool_calls>");
  let cleanContent = content.substring(0, toolCallsStart).trim();

  // If there's content after the tool calls, preserve it
  const toolCallsEnd = content.lastIndexOf("</｜｜DSML｜｜tool_calls>");
  if (
    toolCallsEnd !== -1 &&
    toolCallsEnd + "</｜｜DSML｜｜tool_calls>".length < content.length
  ) {
    const afterContent = content
      .substring(toolCallsEnd + "</｜｜DSML｜｜tool_calls>".length)
      .trim();
    if (afterContent) {
      cleanContent = cleanContent
        ? `${cleanContent}\n\n${afterContent}`
        : afterContent;
    }
  }

  console.log(
    `[DSML] Extracted ${toolCalls.length} tool calls from DSML content`,
  );

  return {
    content: cleanContent || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}
// === DEEPSEEK API CALLS ===

// Non-streaming (for student model - more reliable)
async function callDeepSeekNonStreaming(
  model: string,
  messages: any[],
  options: { temperature?: number; max_tokens?: number } = {},
  parentSpan?: any,
): Promise<string> {
  const span = startAgentSpan("deepseek.nonstream", parentSpan, {
    model,
    message_count: messages.length,
  });
  const startTime = Date.now();

  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
      throw new Error("DeepSeek API key not set");
    }

    const body: any = {
      model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens || 4000,
    };

    const response = await axios.post(
      `${DEEPSEEK_URL}/chat/completions`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 30000,
      },
    );

    const content = response.data.choices?.[0]?.message?.content || "";
    const finishReason = response.data.choices?.[0]?.finish_reason || "stop";
    const latency_ms = Date.now() - startTime;
    const cost_usd = model.includes("pro") ? 0.12 : 0.005;

    console.log(
      `[NonStream] Complete: ${content.length} chars in ${latency_ms}ms (finish: ${finishReason})`,
    );

    setSpanAttributes(span, {
      status: "success",
      latency_ms,
      cost_usd,
      output_length: content.length,
      finish_reason: finishReason,
    });

    return content;
  } catch (error: any) {
    console.error(`[NonStream] Error: ${error.message}`);
    if (error.response) {
      console.error(`[NonStream] Response status: ${error.response.status}`);
      console.error(
        `[NonStream] Response data:`,
        JSON.stringify(error.response.data).substring(0, 500),
      );
    }
    setSpanAttributes(span, {
      status: "error",
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// Streaming (for teacher model)
async function callDeepSeekStreaming(
  model: string,
  messages: any[],
  options: { temperature?: number; max_tokens?: number } = {},
  parentSpan?: any,
): Promise<string> {
  const span = startAgentSpan("deepseek.stream", parentSpan, {
    model,
    message_count: messages.length,
  });
  const startTime = Date.now();
  let fullContent = "";
  let firstTokenTime: number | null = null;

  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
      throw new Error("DeepSeek API key not set");
    }

    const response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens || 8000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[Stream] HTTP ${response.status}: ${errorText.substring(0, 500)}`,
      );
      throw new Error(
        `DeepSeek streaming failed: ${response.status} - ${errorText.substring(0, 200)}`,
      );
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith("data: ")) continue;
        const data = trimmedLine.replace("data: ", "").trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              console.log(
                `[Stream] First token at ${firstTokenTime - startTime}ms`,
              );
            }
            fullContent += delta;
          }
        } catch (e) {
          console.error(
            "[Stream] Failed to parse chunk:",
            data.substring(0, 200),
          );
        }
      }
    }

    const latency_ms = Date.now() - startTime;
    const cost_usd = model.includes("pro") ? 0.12 : 0.005;

    console.log(
      `[Stream] Complete: ${fullContent.length} chars in ${latency_ms}ms`,
    );

    setSpanAttributes(span, {
      status: "success",
      latency_ms,
      cost_usd,
      first_token_ms: firstTokenTime ? firstTokenTime - startTime : null,
      output_length: fullContent.length,
    });

    return fullContent;
  } catch (error: any) {
    console.error(`[Stream] Error: ${error.message}`);
    setSpanAttributes(span, {
      status: "error",
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    if (fullContent.length > 0) return fullContent;
    throw error;
  } finally {
    endSpan(span);
  }
}

// Non-streaming with tools
async function callDeepSeekRaw(
  model: string,
  messages: any[],
  options: {
    temperature?: number;
    tools?: any[];
    tool_choice?: any;
    max_tokens?: number;
  } = {},
  parentSpan?: any,
): Promise<{
  content: string | null;
  toolCalls: any[] | null;
  finishReason: string;
}> {
  const span = startAgentSpan("deepseek.call", parentSpan, {
    model,
    message_count: messages.length,
  });
  const startTime = Date.now();

  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
      throw new Error("DeepSeek API key not set");
    }

    const body: any = {
      model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens || 4000,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice !== undefined)
        body.tool_choice = options.tool_choice;
    }

    console.log(
      `[DeepSeekRaw] Calling ${model} with ${messages.length} messages`,
    );
    if (options.tools && options.tools.length > 0) {
      console.log(`[DeepSeekRaw] Tools available: ${options.tools.length}`);
    }

    const response = await axios.post(
      `${DEEPSEEK_URL}/chat/completions`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 30000,
      },
    );

    const choice = response.data.choices?.[0];
    const message = choice?.message || {};

    const result = {
      content: message.content ?? null,
      toolCalls: message.tool_calls ?? null,
      finishReason: choice?.finish_reason || "stop",
    };

    console.log(
      `[DeepSeekRaw] Content: "${result.content?.substring(0, 100)}..."`,
    );
    console.log(`[DeepSeekRaw] Tool calls: ${result.toolCalls?.length || 0}`);
    console.log(`[DeepSeekRaw] Finish reason: ${result.finishReason}`);

    setSpanAttributes(span, {
      status: "success",
      latency_ms: Date.now() - startTime,
      finish_reason: result.finishReason,
      has_content: !!result.content,
      has_tool_calls: !!result.toolCalls,
      tool_count: result.toolCalls?.length || 0,
    });

    return result;
  } catch (error: any) {
    console.error(`[DeepSeekRaw] Error: ${error.message}`);
    if (error.response) {
      console.error(`[DeepSeekRaw] Response status: ${error.response.status}`);
      console.error(
        `[DeepSeekRaw] Response data:`,
        JSON.stringify(error.response.data).substring(0, 500),
      );
    }
    setSpanAttributes(span, {
      status: "error",
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// === JSON EXTRACTION ===
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

// Format reconciliation response
function formatReconciliationResponse(draft: any): string {
  if (typeof draft === "string") {
    return draft;
  }
  
  if (typeof draft === "object" && draft !== null && Object.keys(draft).length === 0) {
      return JSON.stringify(draft);
  }

  if (!draft || typeof draft !== "object") {
    return JSON.stringify(draft);
  }

  if (draft.summary && (draft.matches || draft.unmatched_invoices)) {
    const summary = draft.summary;
    let response = `📋 **Reconciliation Results**\n\n`;

    const normalizeId = (id: string) => {
      return String(id).replace(/^(INV|PO|inv|po)[-#_\s]*/i, "");
    };

    response += `**Summary:**\n`;
    response += `- Purchase Orders Received: ${summary.total_pos_received || 0}\n`;
    response += `- Invoices Received: ${summary.total_invoices_received || 0}\n`;
    response += `- Confirmed Matches: ${summary.confirmed_matches || 0}\n`;
    response += `- Potential Matches: ${summary.potential_matches || 0}\n`;
    response += `- Unmatched POs: ${summary.unmatched_pos_count || 0}\n`;
    response += `- Unmatched Invoices: ${summary.unmatched_invoices_count || 0}\n`;
    response += `- Total Matched Amount: $${summary.total_matched_amount || 0}\n`;

    if (draft.matches && draft.matches.length > 0) {
      response += `\n**Matches Found:**\n`;
      draft.matches.forEach((match: any, index: number) => {
        const invId = normalizeId(match.invoice_id || "N/A");
        const poId = normalizeId(match.po_id || "N/A");
        response += `${index + 1}. Invoice #${invId} ↔ PO #${poId} - $${match.amount || 0}\n`;
      });
    }

    if (draft.unmatched_invoices && draft.unmatched_invoices.length > 0) {
      response += `\n**Unmatched Invoices:**\n`;
      draft.unmatched_invoices.forEach((inv: string) => {
        const normalizedId = normalizeId(inv);
        response += `- Invoice #${normalizedId}\n`;
      });
    }

    if (draft.unmatched_pos && draft.unmatched_pos.length > 0) {
      response += `\n**Unmatched Purchase Orders:**\n`;
      draft.unmatched_pos.forEach((po: string) => {
        const normalizedId = normalizeId(po);
        response += `- PO #${normalizedId}\n`;
      });
    }

    if (
      draft.unmatched_invoices?.length > 0 ||
      draft.unmatched_pos?.length > 0
    ) {
      response += `\n⚠️ **Action Required:** Manual review needed for unmatched items.`;
    }

    return response;
  }

  if (typeof draft === "object") {
    return JSON.stringify(draft, null, 2);
  }

  return String(draft);
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
      console.warn("[Cascade] Sandbox module not found, using mock");
      CompositeSandboxClass = class MockSandbox {
        getState() {
          return {};
        }
        async create() {}
        async commit() {}
        async rollback() {}
      };
    }
  }
}

// === LEARNING LOOP TRIGGERS ===
async function triggerLearningLoopOnGateFailure(
  userQuery: string,
  teacherDraft: any,
  gateError: Error,
  traceId: string,
  bundle: any,
): Promise<void> {
  try {
    console.log(
      `[LearningLoop] (post-response) Gate-failure trigger for trace ${traceId}`,
    );
    const { AsyncLearningLoop } = await import("./src/learning-loop");
    const learningLoop = new AsyncLearningLoop();
    const intentId = bundle?.routing_metadata?.intent_id || null;
    await learningLoop.run(userQuery, teacherDraft, intentId, gateError);
  } catch (err: any) {
    console.error(
      `[LearningLoop] (post-response) Gate-failure trigger failed for trace ${traceId}:`,
      err.message,
    );
  }
}

async function triggerLearningLoopOnNoIntent(
  userQuery: string,
  traceId: string,
): Promise<void> {
  try {
    console.log(
      `[LearningLoop] (post-response) No-intent trigger for trace ${traceId}`,
    );

    const teacherMessages = [
      {
        role: "system",
        content:
          "You are a highly capable execution agent. Output ONLY a valid JSON object " +
          "capturing the answer to the user's query in structured form. Infer reasonable " +
          "field names and types from the query itself — there is no schema yet, you are " +
          "defining the first one implicitly through your output shape. No markdown, no " +
          "explanations, JSON only.",
      },
      {
        role: "user",
        content: userQuery,
      },
    ];

    const teacherRaw = await callDeepSeekNonStreaming(
      TEACHER_MODEL,
      teacherMessages,
      { temperature: 0.1, max_tokens: 4000 },
    );
    const teacherDraft = extractJSON(teacherRaw);

    if (!teacherDraft) {
      console.error(
        `[LearningLoop] (post-response) No-intent trigger for trace ${traceId}: ` +
          `teacher did not return parseable JSON, aborting bootstrap`,
      );
      return;
    }

    const { AsyncLearningLoop } = await import("./src/learning-loop");
    const learningLoop = new AsyncLearningLoop();

    await learningLoop.run(
      userQuery,
      teacherDraft,
      null,
      new Error("no_intent_matched"),
    );
  } catch (err: any) {
    console.error(
      `[LearningLoop] (post-response) No-intent trigger failed for trace ${traceId}:`,
      err.message,
    );
  }
}

// === CASCADE PIPELINE ===
async function cascadePipeline(
  userQuery: string,
  modelRequested: string,
  parentSpan?: any,
): Promise<any> {
  const traceId = randomUUID();
  const pipelineStartTime = Date.now();
  const workflowSpan = startWorkflowSpan("cascadePipeline", {
    trace_id: traceId,
    query: userQuery.substring(0, 200),
  });

  console.log(`\n=== CASCADE PIPELINE ===`);
  console.log(`Trace: ${traceId}`);

  await loadCascadeComponents();

  try {
    const routeSpan = startChainSpan("routeIntent", workflowSpan, {});
    const routeStartTime = Date.now();
    const bundle = await routeIntentFn(userQuery, routeSpan);
    setSpanAttributes(routeSpan, {
      latency_ms: Date.now() - routeStartTime,
      matched: !!bundle,
    });
    endSpan(routeSpan);

    if (!bundle) {
      console.log("[Cascade] No intent matched, returning forward");
      setSpanAttributes(workflowSpan, {
        "cascade.path": "no_intent",
        latency_ms: Date.now() - pipelineStartTime,
      });
      return { trace_id: traceId, path: "no_intent", status: "forward" };
    }

    const intentName = bundle.routing_metadata.intent_name;
    console.log(`[Cascade] Matched intent: ${intentName}`);

    const queryLower = userQuery.toLowerCase();
    const isCodeQuery = [
      "write", "create", "implement", "add", "fix", "update", "modify",
      "code", "function", "method", "class", "api", "endpoint",
      "placeholder", "integrate", "refactor", "debug", "test",
      "build", "setup", "configure", "show api endpoints"
    ].some((kw) => queryLower.includes(kw));

    // Check if this is an unstructured code query that should be sent to the direct path
    // OR if it's an auto-learned intent that failed to bootstrap properly (has weird names)
    // "auto_learned" intents are generated dynamically and often lack a good schema, 
    // leading to empty output that fails the gates.
    const isMalformedIntent = intentName.includes("__system_reminder__") || 
      bundle?.routing_metadata?.domain === "auto_learned" || 
      bundle?.domain === "auto_learned" || 
      /_\d{10,}$/.test(intentName) ||
      (bundle?.verification_assets?.layer1_schema?.properties && Object.keys(bundle.verification_assets.layer1_schema.properties).length === 0) ||
      (bundle?.verification_assets?.layer1_schema?.type === "object" && Object.keys(bundle.verification_assets.layer1_schema).length === 2 && bundle.verification_assets.layer1_schema.properties);
    
    // Check cache
    const cacheKey = getCacheKey(userQuery, intentName);

    // Ignore cache if malformed
    if (isMalformedIntent || isCodeQuery) {
      console.log(`[Cascade] Code query or malformed intent detected, skipping domain cascade for: ${intentName}`);
      deleteCachedResponse(cacheKey); // Remove bad cache entry
      return {
        trace_id: traceId,
        path: "code_query",
        status: "forward_to_direct",
      };
    }
    if (cachedResult) {
      console.log(`[Cache] ✅ Hit for "${intentName}"`);
      return { ...cachedResult, cache_hit: true };
    }

    const taskSignature = generateTaskSignature(userQuery);
    const existingWorktree = findExistingWorktree(taskSignature, userQuery);
    let worktreeId = existingWorktree?.session_id || randomUUID();
    let worktreePath = existingWorktree?.worktree_path || null;
    let worktreeReused = !!existingWorktree;

    const schema = bundle.verification_assets.layer1_schema;
    const schemaPrompt = schema
      ? `\n\nRequired output schema:\n${JSON.stringify(schema, null, 2)}`
      : "";
    const systemContext = `\n\nCURRENT SYSTEM CONTEXT:\n- Current Date/Time: ${new Date().toISOString()}\n- Local Timezone: Asia/Kolkata (Indore, Madhya Pradesh, India)\n${worktreePath ? `- AO Worktree: ${worktreePath}` : ""}\n\nIMPORTANT: If the schema requires a date or timestamp, use the CURRENT SYSTEM CONTEXT above. DO NOT use example dates from the schema.`;

    const sandbox = new CompositeSandboxClass();
    sandbox.worktreeId = worktreeId;
    sandbox.traceId = traceId;
    sandbox.isAOHandled = true;

    try {
      console.log(`[Cascade] Student (${STUDENT_MODEL}) drafting...`);
      const studentSpan = startAgentSpan("studentDraft", workflowSpan, {
        model: STUDENT_MODEL,
        intent: intentName,
      });
      const studentStartTime = Date.now();
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

      const studentRaw = await callDeepSeekNonStreaming(
        STUDENT_MODEL,
        studentMessages,
        { temperature: 0.2, max_tokens: 4000 },
        studentSpan,
      );
      const studentDraft = extractJSON(studentRaw);

      if (!studentDraft) {
        console.error(
          "[Cascade] Student JSON extraction failed. Raw output:",
          studentRaw.substring(0, 1000),
        );
        throw new Error("Student failed to produce parseable JSON");
      }

      // Check for empty or meaningless draft
      if (
        studentDraft === null ||
        studentDraft === undefined ||
        (typeof studentDraft === "object" &&
          Object.keys(studentDraft).length === 0) ||
        (typeof studentDraft === "string" && studentDraft.trim() === "") ||
        (Array.isArray(studentDraft) && studentDraft.length === 0)
      ) {
        console.error(
          "[Cascade] Student produced empty draft: {}",
          JSON.stringify(studentDraft),
        );
        throw new Error("Student produced empty or meaningless draft");
      }

      // Check if object has only empty values
      if (typeof studentDraft === "object" && !Array.isArray(studentDraft)) {
        const hasContent = Object.values(studentDraft).some(
          (value: any) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            !(typeof value === "object" && Object.keys(value).length === 0),
        );

        if (!hasContent) {
          console.error("[Cascade] Student draft has no meaningful content");
          throw new Error("Student draft contains no meaningful content");
        }
      }

      setSpanAttributes(studentSpan, {
        latency_ms: Date.now() - studentStartTime,
        cost_usd: PERFORMANCE_TARGETS.fastPathCostUsd,
      });
      endSpan(studentSpan);

      console.log(`[Cascade] Running gates...`);
      const [layer1, layer2] = await Promise.all([
        layer1ValidateFn(
          studentDraft,
          bundle.verification_assets.layer1_schema,
        ),
        layer2ValidateFn(
          studentDraft,
          bundle.verification_assets.layer2_invariant_code,
        ),
      ]);

      if (!layer1.passed)
        throw new Error(
          `Layer 1 Failed: ${JSON.stringify(layer1.errors || layer1.output)}`,
        );
      if (!layer2.passed) throw new Error(`Layer 2 Failed: ${layer2.output}`);

      const fastPathLatency = Date.now() - pipelineStartTime;
      console.log(
        `[Cascade] FAST PATH - All gates passed in ${fastPathLatency}ms`,
      );

      const result = {
        trace_id: traceId,
        path: "student_fast_path",
        status: "passed",
        draft: studentDraft,
        intent: intentName,
        worktree_id: worktreeId,
        worktree_reused: worktreeReused,
        latency_ms: fastPathLatency,
        cost_usd: PERFORMANCE_TARGETS.fastPathCostUsd,
      };

      setCachedResponse(cacheKey, result);
      setSpanAttributes(workflowSpan, {
        "cascade.path": "student_fast_path",
        latency_ms: fastPathLatency,
        cost_usd: PERFORMANCE_TARGETS.fastPathCostUsd,
      });
      setTraceOutput(workflowSpan, {
        path: "student_fast_path",
        status: "passed",
      });

      return result;
    } catch (gateError: any) {
      console.log(`\n[Cascade] GATE TRIGGERED: ${gateError.message}`);
      console.log(`[Cascade] Routing to Teacher (${TEACHER_MODEL})...`);

      if (sandbox.rollback) await sandbox.rollback().catch(() => {});

      const teacherSpan = startAgentSpan("teacherFallback", workflowSpan, {
        model: TEACHER_MODEL,
        error: gateError.message,
      });
      const teacherMessages = [
        {
          role: "system",
          content:
            "You are a highly capable execution agent. Output ONLY a COMPLETE valid JSON object with all required fields. Do not truncate." +
            systemContext,
        },
        {
          role: "user",
          content: `SOP Instructions:\n${bundle.execution_assets.sop_text.substring(0, 2000)}${schemaPrompt}\n\nUser Query:\n${userQuery}\n\nExecute correctly and output COMPLETE JSON:`,
        },
      ];

      try {
        const teacherRaw = await callDeepSeekStreaming(
          TEACHER_MODEL,
          teacherMessages,
          { temperature: 0.1, max_tokens: 8000 },
          teacherSpan,
        );
        const teacherDraft = extractJSON(teacherRaw);
        endSpan(teacherSpan);

        if (!teacherDraft) {
          console.error("[Cascade] Teacher failed to produce valid JSON");
          throw new Error("Teacher failed to produce valid JSON");
        }

        const fallbackLatency = Date.now() - pipelineStartTime;
        console.log(
          `[Cascade] Teacher fallback completed in ${fallbackLatency}ms`,
        );

        const result = {
          trace_id: traceId,
          path: "teacher_fallback",
          status: "completed",
          draft: teacherDraft,
          intent: intentName,
          error_caught: gateError.message,
          worktree_id: worktreeId,
          worktree_reused: worktreeReused,
          latency_ms: fallbackLatency,
          cost_usd: PERFORMANCE_TARGETS.fallbackCostUsd,
          _learning_loop_bundle: bundle,
          _learning_loop_gate_error: gateError,
        };

        setSpanAttributes(workflowSpan, {
          "cascade.path": "teacher_fallback",
          latency_ms: fallbackLatency,
          error: gateError.message,
        });

        return result;
      } catch (teacherError: any) {
        console.error(
          "[Cascade] Teacher fallback failed:",
          teacherError.message,
        );
        endSpan(teacherSpan);
        throw teacherError;
      }
    }
  } catch (error: any) {
    console.error("[Cascade] Pipeline error:", error.message);
    setSpanAttributes(workflowSpan, {
      "cascade.path": "error",
      error: error.message,
      latency_ms: Date.now() - pipelineStartTime,
    });
    return {
      trace_id: traceId,
      path: "error",
      status: "error",
      error: error.message,
      latency_ms: Date.now() - pipelineStartTime,
    };
  } finally {
    endSpan(workflowSpan);
  }
}

// === REQUEST LOGGING ===
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
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

  const effectiveContent = content || "";

  if (isStreaming) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const delta: any = { role: "assistant" };
    if (hasToolCalls) delta.tool_calls = toolCalls;
    else delta.content = effectiveContent;

    res.write(
      `data: ${JSON.stringify({ id: "cascade-" + traceId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelUsed, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "cascade-" + traceId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelUsed, choices: [{ index: 0, delta: {}, finish_reason: effectiveFinishReason }] })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const message: any = {
    role: "assistant",
    content: hasToolCalls ? null : effectiveContent,
  };
  if (hasToolCalls) message.tool_calls = toolCalls;

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
  const requestSpan = startChainSpan("chat.completion", null, {
    model: req.body.model,
    stream: req.body.stream === true,
  });

  try {
    const modelRequested = req.body.model || "auto";
    const messages = req.body.messages || [];
    const isStreaming = req.body.stream === true;
    const incomingTools = Array.isArray(req.body.tools) ? req.body.tools : null;
    const incomingToolChoice = req.body.tool_choice;

    console.log(`[Router] Message count: ${messages.length}`);
    if (incomingTools) {
      console.log(`[Router] Incoming tools: ${incomingTools.length}`);
    }

    const userMessages = messages.filter((m: any) => m.role === "user");
    const lastUserMessage = userMessages[userMessages.length - 1];
    let userQuery = "";

    if (lastUserMessage?.content) {
      if (typeof lastUserMessage.content === "string")
        userQuery = lastUserMessage.content;
      else if (Array.isArray(lastUserMessage.content)) {
        userQuery = lastUserMessage.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(" ");
      }
    }
    if (!userQuery) userQuery = "No query";

    console.log(`[Router] Query: "${userQuery.substring(0, 100)}..."`);

    // Check if this is an AO internal message
    if (isAOInternalMessage(userQuery)) {
      console.log("[Router] AO internal message detected, bypassing cascade");
      try {
        const result = await callDeepSeekRaw(
          STUDENT_MODEL,
          messages,
          {
            tools:
              incomingTools && incomingTools.length > 0
                ? incomingTools
                : undefined,
            tool_choice: incomingToolChoice,
            max_tokens: 4000,
          },
          requestSpan,
        );
        let finalContent = result.content;
        let finalToolCalls = result.toolCalls;

        if (
          !finalToolCalls &&
          finalContent &&
          finalContent.includes("<｜｜DSML｜｜tool_calls>")
        ) {
          const parsed = extractToolCallsFromDSML(finalContent);
          finalContent = parsed.content;
          finalToolCalls = parsed.toolCalls;
        }

        // Check for tool calls (now includes DSML-extracted)
        if (finalToolCalls && finalToolCalls.length > 0) {
          console.log(
            `[Router] Model requested ${finalToolCalls.length} tool call(s)`,
          );
          // Use a new traceId for AO internal responses; cascadeResult not available here
          return sendChatResponse(res, {
            traceId: randomUUID(),
            modelUsed: "deepseek-direct",
            content: finalContent,
            toolCalls: finalToolCalls,
            finishReason: "tool_calls",
            isStreaming,
            cascadeMetadata: { path: "ao_internal_bypass" },
          });
        }
        return sendChatResponse(res, {
          traceId: randomUUID(),
          modelUsed: "deepseek-direct",
          content: finalContent,
          toolCalls: finalToolCalls,
          finishReason: result.finishReason,
          isStreaming,
          cascadeMetadata: { path: "ao_internal_bypass" },
        });
      } catch (error: any) {
        console.error("[Router] AO internal message error:", error.message);
        return sendChatResponse(res, {
          traceId: randomUUID(),
          modelUsed: "deepseek-direct",
          content: "I encountered an error while processing your request.",
          toolCalls: null,
          finishReason: "stop",
          isStreaming,
          cascadeMetadata: { path: "ao_internal_bypass", error: error.message },
        });
      }
    }

    // Run cascade pipeline
    const cascadeResult = await cascadePipeline(
      userQuery,
      modelRequested,
      requestSpan,
    );

    let content = "";
    let modelUsed = modelRequested;

    // Handle different cascade paths
    if (cascadeResult.path === "error") {
      console.error("[Router] Cascade pipeline error:", cascadeResult.error);
      return sendChatResponse(res, {
        traceId: cascadeResult.trace_id || randomUUID(),
        modelUsed: "cascade-error",
        content: "I encountered an error while processing your request.",
        toolCalls: null,
        finishReason: "stop",
        isStreaming,
        cascadeMetadata: cascadeResult,
      });
    }

    if (
      cascadeResult.path === "no_intent" ||
      cascadeResult.path === "mismatch" ||
      cascadeResult.path === "code_query" ||
      cascadeResult.path === "forward_to_backend"
    ) {
      console.log("[Router] Forwarding to DeepSeek directly");

      const isCodeQuery = cascadeResult.path === "code_query";

      try {
        let directMessages;
        let toolsToUse;
        let toolChoiceToUse;

        if (isCodeQuery) {
          // For code queries: preserve tools, use sanitized history
          directMessages = sanitizeMessagesForDirectAnswer(messages);
          toolsToUse =
            incomingTools && incomingTools.length > 0
              ? incomingTools
              : undefined;
          toolChoiceToUse = incomingToolChoice;

          console.log(
            `[Router] Code query - preserving ${toolsToUse?.length || 0} tools`,
          );

          // Enhance system prompt for code queries
          const systemIndex = directMessages.findIndex(
            (m: any) => m.role === "system",
          );
          if (systemIndex >= 0) {
            directMessages[systemIndex] = {
              ...directMessages[systemIndex],
              content:
                directMessages[systemIndex].content +
                "\n\nYou are a coding assistant. Use the available tools to explore the codebase, read files, and implement the requested changes. Provide detailed explanations of what you find and what changes need to be made.",
            };
          } else {
            directMessages.unshift({
              role: "system",
              content:
                "You are a coding assistant. Use the available tools to explore the codebase, read files, and implement the requested changes. Provide detailed explanations of what you find and what changes need to be made.",
            });
          }
        } else {
          // For general queries: no tools, enhanced sanitization
          directMessages = sanitizeAndPrepareDirectMessages(messages);
          toolsToUse = undefined;
          toolChoiceToUse = undefined;
        }

        const result = await callDeepSeekRaw(
          STUDENT_MODEL,
          directMessages,
          {
            tools: toolsToUse,
            tool_choice: toolChoiceToUse,
            max_tokens: 4000, // Increased from 2000
            temperature: 0.3,
          },
          requestSpan,
        );

        // Parse DSML if present
        if (result.content && result.content.includes("<｜｜DSML｜｜tool_calls>")) {
          const parsed = extractToolCallsFromDSML(result.content);
          result.content = parsed.content;
          result.toolCalls = parsed.toolCalls;
        }

        // Check for tool calls first
        if (result.toolCalls && result.toolCalls.length > 0) {
          console.log(
            `[Router] Model requested ${result.toolCalls.length} tool call(s)`,
          );
          return sendChatResponse(res, {
            traceId: cascadeResult.trace_id || randomUUID(),
            modelUsed: "deepseek-direct",
            content: null,
            toolCalls: result.toolCalls,
            finishReason: "tool_calls",
            isStreaming,
            cascadeMetadata: cascadeResult,
          });
        }

        // Helper to detect too-short responses
        const isTooShort = (text: string | null) =>
          !text ||
          text.trim().length < 10 ||
          text.trim() === "{}" ||
          text.trim() === "[]";

        if (isTooShort(result.content)) {
          console.error("[Router] Response too short or empty, retrying with same history");

          // Retry using the same directMessages, with higher max_tokens and stronger prompt
          const retryMessages = directMessages.map((m: any) => ({
            ...m,
            content: m.role === "system"
              ? m.content + "\n\nIMPORTANT: Provide a complete, detailed answer. Do not truncate."
              : m.content,
          }));

          const retryResult = await callDeepSeekRaw(
            STUDENT_MODEL,
            retryMessages,
            {
              tools: toolsToUse,
              tool_choice: toolChoiceToUse,
              max_tokens: 8000, // Even higher for retry
              temperature: 0.3,
            },
            requestSpan,
          );

          // Replace result with retry
          result.content = retryResult.content;
          result.toolCalls = retryResult.toolCalls;
          result.finishReason = retryResult.finishReason;
        }

        // If after retry still too short, fallback to error message
        if (isTooShort(result.content)) {
          console.error("[Router] Still getting too short response");
          res.once("finish", () => {
            triggerLearningLoopOnNoIntent(
              userQuery,
              cascadeResult.trace_id || randomUUID(),
            ).catch(() => {});
          });
          return sendChatResponse(res, {
            traceId: cascadeResult.trace_id || randomUUID(),
            modelUsed: "deepseek-direct",
            content:
              "I couldn't analyze your codebase at the moment. Please try again or check the server logs for more details.",
            toolCalls: null,
            finishReason: "stop",
            isStreaming,
            cascadeMetadata: { ...cascadeResult, error: "empty_response" },
          });
        }

        res.once("finish", () => {
          triggerLearningLoopOnNoIntent(
            userQuery,
            cascadeResult.trace_id || randomUUID(),
          ).catch(() => {});
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
      } catch (error: any) {
        console.error("[Router] DeepSeek direct call error:", error.message);
        console.error("[Router] Full error:", error);

        let errorMessage =
          "I encountered an error while processing your request.";
        if (error.response?.status === 401) {
          errorMessage =
            "Authentication failed. Please check your DeepSeek API key.";
        } else if (error.response?.status === 404) {
          errorMessage =
            "The AI model is not available. Please check your model configuration.";
        } else if (error.response?.status === 429) {
          errorMessage = "Rate limit exceeded. Please try again later.";
        } else if (error.code === "ECONNREFUSED") {
          errorMessage =
            "Could not connect to the AI service. Please check your network connection.";
        }

        return sendChatResponse(res, {
          traceId: cascadeResult.trace_id || randomUUID(),
          modelUsed: "deepseek-direct",
          content: errorMessage,
          toolCalls: null,
          finishReason: "stop",
          isStreaming,
          cascadeMetadata: { ...cascadeResult, error: error.message },
        });
      }
    } else if (cascadeResult.draft) {
      content = formatReconciliationResponse(cascadeResult.draft);
      modelUsed =
        cascadeResult.path === "student_fast_path"
          ? "cascade-student"
          : "cascade-teacher";

      if (!content || content.trim() === "") {
        console.error("[Router] Empty content after formatting draft");
        content =
          "I processed your request but couldn't format the response properly.";
      }

      if (
        cascadeResult.path === "teacher_fallback" &&
        cascadeResult._learning_loop_bundle
      ) {
        const bundle = cascadeResult._learning_loop_bundle;
        const gateError =
          cascadeResult._learning_loop_gate_error ||
          new Error(cascadeResult.error_caught || "gate_failed");
        const draft = cascadeResult.draft;
        const traceId = cascadeResult.trace_id;
        res.once("finish", () => {
          triggerLearningLoopOnGateFailure(
            userQuery,
            draft,
            gateError,
            traceId,
            bundle,
          ).catch(() => {});
        });
      }
    } else {
      console.error(
        "[Router] No draft available for path:",
        cascadeResult.path,
      );
      content = "I couldn't process your request properly. Please try again.";
    }

    // Send response
    if (isStreaming) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(
        `data: ${JSON.stringify({ id: "cascade-" + cascadeResult.trace_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelUsed, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "cascade-" + cascadeResult.trace_id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelUsed, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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
    console.error("Full error:", error);

    const isStreaming = req.body.stream === true;
    const traceId = randomUUID();

    if (isStreaming) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const errorContent =
        "I encountered an unexpected error. Please try again.";
      res.write(
        `data: ${JSON.stringify({ id: "cascade-" + traceId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "error", choices: [{ index: 0, delta: { role: "assistant", content: errorContent }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "cascade-" + traceId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "error", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.status(500).json({
        error: {
          message: "Internal server error",
          details: error.message,
        },
      });
    }
  } finally {
    endSpan(requestSpan);
  }
});

// === HEALTH ENDPOINT ===
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    student: STUDENT_MODEL,
    teacher: TEACHER_MODEL,
    telemetry_ready: isTelemetryReady(),
    cache_size: responseCache.size,
    deepseek_url: DEEPSEEK_URL,
    api_key_present: !!DEEPSEEK_API_KEY,
  });
});

// === START SERVER ===
const PORT = 3000;

async function startServer() {
  await initTelemetry().catch((err) => {
    console.error("[Telemetry] Failed to initialize:", err.message);
  });

  console.log("\n=== Configuration ===");
  console.log(`DeepSeek URL: ${DEEPSEEK_URL}`);
  console.log(
    `API Key: ${DEEPSEEK_API_KEY ? "✅ Present (length: " + DEEPSEEK_API_KEY.length + ")" : "❌ Missing"}`,
  );
  console.log(`Student Model: ${STUDENT_MODEL}`);
  console.log(`Teacher Model: ${TEACHER_MODEL}`);
  console.log("====================\n");

  process.on("SIGTERM", async () => {
    console.log("\n[Server] Received SIGTERM, flushing telemetry...");
    await flushTelemetry().catch(() => {});
    process.exit(0);
  });

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`Cascade v3 Router on http://localhost:${PORT}`);
    console.log(`Student: ${STUDENT_MODEL}`);
    console.log(`Teacher: ${TEACHER_MODEL}`);
    console.log(
      `Telemetry: ${isTelemetryReady() ? "✅ Ready" : "❌ Not initialized"}`,
    );
    console.log(`Cache: Enabled (TTL: 5min)`);
    console.log(`========================================\n`);
  });
}

startServer().catch(console.error);
