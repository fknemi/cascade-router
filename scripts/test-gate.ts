// scripts/test-gate.ts
import { routeIntent } from "../src/core/router";
import { generateDraft } from "../src/core/student";
import { callTeacherModel } from "../src/models/teacher";
import { layer1Validate } from "../src/gate/layer1";
import { layer2Validate } from "../src/gate/layer2";

function extractJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const looseMatch = text.match(/\{[\s\S]*\}/);
    if (looseMatch) return JSON.parse(looseMatch[0]);
    throw new Error("Model did not output valid JSON");
  }
}

async function main() {
  // Include actual invoice data in the query
  const query = `Match this invoice to our purchase orders:
Invoice Number: INV-2024-001
PO Number: PO-2024-888
Amount: $1000
Date: 2024-01-15`;
  console.log("=== Cascade v3 - Full Pipeline Test ===\n");
  
  // Step 1: Route
  const bundle = await routeIntent(query);
  console.log(`Intent: ${bundle.routing_metadata.intent_name}\n`);
  
  // Step 2: Student attempts
  console.log("=== STUDENT ATTEMPT ===");
  const studentResult = await generateDraft(query, bundle);
  console.log("Student draft:", JSON.stringify(studentResult.draft, null, 2));
  
  // Step 3: Gates
  const layer1 = layer1Validate(studentResult.draft, bundle.verification_assets.layer1_schema);
  const layer2 = await layer2Validate(studentResult.draft, bundle.verification_assets.layer2_invariant_code, studentResult.sandbox_state);
  
  if (layer1.passed && layer2.passed) {
    console.log("\n FAST PATH: Student passed!");
  } else {
    console.log("\n STUDENT FAILED → TEACHER FALLBACK\n");
    
    // Step 4: Teacher with BETTER prompt
    console.log("=== TEACHER EXECUTION ===");
    const teacherPrompt = `You are given an invoice to extract data from.

SOP Instructions:
${bundle.execution_assets.sop_text}

Required output schema:
${JSON.stringify(bundle.verification_assets.layer1_schema, null, 2)}

The invoice data:
${query}

Extract the data according to the schema. Output ONLY valid JSON.`;
    
const teacherRawOutput = await callTeacherModel(
  teacherPrompt,
  bundle.execution_assets.sop_text,
  bundle.verification_assets.layer1_schema // Pass schema here
);
    console.log("Teacher raw output:", teacherRawOutput);
    
    const teacherDraft = extractJSON(teacherRawOutput);
    console.log("Teacher draft:", JSON.stringify(teacherDraft, null, 2));
    
    // Step 5: Validate Teacher
    const teacherLayer1 = layer1Validate(teacherDraft, bundle.verification_assets.layer1_schema);
    const teacherLayer2 = await layer2Validate(teacherDraft, bundle.verification_assets.layer2_invariant_code, {});
    
    console.log("\n=== TEACHER GATE RESULT ===");
    if (teacherLayer1.passed && teacherLayer2.passed) {
      console.log(" TEACHER PASSED - Commit");
    } else {
      console.log(" TEACHER ALSO FAILED");
    }
  }
}

main().catch(console.error);
