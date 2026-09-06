// src/core/student.ts
import { callStudentModel } from "../models/ollama";
import type {
  IntentProfileBundle,
  StudentDraftPayload,
  DraftResult,
} from "../types/pipeline";

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

export async function generateDraft(
  userQuery: string,
  bundle: IntentProfileBundle,
): Promise<DraftResult> {
  const { trace_id, intent_id } = bundle.routing_metadata;
  const sopText = bundle.execution_assets.sop_text;
  const schema = bundle.verification_assets.layer1_schema;

  console.log(
    `[Student] Generating draft for intent: ${bundle.routing_metadata.intent_name}`,
  );

  let worktreeId = `local-${trace_id}`;
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
    }
  } catch (e) {}

  try {
    const schemaPrompt = schema
      ? `\n\nRequired output schema (follow this EXACTLY):\n${JSON.stringify(schema, null, 2)}`
      : "";

    // Inject REAL time so it overrides any database examples
    const systemPrompt = `You are a precise task execution agent. 
Output ONLY a valid JSON object matching the schema. No markdown, no arrays, no extra fields, no explanations.
If the schema asks for a date or timestamp, use the CURRENT SYSTEM CONTEXT below, NOT the examples in the schema.

CURRENT SYSTEM CONTEXT:
- Current Date/Time: ${new Date().toISOString()}
- Local Timezone: Asia/Kolkata (Indore, Madhya Pradesh, India)`;

    const rawOutput = await callStudentModel(
      userQuery,
      `${sopText}${schemaPrompt}`,
      systemPrompt,
    );

    // DONT truncate this string! We need to see it to fix the JSON error.
    console.log(
      `\n=== STUDENT RAW OUTPUT ===\n${rawOutput}\n==========================\n`,
    );

    const draft: StudentDraftPayload = extractJSON(rawOutput);

    if (!draft) {
      console.log(
        `[Cascade] Student produced invalid JSON (extractJSON returned null)`,
      );
    }

    return {
      draft,
      sandbox_state: {
        worktree_id: worktreeId,
        changes: [],
        database_queries: [],
      },
      worktree_id: worktreeId,
      trace_id,
    };
  } catch (error) {
    try {
      await fetch("http://localhost:3000/cascade/worktree/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktree_id: worktreeId, trace_id }),
      });
    } catch (e) {}
    throw error;
  }
}
