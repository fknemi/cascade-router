import { callStudentModel } from "../models/ollama";
import type { IntentProfileBundle, StudentDraftPayload, DraftResult } from "../types/pipeline";
import { AOSandbox } from "../sandbox/aoSandbox";

function extractJSON(text: string): any {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    
    // Try to find any JSON object
    const looseMatch = text.match(/\{[\s\S]*\}/);
    if (looseMatch) {
      return JSON.parse(looseMatch[0]);
    }
    
    throw new Error("Student model did not output valid JSON");
  }
}

export async function generateDraft(
  userQuery: string,
  bundle: IntentProfileBundle
): Promise<DraftResult> {
  const { trace_id, intent_id } = bundle.routing_metadata;
  const sopText = bundle.execution_assets.sop_text;

  console.log(`[Student] Generating draft for intent: ${bundle.routing_metadata.intent_name}`);
  console.log(`[Student] Trace ID: ${trace_id}`);

  // Create AO sandbox for this draft attempt
  const sandbox = new AOSandbox();
  await sandbox.create(intent_id, trace_id);

  try {
    // Call Student model
    const rawOutput = await callStudentModel(
      userQuery,
      sopText,
      "You are a task execution agent. Follow the SOP exactly. Output ONLY valid JSON, no explanations."
    );

    // Parse the draft
    const draft: StudentDraftPayload = extractJSON(rawOutput);

    return {
      draft,
      sandbox_state: {
        worktree_id: sandbox.getWorktreeId(),
        changes: [],
        database_queries: [],
      },
      worktree_id: sandbox.getWorktreeId(),
      trace_id,
    };
  } catch (error) {
    // Rollback sandbox on error
    await sandbox.rollback();
    throw error;
  }
}
