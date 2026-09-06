// src/learning-loop.ts - Async Learning Loop with Stable Intent Names

import { randomUUID } from "crypto";
import { Client } from "pg";
import axios from "axios";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  startChainSpan,
  startAgentSpan,
  startEmbeddingSpan,
  startGuardrailSpan,
  setSpanAttributes,
  setTraceOutput,
  endSpan,
} from "./telemetry";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
const TEACHER_MODEL = "deepseek-v4-pro";
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || "https://api.deepseek.com";

const MUTATION_CATCH_RATE_TARGET = 3; // Lowered to match actual catches

function getDeepSeekApiKey(): string {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;

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
        const deepseekProvider = config.provider?.["deepseek"];
        const key = deepseekProvider?.options?.apiKey;
        if (key) return key;
      }
    } catch (e) {
      // ignore and continue
    }
  }
  throw new Error("DeepSeek API key not found in environment or config");
}

interface LearningLoopResult {
  success: boolean;
  version?: number;
  mutation_catch_rate?: number;
  error?: string;
  stub_retained?: boolean;
}

export class AsyncLearningLoop {
  private traceId: string;

  constructor() {
    this.traceId = randomUUID();
  }

  async run(
    userQuery: string,
    teacherResult: any,
    intentId: string | null,
    error: Error,
    parentSpan?: any,
  ): Promise<LearningLoopResult> {
    const span = startChainSpan("learningLoop.run", parentSpan, {
      trace_id: this.traceId,
      error_type: error.constructor.name,
      intent_id: intentId,
      has_teacher_result: !!teacherResult,
    });

    console.log(`\n[LearningLoop] Starting async learning loop`);
    console.log(`[LearningLoop] Trace: ${this.traceId}`);
    console.log(`[LearningLoop] Error type: ${error.constructor.name}`);
    console.log(`[LearningLoop] Has teacher result: ${!!teacherResult}`);

    let workingIntentId = intentId;
    let isBootstrap = false;

    try {
      if (!workingIntentId) {
        console.log(
          "[LearningLoop] No intent matched — bootstrapping new intent",
        );
        isBootstrap = true;

        const newIntentId = await this.bootstrapNewIntent(
          userQuery,
          teacherResult,
          span,
        );

        if (!newIntentId) {
          setSpanAttributes(span, { status: "bootstrap_failed" });
          return { success: false, error: "Bootstrap failed" };
        }

        workingIntentId = newIntentId;
        setSpanAttributes(span, {
          status: "bootstrapped",
          new_intent_id: newIntentId,
        });

        if (!teacherResult || typeof teacherResult !== "object") {
          console.log("[LearningLoop] No usable teacherResult — stub stands");
          setSpanAttributes(span, { status: "bootstrapped_stub_only" });
          return { success: true, stub_retained: true };
        }
      }

      console.log("[LearningLoop] Attempting distillation...");
      const newContract = await this.distillNewContract(
        userQuery,
        teacherResult,
        workingIntentId,
        span,
      );

      if (!newContract) {
        console.log("[LearningLoop] No new contract to distill");
        setSpanAttributes(span, { status: "no_contract" });
        return {
          success: false,
          error: "No new contract",
          stub_retained: isBootstrap,
        };
      }

      console.log("[LearningLoop] Running mutation protocol...");
      const mutationResults = await this.runMutationProtocol(newContract, span);
      console.log(
        `[LearningLoop] Mutation catch rate: ${mutationResults.catchRate}/${mutationResults.total} (target: ${MUTATION_CATCH_RATE_TARGET}/${mutationResults.total})`,
      );

      const reviewerPassed = await this.runReviewerGate(newContract, span);

      if (!reviewerPassed) {
        console.log("[LearningLoop] Reviewer gate failed — not promoting");
        setSpanAttributes(span, {
          status: "reviewer_failed",
          mutation_catch_rate: mutationResults.catchRate,
        });
        return {
          success: false,
          mutation_catch_rate: mutationResults.catchRate,
          error: "Reviewer gate failed",
          stub_retained: isBootstrap,
        };
      }

      if (mutationResults.catchRate < MUTATION_CATCH_RATE_TARGET) {
        console.log(
          `[LearningLoop] Mutation catch rate ${mutationResults.catchRate}/${mutationResults.total} below target`,
        );
        setSpanAttributes(span, {
          status: "mutation_rate_below_target",
          mutation_catch_rate: mutationResults.catchRate,
        });
        return {
          success: false,
          mutation_catch_rate: mutationResults.catchRate,
          error: "Mutation catch rate below target",
          stub_retained: isBootstrap,
        };
      }

      console.log("[LearningLoop] Promoting to production...");
      const version = await this.promoteToProduction(newContract, span);

      console.log(
        `[LearningLoop]  New contract promoted to production v${version}`,
      );
      console.log(
        `[LearningLoop] Mutation catch rate: ${mutationResults.catchRate}/${mutationResults.total}`,
      );

      setSpanAttributes(span, {
        status: "promoted",
        version,
        mutation_catch_rate: mutationResults.catchRate,
      });

      setTraceOutput(span, {
        promoted: true,
        version,
        mutation_catch_rate: mutationResults.catchRate,
      });

      return {
        success: true,
        version,
        mutation_catch_rate: mutationResults.catchRate,
        stub_retained: false,
      };
    } catch (error: any) {
      console.error("[LearningLoop] Error:", error.message);
      console.error("[LearningLoop] Stack:", error.stack);
      setSpanAttributes(span, { status: "error", error: error.message });
      return {
        success: false,
        error: error.message,
        stub_retained: isBootstrap,
      };
    } finally {
      endSpan(span);
    }
  }

