// src/learning-loop.ts - Async Learning Loop
// Owns all intent bootstrapping, contract distillation, mutation testing,
// and promotion to production. The router never writes to the DB.

import { randomUUID } from 'crypto';
import { Client } from 'pg';
import {
  startChainSpan,
  startAgentSpan,
  startEmbeddingSpan,
  startGuardrailSpan,
  setSpanAttributes,
  setTraceOutput,
  endSpan,
} from './telemetry';

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embed';
const OLLAMA_CHAT_URL  = 'http://localhost:11434/api/chat';
const TEACHER_MODEL    = 'deepseek-v4-pro'; // match your actual model name

const MUTATION_CATCH_RATE_TARGET = 10; // 10/10 mutations must be caught

interface LearningLoopResult {
  success: boolean;
  version?: number;
  mutation_catch_rate?: number;
  error?: string;
  // True when a distillation attempt was made but failed some gate
  // (reviewer or mutation rate) and the stub SOP/invariant was left in
  // place rather than replaced. Only meaningful on the bootstrap path —
  // Path B has no stub to fall back to, an unpromoted contract there
  // just means the OLD active SOP/invariant stays active, same as before.
  stub_retained?: boolean;
}

export class AsyncLearningLoop {
  private traceId: string;

  constructor() {
    this.traceId = randomUUID();
  }

