// src/models/teacher.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { 
  startAgentSpan, 
  setSpanAttributes, 
  setTraceOutput, 
  endSpan 
} from "../telemetry";

// Load opencode config for API key (no dotenv needed)
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
        return JSON.parse(cleanRaw);
      }
    } catch (e) {}
  }
  return null;
}

const config = loadConfig();
const deepseekProvider = config?.provider?.deepseek;

const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
// Get key from env first, then from opencode config
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || deepseekProvider?.options?.apiKey || "";
const TEACHER_MODEL = process.env.TEACHER_MODEL || "deepseek-v4-pro";

// Performance target from Branch 1
const TEACHER_COST_USD = 0.12; // Fallback path cost target

// ─── Enhanced teacher model call with telemetry ───────────────────────────
export async function callTeacherModel(
  prompt: string,
  sopText: string,
  schema?: any,
  parentSpan?: any
): Promise<string> {
  // Start AGENT span for teacher fallback
  const span = startAgentSpan('teacherFallback', parentSpan, {
    model: TEACHER_MODEL,
    prompt_length: prompt.length,
    sop_length: sopText?.length || 0,
    has_schema: !!schema,
  });

  const startTime = Date.now();

  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
      throw new Error('DeepSeek API key not set in environment or opencode config');
    }

    const schemaInstruction = schema 
      ? `\n\nREQUIRED SCHEMA:\n${JSON.stringify(schema, null, 2)}` 
      : '';

    const systemPrompt = `You are a highly capable execution agent. Follow the SOP and schema exactly. Output ONLY valid JSON matching the required schema, no markdown, no explanations.

CURRENT SYSTEM CONTEXT:
- Current Date/Time: ${new Date().toISOString()}
- Local Timezone: Asia/Kolkata (Indore)

SOP INSTRUCTIONS:
${sopText}
${schemaInstruction}`;

    const response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: TEACHER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek teacher failed: ${response.status} - ${body}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    const latency_ms = Date.now() - startTime;
    const tokens_used = data.usage?.total_tokens || Math.ceil(content.length / 4);
    const cost_usd = TEACHER_COST_USD; // Fixed cost for teacher fallback

    console.log(`[Teacher] Response generated in ${latency_ms}ms`);
    console.log(`[Teacher] Tokens used: ${tokens_used}`);
    console.log(`[Teacher] Cost: $${cost_usd}`);

    // Set telemetry attributes
    setSpanAttributes(span, {
      status: 'success',
      latency_ms,
      cost_usd,
      tokens_used,
      output_length: content.length,
      finish_reason: data.choices?.[0]?.finish_reason || 'stop',
    });

    // Set trace output with response preview
    setTraceOutput(span, {
      model: TEACHER_MODEL,
      latency_ms,
      cost_usd,
      output_preview: content.substring(0, 500),
    });

    return content;
  } catch (error: any) {
    console.error('[Teacher] Error:', error.message);
    
    setSpanAttributes(span, {
      status: 'error',
      latency_ms: Date.now() - startTime,
      error: error.message,
    });

    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Batch teacher calls for multiple prompts ─────────────────────────────
export async function callTeacherModelBatch(
  prompts: Array<{ prompt: string; sopText: string; schema?: any }>,
  parentSpan?: any
): Promise<string[]> {
  const span = startAgentSpan('teacherBatch', parentSpan, {
    batch_size: prompts.length,
    model: TEACHER_MODEL,
  });

  const startTime = Date.now();

  try {
    const results = await Promise.all(
      prompts.map(p => callTeacherModel(p.prompt, p.sopText, p.schema, span))
    );

    setSpanAttributes(span, {
      status: 'success',
      latency_ms: Date.now() - startTime,
      results_count: results.length,
      cost_usd: TEACHER_COST_USD * results.length,
    });

    return results;
  } catch (error: any) {
    setSpanAttributes(span, {
      status: 'error',
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Teacher model with tools support ─────────────────────────────────────
export async function callTeacherModelWithTools(
  prompt: string,
  sopText: string,
  tools: any[],
  schema?: any,
  parentSpan?: any
): Promise<{ content: string | null; toolCalls: any[] | null }> {
  const span = startAgentSpan('teacherWithTools', parentSpan, {
    model: TEACHER_MODEL,
    tools_count: tools.length,
  });

  const startTime = Date.now();

  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === "sk-xxx") {
      throw new Error('DeepSeek API key not set');
    }

    const response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: TEACHER_MODEL,
        messages: [
          {
            role: "system",
            content: `You are a highly capable execution agent. Follow the SOP exactly.\n\n${sopText}`
          },
          { role: "user", content: prompt }
        ],
        tools,
        stream: false,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek teacher with tools failed: ${response.status}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    
    const latency_ms = Date.now() - startTime;
    const cost_usd = TEACHER_COST_USD;

    setSpanAttributes(span, {
      status: 'success',
      latency_ms,
      cost_usd,
      has_tool_calls: !!message.tool_calls?.length,
      tool_calls_count: message.tool_calls?.length || 0,
    });

    return {
      content: message.content || null,
      toolCalls: message.tool_calls || null,
    };
  } catch (error: any) {
    setSpanAttributes(span, {
      status: 'error',
      latency_ms: Date.now() - startTime,
      error: error.message,
    });
    throw error;
  } finally {
    endSpan(span);
  }
}

// ─── Validate teacher response ────────────────────────────────────────────
export function validateTeacherResponse(
  content: string,
  schema?: any
): { valid: boolean; draft: any; error?: string } {
  try {
    // Try to parse JSON
    let draft;
    try {
      draft = JSON.parse(content);
    } catch (e) {
      // Try markdown code block
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        draft = JSON.parse(match[1]);
      } else {
        // Loose match
        const looseMatch = content.match(/([\{\[][\s\S]*[\}\]])/);
        if (looseMatch) {
          draft = JSON.parse(looseMatch[0]);
        } else {
          return { valid: false, draft: null, error: 'No JSON found in response' };
        }
      }
    }

    // Validate against schema if provided
    if (schema) {
      // Basic schema validation
      const requiredFields = schema.required || [];
      for (const field of requiredFields) {
        if (!(field in draft)) {
          return {
            valid: false,
            draft,
            error: `Missing required field: ${field}`,
          };
        }
      }
    }

    return { valid: true, draft };
  } catch (error: any) {
    return { valid: false, draft: null, error: error.message };
  }
}

// ─── Health check ─────────────────────────────────────────────────────────
export function isTeacherModelAvailable(): boolean {
  return !!DEEPSEEK_API_KEY && DEEPSEEK_API_KEY !== "sk-xxx";
}

// ─── Get model info ───────────────────────────────────────────────────────
export function getTeacherModelInfo(): {
  model: string;
  baseURL: string;
  hasApiKey: boolean;
} {
  return {
    model: TEACHER_MODEL,
    baseURL: DEEPSEEK_URL,
    hasApiKey: isTeacherModelAvailable(),
  };
}