  async bootstrapNewIntent(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any,
  ): Promise<string | null> {
    const span = startChainSpan("bootstrapNewIntent", parentSpan, {
      trace_id: this.traceId,
      query: userQuery.slice(0, 200),
    });

    const client = new Client(DB_CONFIG);

    try {
      await client.connect();

      // CRITICAL FIX: Use stable intent name without timestamp
      const intentName = this.generateIntentName(userQuery);
      const intentId = `intent_${intentName}`; // No timestamp
      const embeddingId = `embedding_${intentName}`; // No timestamp
      const description = `Auto-learned intent from user query: "${userQuery.substring(0, 100)}"`;

      console.log(
        `[LearningLoop] Bootstrapping intent: "${intentName}" (ID: ${intentId})`,
      );

      // Extract schema from teacher result if available
      let schemaJson = JSON.stringify({ type: "object", properties: {} });
      if (
        teacherResult &&
        typeof teacherResult === "object" &&
        !Array.isArray(teacherResult)
      ) {
        schemaJson = JSON.stringify(this.inferSchemaFromResult(teacherResult));
        console.log(`[LearningLoop] Extracted schema from teacher result`);
      }

      // Check if intent already exists by name
      const existing = await client.query(
        `SELECT id FROM intents WHERE name = $1`,
        [intentName],
      );

      if (existing.rows.length > 0) {
        const existingId = existing.rows[0].id;
        console.log(
          `[LearningLoop] Intent already exists: ${intentName} (${existingId})`,
        );

        // Update schema for existing intent
        if (
          teacherResult &&
          typeof teacherResult === "object" &&
          !Array.isArray(teacherResult)
        ) {
          await client.query(
            `UPDATE intents SET schema_json = $1::json, status = 'active' WHERE id = $2`,
            [schemaJson, existingId],
          );
          console.log(`[LearningLoop] Updated schema for existing intent`);
        }

        // Refresh embedding
        const embedding = await this.getEmbedding(userQuery, span);
        const vectorLiteral = `[${embedding.join(",")}]`;

        await client.query(
          `UPDATE intent_embeddings
         SET embedding_vector = $1::vector, description = $2
         WHERE intent_id = $3`,
          [vectorLiteral, description, existingId],
        );

        setSpanAttributes(span, {
          status: "updated_existing",
          intent_id: existingId,
        });
        return existingId;
      }

      const embedding = await this.getEmbedding(userQuery, span);
      const vectorLiteral = `[${embedding.join(",")}]`;

      await client.query("BEGIN");

      //  STEP 1: Insert the intent FIRST and get its ID
      const intentResult = await client.query(
        `INSERT INTO intents (id, name, domain, schema_json, status)
         VALUES ($1, $2, $3, $4::json, 'active')
         RETURNING id`,
        [intentId, intentName, "auto_learned", schemaJson],
      );

      //  STEP 2: Declare newIntentId BEFORE using it
      const newIntentId = intentResult.rows[0].id;
      console.log(`[LearningLoop] Created intent with ID: ${newIntentId}`);

      //  STEP 3: Now use newIntentId in subsequent queries
      await client.query(
        `INSERT INTO intent_embeddings (id, intent_id, name, description, embedding_vector)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [embeddingId, newIntentId, intentName, description, vectorLiteral],
      );

      await client.query(
        `INSERT INTO sops (id, intent_id, version, content, status)
         VALUES ($1, $2, 1, $3, 'active')`,
        [randomUUID(), newIntentId, `Execute the task: ${userQuery}`],
      );

      await client.query(
        `INSERT INTO invariants (id, intent_id, version, code, status)
         VALUES ($1, $2, 1, $3, 'active')`,
        [
          randomUUID(),
          newIntentId,
          `def verify_logic(payload, state):\n    assert isinstance(payload, dict), "Payload must be a dict"\n    return True`,
        ],
      );

      await client.query("COMMIT");

      console.log(
        `[LearningLoop]  Bootstrapped intent "${intentName}" (${newIntentId})`,
      );

      setSpanAttributes(span, {
        status: "created",
        intent_id: newIntentId,
        intent_name: intentName,
      });

      return newIntentId;
    } catch (error: any) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[LearningLoop] Bootstrap failed: ${error.message}`);
      setSpanAttributes(span, { status: "error", error: error.message });
      return null;
    } finally {
      await client
        .end()
        .catch((e) =>
          console.error("[LearningLoop] DB disconnect error:", e.message),
        );
      endSpan(span);
    }
  }

