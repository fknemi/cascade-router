// scripts/embed_one_example.js
//
// Fixed, single-example test: embeds ONE hardcoded description using a
// locally running Ollama instance (model: nomic-embed-text, 768 dims),
// then inserts the result into intent_embeddings.
//
// Prerequisites:
//   1. Ollama running locally with the model pulled:
//        ollama pull nomic-embed-text
//        ollama serve            (usually already running as a service)
//   2. Postgres container up (cascade_pgvector) with the schema applied.
//   3. `bun add pg` in this project.
//
// IMPORTANT: This inserts into embedding_vector (vector(768)).
// The embedding column (Json) in Prisma contract is separate.
//
// Run:
//   bun embed.js

import { Client } from "pg";
import { randomUUID } from "crypto";

const OLLAMA_URL = "http://localhost:11434/api/embed";
const OLLAMA_MODEL = "nomic-embed-text";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

// ---------------------------------------------------------------------
// The one fixed example for this test run.
// ---------------------------------------------------------------------
const FIXED_EXAMPLE = {
  intentName: "reconcile_and_draft_je",
  description:
    "Reconcile bank statements, match general ledger balances, flag transaction exceptions, and draft journal entries to balance debits and credits.",
};

async function getEmbedding(text) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Ollama request failed (${res.status}): ${body}\n` +
        `Is Ollama running? Try: curl http://localhost:11434/api/tags`
    );
  }

  const data = await res.json();

  const vector = data.embeddings?.[0];
  if (!Array.isArray(vector)) {
    throw new Error(
      `Unexpected response shape from Ollama: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return vector;
}

async function main() {
  console.log(`Embedding fixed example for intent: ${FIXED_EXAMPLE.intentName}`);
  console.log(`Text: "${FIXED_EXAMPLE.description}"\n`);

  console.log(`Calling Ollama (${OLLAMA_MODEL})...`);
  const vector = await getEmbedding(FIXED_EXAMPLE.description);
  console.log(`Got vector with ${vector.length} dimensions.\n`);

  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // Look up the intent's UUID by name — we need intent_id for the FK.
    let intentRes = await client.query(
      "SELECT id FROM intents WHERE name = $1",
      [FIXED_EXAMPLE.intentName]
    );

    let intentId;
    if (intentRes.rows.length === 0) {
      console.log(
        `No existing intent named '${FIXED_EXAMPLE.intentName}' — creating one.`
      );
      const createRes = await client.query(
        `INSERT INTO intents (id, name, domain, schema_json)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [randomUUID(), FIXED_EXAMPLE.intentName, "month_end_close", "{}"]
      );
      intentId = createRes.rows[0].id;
      console.log(`Created intent with id: ${intentId}`);
    } else {
      intentId = intentRes.rows[0].id;
      console.log(`Found existing intent with id: ${intentId}`);
    }

    // pgvector accepts a vector literal as a string like '[0.1,0.2,...]'
    const vectorLiteral = `[${vector.join(",")}]`;

    // Insert into embedding_vector (the native vector column)
    // Leave embedding (Json) as null since we're using the native column
    const insertRes = await client.query(
      `INSERT INTO intent_embeddings (id, intent_id, name, description, embedding_vector)
       VALUES ($1, $2, $3, $4, $5::vector)
       RETURNING id`,
      [randomUUID(), intentId, FIXED_EXAMPLE.intentName, FIXED_EXAMPLE.description, vectorLiteral]
    );

    console.log(
      `Inserted row into intent_embeddings with id: ${insertRes.rows[0].id}`
    );
    console.log(`Vector dimensions: ${vector.length}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