  // ─── Main entry point ───────────────────────────────────────────────────
  // intentId = null  → no match. Bootstrap a new intent (stub), THEN
  //                     immediately attempt to distill/mutate/promote a
  //                     real v1 contract on top of it. If distillation
  //                     fails any gate, the stub stands — the intent is
  //                     still matchable next time, it just keeps its
  //                     placeholder SOP/invariant until a later run
  //                     succeeds. This fallthrough is the change from
  //                     before: previously this branch returned right
  //                     after bootstrapNewIntent and never reached the
  //                     distill/mutate/promote code below, even though
  //                     that code has always been written to run
  //                     unconditionally once it has an intentId.
  // intentId = string → student failed on a known intent, distill + promote
  async run(
    userQuery: string,
    teacherResult: any,
    intentId: string | null,
    error: Error,
    parentSpan?: any
  ): Promise<LearningLoopResult> {
    const span = startChainSpan('learningLoop.run', parentSpan, {
      trace_id: this.traceId,
      error_type: error.constructor.name,
      intent_id: intentId,
      has_teacher_result: !!teacherResult,
    });

    console.log(`\n[LearningLoop] Starting async learning loop`);
    console.log(`[LearningLoop] Trace: ${this.traceId}`);

    let workingIntentId = intentId;
    let isBootstrap = false;

    try {
      // ── Path A: no matching intent — create the stub first ─────────────
      if (!workingIntentId) {
        console.log('[LearningLoop] No intent matched — bootstrapping new intent');
        isBootstrap = true;

        const newIntentId = await this.bootstrapNewIntent(userQuery, teacherResult, span);

        if (!newIntentId) {
          setSpanAttributes(span, { status: 'bootstrap_failed' });
          return { success: false, error: 'Bootstrap failed' };
        }

        workingIntentId = newIntentId;
        setSpanAttributes(span, { status: 'bootstrapped', new_intent_id: newIntentId });

        // Deliberately NOT returning here. Previously this function
        // returned `{ success: true }` immediately once bootstrapNewIntent
        // resolved, leaving the intent permanently on its stub SOP
        // (`Execute the task: ${userQuery}`) and stub invariant
        // (`isinstance(payload, dict)`) — real contract distillation only
        // ever ran on Path B (known intentId). Falling through here means
        // a fresh intent gets the same distill → mutate → review → promote
        // treatment as an intent that's already been in production.
        //
        // teacherResult MUST be real structured JSON for this to be worth
        // anything — distillNewContract does JSON.stringify(teacherResult)
        // and hands it to an LLM writing a JSON-schema SOP and a Python
        // validator. Prose (e.g. a conversational direct-answer response)
        // will produce a garbage SOP/invariant here. It's the caller's
        // responsibility to pass a JSON draft, not free text, when
        // intentId is null and it wants more than the stub.
        if (!teacherResult || typeof teacherResult !== 'object') {
          console.log(
            '[LearningLoop] No usable teacherResult for distillation — stub stands',
          );
          setSpanAttributes(span, { status: 'bootstrapped_stub_only' });
          return { success: true, stub_retained: true };
        }
      }

      // ── Path B (and Path A fallthrough): distill + mutate + promote ────
      const newContract = await this.distillNewContract(userQuery, teacherResult, workingIntentId, span);

      if (!newContract) {
        console.log('[LearningLoop] No new contract to distill');
        setSpanAttributes(span, { status: 'no_contract' });
        return { success: false, error: 'No new contract', stub_retained: isBootstrap };
      }

      const mutationResults = await this.runMutationProtocol(newContract, span);
      const reviewerPassed  = await this.runReviewerGate(newContract, span);

      if (!reviewerPassed) {
        console.log('[LearningLoop] Reviewer gate failed — not promoting');
        setSpanAttributes(span, {
          status: 'reviewer_failed',
          mutation_catch_rate: mutationResults.catchRate,
        });
        // On the bootstrap path this means: the intent row, embedding,
        // and stub SOP/invariant created by bootstrapNewIntent are still
        // in place and still 'active' — nothing here rolls those back.
        // The intent is matchable next time; it just won't have a
        // reviewed SOP until a future run succeeds.
        return {
          success: false,
          mutation_catch_rate: mutationResults.catchRate,
          error: 'Reviewer gate failed',
          stub_retained: isBootstrap,
        };
      }

      if (mutationResults.catchRate < MUTATION_CATCH_RATE_TARGET) {
        console.log(`[LearningLoop] Mutation catch rate ${mutationResults.catchRate}/10 below target`);
        setSpanAttributes(span, {
          status: 'mutation_rate_below_target',
          mutation_catch_rate: mutationResults.catchRate,
        });
        return {
          success: false,
          mutation_catch_rate: mutationResults.catchRate,
          error: 'Mutation catch rate below target',
          stub_retained: isBootstrap,
        };
      }

      const version = await this.promoteToProduction(newContract, span);

      console.log(`[LearningLoop] ✅ New contract promoted to production v${version}`);
      console.log(`[LearningLoop] Mutation catch rate: ${mutationResults.catchRate}/10`);

      setSpanAttributes(span, {
        status: 'promoted',
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
      console.error('[LearningLoop] Error:', error.message);
      setSpanAttributes(span, { status: 'error', error: error.message });
      // If we bootstrapped successfully before hitting this error, the
      // stub is still standing — say so, since the caller (main.ts) only
      // logs this failure and has no other way to know whether a partial
      // intent now exists in the DB.
      return { success: false, error: error.message, stub_retained: isBootstrap };
    } finally {
      endSpan(span);
    }
  }

  // ─── Bootstrap a brand-new intent (moved from router) ───────────────────
  async bootstrapNewIntent(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any,
  ): Promise<string | null> {
    const span = startChainSpan('bootstrapNewIntent', parentSpan, {
      trace_id: this.traceId,
      query: userQuery.slice(0, 200),
    });

    const client = new Client(DB_CONFIG);

    try {
      await client.connect();

      const intentName  = this.generateIntentName(userQuery);
      const intentId    = `intent_${intentName}_${Date.now()}`;
      const embeddingId = `embedding_${intentName}_${Date.now()}`;
      const description = `Auto-learned intent from user query: "${userQuery.substring(0, 100)}"`;

      console.log(`[LearningLoop] Bootstrapping intent: "${intentName}" (ID: ${intentId})`);

      // Check if intent name already exists
      const existing = await client.query(
        `SELECT id FROM intents WHERE name = $1`,
        [intentName],
      );

      if (existing.rows.length > 0) {
        const existingId = existing.rows[0].id;
        console.log(`[LearningLoop] Intent already exists: ${intentName} (${existingId})`);

        // Refresh embedding so distance improves on re-query
        const embedding = await this.getEmbedding(userQuery, span);
        const vectorLiteral = `[${embedding.join(",")}]`;

        await client.query(
          `UPDATE intent_embeddings
           SET embedding_vector = $1::vector, description = $2
           WHERE intent_id = $3`,
          [vectorLiteral, description, existingId],
        );

        setSpanAttributes(span, { status: 'updated_existing', intent_id: existingId });
        return existingId;
      }

      const embedding = await this.getEmbedding(userQuery, span);
      const vectorLiteral = `[${embedding.join(",")}]`;

      await client.query('BEGIN');

      // Insert intent
      const intentResult = await client.query(
        `INSERT INTO intents (id, name, domain, schema_json, status)
         VALUES ($1, $2, $3, $4::json, 'active')
         RETURNING id`,
        [
          intentId,
          intentName,
          'auto_learned',
          JSON.stringify({ type: 'object', properties: {} }),
        ],
      );

      const newIntentId = intentResult.rows[0].id;

      // Insert embedding
      await client.query(
        `INSERT INTO intent_embeddings (id, intent_id, name, description, embedding_vector)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [embeddingId, newIntentId, intentName, description, vectorLiteral],
      );

      // Insert stub SOP — replaced after first successful teacher execution.
      // "Replaced" here means: if run()'s post-bootstrap distill/mutate/
      // promote sequence succeeds, promoteToProduction() inserts a NEW
      // sops row at version 2 and a NEW invariants row at version 2 (both
      // computed as MAX(version)+1), and this version-1 stub is simply no
      // longer the 'active' one returned by the router's version-ordered
      // query. It is not deleted or updated in place.
      await client.query(
        `INSERT INTO sops (id, intent_id, version, content, status)
         VALUES ($1, $2, 1, $3, 'active')`,
        [randomUUID(), newIntentId, `Execute the task: ${userQuery}`],
      );

      // Insert stub invariant
      await client.query(
        `INSERT INTO invariants (id, intent_id, version, code, status)
         VALUES ($1, $2, 1, $3, 'active')`,
        [
          randomUUID(),
          newIntentId,
          `def verify_logic(payload, state):\n    assert isinstance(payload, dict), "Payload must be a dict"\n    return True`,
        ],
      );

      await client.query('COMMIT');

      console.log(`[LearningLoop] ✅ Bootstrapped intent "${intentName}" (${newIntentId})`);

      setSpanAttributes(span, {
        status: 'created',
        intent_id: newIntentId,
        intent_name: intentName,
      });

      return newIntentId;

    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[LearningLoop] Bootstrap failed: ${error.message}`);
      setSpanAttributes(span, { status: 'error', error: error.message });
      return null;
    } finally {
      await client.end().catch((e) => console.error('[LearningLoop] DB disconnect error:', e.message));
      endSpan(span);
    }
  }

  // ─── Distill new contract from teacher execution ────────────────────────
  async distillNewContract(
    userQuery: string,
    teacherResult: any,
    intentId: string,
    parentSpan?: any
  ): Promise<any> {
    const span = startAgentSpan('distillNewContract', parentSpan, {
      trace_id: this.traceId,
      intent_id: intentId,
    });

    console.log('[LearningLoop] Distilling new contract...');

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
        status: 'distilled',
        sop_length: sopText.length,
        invariant_length: invariantCode.length,
      });

      setTraceOutput(span, {
        distilled: true,
        sop_preview: sopText.substring(0, 200),
        invariant_preview: invariantCode.substring(0, 200),
      });

      return newContract;
    } catch (error: any) {
      setSpanAttributes(span, { status: 'error', error: error.message });
      throw error;
    } finally {
      endSpan(span);
    }
  }

  // ─── Mutation protocol ──────────────────────────────────────────────────
  async runMutationProtocol(
    contract: any,
    parentSpan?: any
  ): Promise<{ catchRate: number; results: any[] }> {
    const span = startGuardrailSpan('mutationProtocol', parentSpan, {
      trace_id: this.traceId,
      target_catch_rate: MUTATION_CATCH_RATE_TARGET,
    });

    console.log('[LearningLoop] Running mutation protocol...');

    try {
      const mutations = this.generateMutations(contract.teacher_result);
      const results: any[] = [];
      let caught = 0;

      for (const mutation of mutations) {
        const result = await this.testMutation(mutation, contract.invariant_code, span);
        results.push(result);
        if (result.caught) caught++;
      }

      console.log(`[LearningLoop] Mutation catch rate: ${caught}/${mutations.length}`);

      setSpanAttributes(span, {
        catch_rate: caught,
        total_mutations: mutations.length,
        caught,
        missed: mutations.length - caught,
      });

      setTraceOutput(span, {
        catch_rate: caught,
        total: mutations.length,
        caught,
        missed: mutations.length - caught,
      });

      return { catchRate: caught, results };
    } catch (error: any) {
      setSpanAttributes(span, { status: 'error', error: error.message });
      throw error;
    } finally {
      endSpan(span);
    }
  }

  // ─── Reviewer gate ──────────────────────────────────────────────────────
  async runReviewerGate(
    contract: any,
    parentSpan?: any
  ): Promise<boolean> {
    const span = startGuardrailSpan('reviewerGate', parentSpan, {
      trace_id: this.traceId,
    });

    console.log('[LearningLoop] Running reviewer gate...');

    try {
      const testCases = this.generateTestCases(contract);

      for (const testCase of testCases) {
        const isValid = await this.validateWithInvariant(testCase, contract.invariant_code, span);
        if (!isValid) {
          console.log(`[LearningLoop] Reviewer gate failed on: ${testCase.name}`);
          setSpanAttributes(span, { passed: false, failed_test_case: testCase.name });
          return false;
        }
      }

      console.log('[LearningLoop] Reviewer gate passed');
      setSpanAttributes(span, { passed: true, test_cases: testCases.length });
      return true;
    } catch (error: any) {
      setSpanAttributes(span, { status: 'error', error: error.message });
      return false;
    } finally {
      endSpan(span);
    }
  }

  // ─── Promote to production ──────────────────────────────────────────────
  async promoteToProduction(
    contract: any,
    parentSpan?: any
  ): Promise<number> {
    const span = startChainSpan('promoteToProduction', parentSpan, {
      trace_id: this.traceId,
      intent_id: contract.intent_id,
    });

    console.log('[LearningLoop] Promoting to production...');

    const client = new Client(DB_CONFIG);

    try {
      await client.connect();
      await client.query('BEGIN');

      const sopVersionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM sops WHERE intent_id = $1`,
        [contract.intent_id],
      );
      const nextSopVersion = sopVersionResult.rows[0].next_version;

      const invVersionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM invariants WHERE intent_id = $1`,
        [contract.intent_id],
      );
      const nextInvVersion = invVersionResult.rows[0].next_version;

      await client.query(
        `INSERT INTO sops (id, intent_id, version, content, status, created_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())`,
        [randomUUID(), contract.intent_id, nextSopVersion, contract.sop_text],
      );

      await client.query(
        `INSERT INTO invariants (id, intent_id, version, code, status, created_at)
         VALUES ($1, $2, $3, $4, 'active', NOW())`,
        [randomUUID(), contract.intent_id, nextInvVersion, contract.invariant_code],
      );

      await client.query('COMMIT');

      console.log(`[LearningLoop] Promoted SOP v${nextSopVersion}, invariant v${nextInvVersion}`);

      setSpanAttributes(span, {
        sop_version: nextSopVersion,
        inv_version: nextInvVersion,
        status: 'promoted',
      });

      setTraceOutput(span, {
        sop_version: nextSopVersion,
        inv_version: nextInvVersion,
        promoted: true,
      });

      return nextSopVersion;
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => {});
      setSpanAttributes(span, { status: 'error', error: error.message });
      throw error;
    } finally {
      await client.end().catch(() => {});
      endSpan(span);
    }
  }

  // ─── LLM caller ─────────────────────────────────────────────────────────
  private async callLLM(
    prompt: string,
    maxTokens: number,
    _parentSpan?: any
  ): Promise<string> {
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEACHER_MODEL,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.2 },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const content = data.message?.content;

    if (!content) {
      throw new Error(`LLM returned empty content: ${JSON.stringify(data)}`);
    }

    return content.trim();
  }

  // ─── Embedding helper ────────────────────────────────────────────────────
  private async getEmbedding(text: string, parentSpan?: any): Promise<number[]> {
    const span = startEmbeddingSpan('learningLoop.getEmbedding', parentSpan, {
      model: 'nomic-embed-text',
      text_length: text.length,
    });

    try {
      const safeText = text.length > 8000 ? text.slice(0, 8000) : text;

      const res = await fetch(OLLAMA_EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: safeText }),
      });

      if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);

      const data = await res.json();
      return data.embeddings[0];
    } finally {
      endSpan(span);
    }
  }

  // ─── Generate improved SOP via LLM ──────────────────────────────────────
  private async generateImprovedSOP(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any
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

    return this.callLLM(prompt, 800, parentSpan);
  }

  // ─── Generate new invariant via LLM ─────────────────────────────────────
  private async generateNewInvariant(
    userQuery: string,
    teacherResult: any,
    parentSpan?: any
  ): Promise<string> {
    const prompt = `You are a system that writes Python validation functions for AI pipeline outputs.

A user submitted this query:
<query>${userQuery}</query>

A senior AI model successfully handled it and produced this output:
<teacher_output>${JSON.stringify(teacherResult, null, 2)}</teacher_output>

Write a Python function with EXACTLY this signature:
def verify_logic(payload, state):

The function must:
1. Assert isinstance(payload, dict) as the first check
2. Assert all required fields from the teacher output are present in payload
3. Assert correct types for each field
4. Assert no field is None where a value is expected
5. Raise AssertionError with a descriptive message on any failure
6. Return True if all checks pass

Return ONLY the raw Python function. No markdown fences, no imports, no explanation.`;

    return this.callLLM(prompt, 600, parentSpan);
  }

  // ─── Intent name generation (moved from router) ──────────────────────────
  private generateIntentName(query: string): string {
    const normalized = query.toLowerCase().trim();

    const invoiceMatch   = normalized.match(/invoice\s*#?(\d+)/i);
    const reconcileMatch = normalized.match(/reconcil/i);
    const paymentMatch   = normalized.match(/pay(ment)?/i);

    if (reconcileMatch && invoiceMatch) return `reconcile_invoice_${invoiceMatch[1]}`;
    if (reconcileMatch) return `reconcile_generic_${Date.now()}`;
    if (paymentMatch)   return `payment_processing_${Date.now()}`;

    const words = normalized.split(/\s+/).slice(0, 3);
    const slug  = words.join('_').replace(/[^a-z0-9_]/g, '_');
    return `${slug}_${Date.now()}`;
  }

  // ─── Mutations ───────────────────────────────────────────────────────────
  private generateMutations(originalPayload: any): any[] {
    return [
      { name: 'missing_required_field',  payload: this.removeRandomField(originalPayload),               should_catch: true },
      { name: 'wrong_type_number',       payload: this.changeType(originalPayload, 'number', 'string'),  should_catch: true },
      { name: 'null_required_field',     payload: this.setNullValue(originalPayload),                    should_catch: true },
      { name: 'empty_string',            payload: this.setEmptyString(originalPayload),                  should_catch: true },
      { name: 'unexpected_field',        payload: this.addUnexpectedField(originalPayload),              should_catch: true },
      { name: 'negative_number',         payload: this.makeNegative(originalPayload),                    should_catch: true },
      { name: 'invalid_date',            payload: this.invalidateDate(originalPayload),                  should_catch: true },
      { name: 'wrong_enum',              payload: this.changeEnum(originalPayload),                      should_catch: true },
      { name: 'array_instead_of_object', payload: [],                                                    should_catch: true },
      { name: 'nested_corruption',       payload: this.corruptNested(originalPayload),                   should_catch: true },
    ];
  }

  private async testMutation(
    mutation: any,
    invariantCode: string,
    parentSpan?: any
  ): Promise<{ name: string; caught: boolean }> {
    try {
      const { layer2Validate } = await import('./gate/layer2');
      const result = await layer2Validate(mutation.payload, invariantCode, {}, parentSpan);
      return { name: mutation.name, caught: !result.passed };
    } catch {
      return { name: mutation.name, caught: false };
    }
  }

  private generateTestCases(contract: any): any[] {
    return [
      { name: 'valid_payload', payload: contract.teacher_result, should_pass: true },
      { name: 'empty_payload', payload: {},                       should_pass: false },
      { name: 'null_payload',  payload: null,                     should_pass: false },
    ];
  }

  private async validateWithInvariant(
    testCase: any,
    invariantCode: string,
    parentSpan?: any
  ): Promise<boolean> {
    const { layer2Validate } = await import('./gate/layer2');
    const result = await layer2Validate(testCase.payload, invariantCode, {}, parentSpan);
    return result.passed === testCase.should_pass;
  }

  // ─── Mutation helpers ────────────────────────────────────────────────────
  private removeRandomField(payload: any): any {
    const result = { ...payload };
    const keys = Object.keys(result);
    if (keys.length > 0) delete result[keys[0]];
    return result;
  }

  private changeType(payload: any, fromType: string, toType: string): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === fromType) {
        result[key] = toType === 'string' ? String(value) : value;
        break;
      }
    }
    return result;
  }

  private setNullValue(payload: any): any {
    const result = { ...payload };
    const keys = Object.keys(result);
    if (keys.length > 0) result[keys[0]] = null;
    return result;
  }

  private setEmptyString(payload: any): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string') { result[key] = ''; break; }
    }
    return result;
  }

  private addUnexpectedField(payload: any): any {
    return { ...payload, unexpected_field: 'should_not_be_here' };
  }

  private makeNegative(payload: any): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number' && value > 0) { result[key] = -value; break; }
    }
    return result;
  }

  private invalidateDate(payload: any): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.includes('-')) { result[key] = 'not-a-valid-date'; break; }
    }
    return result;
  }

  private changeEnum(payload: any): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.length > 1) { result[key] = value.toUpperCase(); break; }
    }
    return result;
  }

  private corruptNested(payload: any): any {
    const result = { ...payload };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = { corrupted: true };
        break;
      }
    }
    return result;
  }
}

export const learningLoop = new AsyncLearningLoop();