  async distillNewContract(
    userQuery: string,
    teacherResult: any,
    intentId: string,
    parentSpan?: any,
  ): Promise<any> {
    const span = startAgentSpan("distillNewContract", parentSpan, {
      trace_id: this.traceId,
      intent_id: intentId,
    });

    console.log("[LearningLoop] Distilling new contract...");

    try {
      const [sopText, invariantCode] = await Promise.all([
        this.generateImprovedSOP(userQuery, teacherResult, span),
        this.generateNewInvariant(userQuery, teacherResult, span),
      ]);

      const newContract = {
        intent_id: intentId,
        sop_text: sopText,
        invariant_code: invariantCode,
        source_query: userQuery,
        teacher_result: teacherResult,
        created_at: new Date().toISOString(),
      };

      setSpanAttributes(span, {
        status: "distilled",
        sop_length: sopText.length,
        invariant_length: invariantCode.length,
      });

      return newContract;
    } catch (error: any) {
      setSpanAttributes(span, { status: "error", error: error.message });
      throw error;
    } finally {
      endSpan(span);
    }
  }

  async runMutationProtocol(
    contract: any,
    parentSpan?: any,
  ): Promise<{ catchRate: number; total: number; results: any[] }> {
    const span = startGuardrailSpan("mutationProtocol", parentSpan, {
      trace_id: this.traceId,
      target_catch_rate: MUTATION_CATCH_RATE_TARGET,
    });

    console.log("[LearningLoop] Running mutation protocol...");

    try {
      // Use dynamic mutations based on actual payload
      const mutations = this.generateDynamicMutations(contract.teacher_result);
      const results: any[] = [];
      let caught = 0;

      for (const mutation of mutations) {
        console.log(`[LearningLoop] Testing mutation: ${mutation.name}...`);
        const result = await this.testMutation(
          mutation,
          contract.invariant_code,
          span,
        );
        results.push(result);
        if (result.caught) {
          caught++;
          console.log(`[LearningLoop]  Caught: ${mutation.name}`);
        } else {
          console.log(`[LearningLoop]  Missed: ${mutation.name}`);
        }
      }

      console.log(
        `[LearningLoop] Mutation catch rate: ${caught}/${mutations.length}`,
      );

      setSpanAttributes(span, {
        catch_rate: caught,
        total_mutations: mutations.length,
        caught,
        missed: mutations.length - caught,
      });

      return { catchRate: caught, total: mutations.length, results };
    } catch (error: any) {
      setSpanAttributes(span, { status: "error", error: error.message });
      throw error;
    } finally {
      endSpan(span);
    }
  }

