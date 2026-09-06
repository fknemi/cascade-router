import { routeIntent } from "../src/core/router";

async function main() {
  const testQueries = [
    "Reconcile this bank statement and draft a journal entry",
    "Route this customer support ticket to the right department",
    "Extract data from this invoice and match it to a PO",
  ];
  
  for (const query of testQueries) {
    console.log(`\n=== Testing: "${query}" ===`);
    try {
      const bundle = await routeIntent(query);
      console.log(` Matched: ${bundle.routing_metadata.intent_name}`);
      console.log(`   Domain: ${bundle.routing_metadata.domain}`);
      console.log(`   SOP v${bundle.execution_assets.sop_version}`);
      console.log(`   Has schema: ${!!bundle.verification_assets.layer1_schema}`);
      console.log(`   Has invariant: ${!!bundle.verification_assets.layer2_invariant_code}`);
    } catch (error: any) {
      console.log(` Failed: ${error.message}`);
    }
  }
}

main();
