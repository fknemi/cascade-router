// scripts/generate-intents.ts
// Generates intent data using Ollama (fast local model)
// Creates: intents, sops, invariants, and embeddings

import { Client } from "pg";
import { randomUUID } from "crypto";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
const GENERATOR_MODEL = "qwen2.5-coder:7b-instruct";  // Fast model for text generation
const EMBED_MODEL = "nomic-embed-text";       // For embeddings

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

// Domains and intents to generate
const DOMAINS = [
  {
    domain: "month_end_close",
    intents: [
      "reconcile_and_draft_je",
      "flag_transaction_exceptions",
      "match_gl_balances",
      "draft_accrual_entries",
    ],
  },
  {
    domain: "support_triage",
    intents: [
      "ticket_triage",
      "draft_support_response",
      "route_to_department",
      "calculate_priority_score",
    ],
  },
  {
    domain: "invoice_processing",
    intents: [
      "extract_invoice_data",
      "match_po_to_invoice",
      "flag_duplicate_invoices",
      "schedule_payment",
    ],
  },
];

async function generateText(prompt: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GENERATOR_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 1024 },
    }),
  });

  const data = await response.json();
  return data.response.trim();
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text,
    }),
  });

  const data = await response.json();
  return data.embeddings[0];
}

async function generateIntentData(domain: string, intentName: string) {
  console.log(`\n[Generate] ${domain}/${intentName}`);
  
  // 1. Generate description
  const description = await generateText(
    `Write a clear 2-3 sentence description of what the task "${intentName}" does in the "${domain}" domain. Be specific about inputs, actions, and outputs.`
  );
  console.log(`  Description: ${description.substring(0, 80)}...`);
  
  // 2. Generate SOP
  const sop = await generateText(
    `Write a step-by-step Standard Operating Procedure (SOP) for "${intentName}" in "${domain}". 
     Format as numbered steps. Include validation checks where relevant.
     Description: ${description}`
  );
  console.log(`  SOP: ${sop.substring(0, 80)}...`);
  
  // 3. Generate JSON schema for output
  const schema = await generateText(
    `For task "${intentName}", write a JSON schema (Pydantic-style) for the expected output.
     Include required fields, types, and any enums. Output ONLY valid JSON.`
  );
  
  // Try to extract JSON from schema response
  let schemaJson: any = {};
  try {
    const jsonMatch = schema.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      schemaJson = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.log(`  Schema: using default`);
    schemaJson = { type: "object", properties: {} };
  }
  
  // 4. Generate invariant code
  const invariantCode = await generateText(
    `For task "${intentName}", write Python assert statements that validate the output.
     Include mathematical conservation, data type checks, and business logic.
     Format as a verify_logic(payload, state) function. Output ONLY code, no markdown.`
  );
  console.log(`  Invariant: ${invariantCode.substring(0, 80)}...`);
  
  // 5. Generate embedding
  const embedding = await generateEmbedding(description);
  console.log(`  Embedding: ${embedding.length} dims`);
  
  return {
    description,
    sop,
    schemaJson,
    invariantCode,
    embedding,
  };
}

async function insertIntoDB(data: any) {
  const client = new Client(DB_CONFIG);
  await client.connect();
  
  try {
    const { domain, intentName, description, sop, schemaJson, invariantCode, embedding } = data;
    
    // Insert intent
    const intentId = randomUUID();
    await client.query(
      `INSERT INTO intents (id, name, domain, schema_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [intentId, intentName, domain, JSON.stringify(schemaJson)]
    );
    
    // Insert SOP
    await client.query(
      `INSERT INTO sops (id, intent_id, version, content)
       VALUES ($1, $2, 1, $3)`,
      [randomUUID(), intentId, sop]
    );
    
    // Insert invariant
    await client.query(
      `INSERT INTO invariants (id, intent_id, version, code)
       VALUES ($1, $2, 1, $3)`,
      [randomUUID(), intentId, invariantCode]
    );
    
    // Insert embedding
    const vectorLiteral = `[${embedding.join(",")}]`;
    await client.query(
      `INSERT INTO intent_embeddings (id, intent_id, name, description, embedding_vector)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      [randomUUID(), intentId, intentName, description, vectorLiteral]
    );
    
    console.log(`  ✅ Inserted ${intentName}`);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log("=== Cascade v3 - Intent Generator ===\n");
  console.log(`Using models:`);
  console.log(`  Generator: ${GENERATOR_MODEL}`);
  console.log(`  Embedding: ${EMBED_MODEL}\n`);
  
  const totalIntents = DOMAINS.reduce((sum, d) => sum + d.intents.length, 0);
  console.log(`Will generate ${totalIntents} intents across ${DOMAINS.length} domains\n`);
  
  let completed = 0;
  
  for (const domainConfig of DOMAINS) {
    for (const intentName of domainConfig.intents) {
      try {
        const data = await generateIntentData(domainConfig.domain, intentName);
        await insertIntoDB({
          domain: domainConfig.domain,
          intentName,
          ...data,
        });
        completed++;
        console.log(`\nProgress: ${completed}/${totalIntents}\n`);
      } catch (error: any) {
        console.error(`  ❌ Failed ${intentName}: ${error.message}`);
      }
    }
  }
  
  console.log(`\n✅ Generated ${completed}/${totalIntents} intents`);
}

main().catch(console.error);