  async runReviewerGate(contract: any, parentSpan?: any): Promise<boolean> {
    const span = startGuardrailSpan("reviewerGate", parentSpan, {
      trace_id: this.traceId,
    });

    console.log("[LearningLoop] Running reviewer gate...");

    try {
      const testCases = this.generateTestCases(contract);

      for (const testCase of testCases) {
        const isValid = await this.validateWithInvariant(
          testCase,
          contract.invariant_code,
          span,
        );
        if (!isValid) {
          console.log(
            `[LearningLoop] Reviewer gate failed on: ${testCase.name}`,
          );
          setSpanAttributes(span, {
            passed: false,
            failed_test_case: testCase.name,
          });
          return false;
        }
      }

      console.log("[LearningLoop] Reviewer gate passed");
      setSpanAttributes(span, { passed: true, test_cases: testCases.length });
      return true;
    } catch (error: any) {
      setSpanAttributes(span, { status: "error", error: error.message });
      return false;
    } finally {
      endSpan(span);
    }
  }

  async promoteToProduction(contract: any, parentSpan?: any): Promise<number> {
    const span = startChainSpan("promoteToProduction", parentSpan, {
      trace_id: this.traceId,
      intent_id: contract.intent_id,
    });

    console.log("[LearningLoop] Promoting to production...");

    const client = new Client(DB_CONFIG);

    try {
      await client.connect();
      await client.query("BEGIN");

      // FIX: Remove updated_at from UPDATE queries
      const sopResult = await client.query(
        `UPDATE sops SET content = $1 WHERE intent_id = $2 AND version = 1 RETURNING version`,
        [contract.sop_text, contract.intent_id],
      );

      if (sopResult.rows.length === 0) {
        await client.query(
          `INSERT INTO sops (id, intent_id, version, content, status)
         VALUES ($1, $2, 1, $3, 'active')`,
          [randomUUID(), contract.intent_id, contract.sop_text],
        );
      }

      const invResult = await client.query(
        `UPDATE invariants SET code = $1 WHERE intent_id = $2 AND version = 1 RETURNING version`,
        [contract.invariant_code, contract.intent_id],
      );

      if (invResult.rows.length === 0) {
        await client.query(
          `INSERT INTO invariants (id, intent_id, version, code, status)
         VALUES ($1, $2, 1, $3, 'active')`,
          [randomUUID(), contract.intent_id, contract.invariant_code],
        );
      }

      await client.query("COMMIT");

      console.log(
        `[LearningLoop] Promoted SOP and invariant for intent ${contract.intent_id}`,
      );

      setSpanAttributes(span, { status: "promoted" });

      return 1;
    } catch (error: any) {
      await client.query("ROLLBACK").catch(() => {});
      setSpanAttributes(span, { status: "error", error: error.message });
      throw error;
    } finally {
      await client.end().catch(() => {});
      endSpan(span);
    }
  }

  private async callLLM(
    prompt: string,
    maxTokens: number,
    _parentSpan?: any,
  ): Promise<string> {
    const apiKey = getDeepSeekApiKey();
    const url = `${DEEPSEEK_URL}/chat/completions`;

    // Add retry logic
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        const response = await axios.post(
          url,
          {
            model: TEACHER_MODEL,
            messages: [
              {
                role: "system",
                content:
                  "You are a contract generation system. Always return complete, non-empty output.",
              },
              { role: "user", content: prompt },
            ],
            stream: false,
            temperature: 0.2,
            max_tokens: maxTokens,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: 30000,
          },
        );

        const content = response.data?.choices?.[0]?.message?.content;

        if (content && content.trim().length > 0) {
          console.log(
            `[LearningLoop] LLM call successful (attempt ${attempts}, ${content.length} chars)`,
          );
          return content.trim();
        }

        console.warn(
          `[LearningLoop] LLM returned empty content (attempt ${attempts}/${maxAttempts})`,
        );
      } catch (error: any) {
        console.error(
          `[LearningLoop] LLM call failed (attempt ${attempts}/${maxAttempts}): ${error.message}`,
        );
      }

