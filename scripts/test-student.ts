import { routeIntent } from "../src/core/router";
import { generateDraft } from "../src/core/student";

async function main() {
  const query = "Reconcile this invoice for $4,120 and draft a journal entry";
  
  console.log("=== Testing Student Draft ===\n");
  
  // Step 1: Route
  const bundle = await routeIntent(query);
  console.log(`Intent: ${bundle.routing_metadata.intent_name}\n`);
  
  // Step 2: Draft
  const result = await generateDraft(query, bundle);
  console.log("Draft result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
