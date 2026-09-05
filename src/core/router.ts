import { Client } from "pg";
import { randomUUID } from "crypto";
import type { IntentProfileBundle } from "../types/pipeline";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";
const SIMILARITY_THRESHOLD = 0.35;

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(OLLAMA_EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      input: text,
    }),
  });

  const data = await res.json();
  return data.embeddings[0];
}

export async function routeIntent(userQuery: string): Promise<IntentProfileBundle> {
  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // Step 1: Generate embedding for user query
    const queryEmbedding = await getEmbedding(userQuery);
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    // Step 2: Find matching intent
    const matchResult = await client.query(
      `SELECT ie.intent_id, ie.name, ie.description,
              (ie.embedding_vector <=> $1::vector) AS distance
       FROM intent_embeddings ie
       ORDER BY distance ASC
       LIMIT 1`,
      [vectorLiteral]
    );

    if (matchResult.rows.length === 0) {
      throw new Error("No matching intent found");
    }

    const match = matchResult.rows[0];
    if (match.distance > SIMILARITY_THRESHOLD) {
      throw new Error(`No intent within threshold. Closest distance: ${match.distance}`);
    }

    // Step 3: Fetch complete bundle in single query
    const bundleResult = await client.query(
      `SELECT 
         i.id AS intent_id,
         i.name AS intent_name,
         i.domain,
         i.schema_json AS layer1_schema,
         s.version AS sop_version,
         s.content AS sop_text,
         inv.version AS invariant_version,
         inv.code AS layer2_invariant_code
       FROM intents i
       JOIN sops s ON s.intent_id = i.id AND s.status = 'active'
       JOIN invariants inv ON inv.intent_id = i.id AND inv.status = 'active'
       WHERE i.id = $1
       ORDER BY s.version DESC, inv.version DESC
       LIMIT 1`,
      [match.intent_id]
    );

    if (bundleResult.rows.length === 0) {
      throw new Error("No active SOP or invariants found for intent");
    }

    const row = bundleResult.rows[0];

    return {
      routing_metadata: {
        intent_id: row.intent_id,
        intent_name: row.intent_name,
        domain: row.domain,
        model_target: "llama3.2:3b",
        trace_id: randomUUID(),
      },
      execution_assets: {
        sop_version: row.sop_version,
        sop_text: row.sop_text,
      },
      verification_assets: {
        layer1_schema: row.layer1_schema,
        layer2_invariant_code: row.layer2_invariant_code,
      },
    };
  } finally {
    await client.end();
  }
}