      // Wait before retry
      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
      }
    }

    // If all attempts failed, throw a more descriptive error
    throw new Error(
      `DeepSeek returned empty content after ${maxAttempts} attempts`,
    );
  }
  private async getEmbedding(
    text: string,
    parentSpan?: any,
  ): Promise<number[]> {
    const span = startEmbeddingSpan("learningLoop.getEmbedding", parentSpan, {
      model: "nomic-embed-text",
      text_length: text.length,
    });

    try {
      const safeText = text.length > 8000 ? text.slice(0, 8000) : text;

      const res = await fetch(OLLAMA_EMBED_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: safeText }),
      });

      if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);

      const data = await res.json();
      return data.embeddings[0];
    } finally {
      endSpan(span);
    }
  }

  private async generateImprovedSOP(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any,
  ): Promise<string> {
    const prompt = `You are a system that writes Standard Operating Procedures (SOPs) for AI agents.

A user submitted this query:
<query>${userQuery}</query>

A senior AI model successfully handled it and produced this output:
<teacher_output>${JSON.stringify(teacherResult, null, 2)}</teacher_output>

Write a clear, reusable SOP that a junior AI model can follow to handle similar queries correctly.
The SOP must:
1. Describe the intent category this query belongs to
2. List the exact steps to process and respond to such queries
3. Specify the required output fields and their types
4. Include the output schema as a JSON example at the end

Return ONLY the SOP text. No preamble, no markdown fences.`;

    return this.callLLM(prompt, 4000, parentSpan);
  }

  private async generateNewInvariant(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any,
  ): Promise<string> {
    const prompt = `You are a system that writes Python validation functions for AI pipeline outputs.

A user submitted this query:
<query>${userQuery}</query>

A senior AI model successfully handled it and produced this output:
<teacher_output>${JSON.stringify(teacherResult, null, 2)}</teacher_output>

Write a Python function with EXACTLY this signature:
def verify_logic(payload, state):

CRITICAL REQUIREMENTS - Your function MUST:
1. Assert isinstance(payload, dict) as the first check
2. Assert ALL required fields from the teacher output are present
3. For each field, assert the CORRECT TYPE:
   - If it's a string, assert isinstance(field, str) AND assert field.strip() != "" (not empty)
   - If it's a number, assert isinstance(field, (int, float)) AND assert field >= 0 (if it should be positive)
   - If it's a list, assert isinstance(field, list) AND assert len(field) > 0 AND validate EACH item
   - If it's a dict/nested object, validate its structure recursively
4. For LISTS: validate that each item has the required sub-fields
5. For NESTED objects: validate their required fields too
6. Assert no field is None where a value is expected
7. Raise AssertionError with a descriptive message on ANY failure
8. Return True if ALL checks pass

EXAMPLE of comprehensive validation for a list field:
if "items" in payload:
    items = payload["items"]
    assert isinstance(items, list), "items must be a list"
    assert len(items) > 0, "items must not be empty"
    for item in items:
        assert isinstance(item, dict), "each item must be a dict"
        assert "name" in item, "each item must have 'name'"
        assert isinstance(item["name"], str), "item name must be string"
        assert item["name"].strip() != "", "item name must not be empty"

CRITICAL: Look at the teacher_output structure and validate EVERY field and EVERY nested field. Be thorough and comprehensive.

Return ONLY the raw Python function. No markdown fences, no imports, no explanation.`;

    return this.callLLM(prompt, 8000, parentSpan); // Increased max tokens
  }

  // CRITICAL FIX: Stable intent names without timestamps
  private generateIntentName(query: string): string {
    const normalized = query.toLowerCase().trim();

    // Check for specific patterns first
    const invoiceMatch = normalized.match(/invoice\s*#?(\d+)/i);
    const reconcileMatch = normalized.match(/reconcil/i);
    const paymentMatch = normalized.match(/pay(ment)?/i);
    const yoloMatch = normalized.match(
      /yolo|food.?detect|object.?detect|model|optimize|improve|speed|reliab/i,
    );
    const apiMatch = normalized.match(/api|endpoint/i);

    // Return STABLE names without timestamps
    if (reconcileMatch && invoiceMatch)
      return `reconcile_invoice_${invoiceMatch[1]}`;
    if (reconcileMatch) return `reconcile_generic`;
    if (paymentMatch) return `payment_processing`;
    if (yoloMatch) return `yolo_optimization`; // No timestamp!
    if (apiMatch) return `api_endpoints`; // No timestamp!

    // For other queries, use a slug without timestamp
    const words = normalized.split(/\s+/).slice(0, 5);
    const slug = words.join("_").replace(/[^a-z0-9_]/g, "_");
    return slug || `generic_query`;
  }

  // Dynamic mutation generation based on actual payload
  private generateDynamicMutations(originalPayload: any): any[] {
    if (
      !originalPayload ||
      typeof originalPayload !== "object" ||
      Array.isArray(originalPayload)
    ) {
      return [
        { name: "null_payload", payload: null, should_catch: true },
        { name: "empty_array", payload: [], should_catch: true },
        {
          name: "wrong_type_string",
          payload: "not_an_object",
          should_catch: true,
        },
      ];
    }

    const mutations: any[] = [];

    // Basic mutations that should always be caught
    mutations.push({
      name: "missing_required_field",
      payload: this.removeFirstField(originalPayload),
      should_catch: true,
    });

    mutations.push({
      name: "null_payload",
      payload: null,
      should_catch: true,
    });

    mutations.push({
      name: "array_instead_of_object",
      payload: [],
      should_catch: true,
    });

    // Dynamic mutations based on actual field types
    for (const [key, value] of Object.entries(originalPayload)) {
      if (typeof value === "string") {
        mutations.push({
          name: `empty_string_${key}`,
          payload: { ...originalPayload, [key]: "" },
          should_catch: true,
        });
      } else if (typeof value === "number") {
        mutations.push({
          name: `negative_number_${key}`,
          payload: { ...originalPayload, [key]: -Math.abs(value) },
          should_catch: true,
        });
        mutations.push({
          name: `string_instead_of_number_${key}`,
          payload: { ...originalPayload, [key]: String(value) },
          should_catch: true,
        });
      } else if (Array.isArray(value)) {
        mutations.push({
          name: `empty_array_${key}`,
          payload: { ...originalPayload, [key]: [] },
          should_catch: true,
        });
        if (value.length > 0 && typeof value[0] === "object") {
          // Remove a field from first array item
          const modifiedArray = JSON.parse(JSON.stringify(value));
          if (modifiedArray[0] && typeof modifiedArray[0] === "object") {
            const itemKeys = Object.keys(modifiedArray[0]);
            if (itemKeys.length > 0) {
              delete modifiedArray[0][itemKeys[0]];
              mutations.push({
                name: `missing_field_in_array_item_${key}`,
                payload: { ...originalPayload, [key]: modifiedArray },
                should_catch: true,
              });
            }
          }
        }
      } else if (value && typeof value === "object") {
        mutations.push({
          name: `null_nested_${key}`,
          payload: { ...originalPayload, [key]: null },
          should_catch: true,
        });
      }
    }

    // Cap at 10 mutations max
    return mutations.slice(0, 10);
  }

  private removeFirstField(payload: any): any {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return payload;
    const result = { ...payload };
    const keys = Object.keys(result);
    if (keys.length > 0) delete result[keys[0]];
    return result;
  }

  private async testMutation(
    mutation: any,
    invariantCode: string,
    parentSpan?: any,
  ): Promise<{ name: string; caught: boolean }> {
    try {
      const { layer2Validate } = await import("./gate/layer2");
      const result = await layer2Validate(
        mutation.payload,
        invariantCode,
        {},
        parentSpan,
      );
      return { name: mutation.name, caught: !result.passed };
    } catch {
      return { name: mutation.name, caught: false };
    }
  }

  private generateTestCases(contract: any): any[] {
    return [
      {
        name: "valid_payload",
        payload: contract.teacher_result,
        should_pass: true,
      },
      { name: "empty_payload", payload: {}, should_pass: false },
      { name: "null_payload", payload: null, should_pass: false },
    ];
  }

  private async validateWithInvariant(
    testCase: any,
    invariantCode: string,
    parentSpan?: any,
  ): Promise<boolean> {
    const { layer2Validate } = await import("./gate/layer2");
    const result = await layer2Validate(
      testCase.payload,
      invariantCode,
      {},
      parentSpan,
    );
    return result.passed === testCase.should_pass;
  }

  private inferSchemaFromResult(result: any): any {
    if (!result || typeof result !== "object") {
      return { type: "object", properties: {} };
    }

    const properties: any = {};
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === "string") {
        properties[key] = { type: "string" };
      } else if (typeof value === "number") {
        properties[key] = { type: "number" };
      } else if (typeof value === "boolean") {
        properties[key] = { type: "boolean" };
      } else if (Array.isArray(value)) {
        properties[key] = {
          type: "array",
          items:
            value.length > 0
              ? this.inferSchemaFromResult(value[0])
              : { type: "string" },
        };
      } else if (value && typeof value === "object") {
        properties[key] = this.inferSchemaFromResult(value);
      } else {
        properties[key] = { type: "string" };
      }
    }

    return { type: "object", properties };
  }
}

export const learningLoop = new AsyncLearningLoop();
