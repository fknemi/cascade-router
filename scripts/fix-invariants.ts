// scripts/fix-invariants.ts
// Regenerates invariant code for intents with empty invariants
import { Client } from "pg";
import { randomUUID } from "crypto";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const GENERATOR_MODEL = "qwen2.5-coder:7b";

const DB_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "cascade",
  password: "cascade_dev_password",
  database: "cascade",
};

async function generateInvariant(
  intentName: string,
  schema: any,
): Promise<string> {
  const prompt = `Write a Python verify_logic(payload, state) function for task "${intentName}".
  
Schema fields: ${JSON.stringify(Object.keys(schema.properties || {}))}
Required fields: ${JSON.stringify(schema.required || [])}

Rules:
- Only check fields that exist in the schema
- Use payload.get() for optional fields
- Keep it under 10 lines
- Output ONLY the function code, no markdown, no explanations

Example format:
def verify_logic(payload, state):
    assert 'field1' in payload, "field1 is required"
    assert isinstance(payload['field1'], str), "field1 must be string"
    return True`;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GENERATOR_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 512 },
    }),
  });

  const data = await response.json();
  return data.response.trim();
}

async function main() {
  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    // Get all intents with their schemas and check for empty invariants
    const result = await client.query(`
      SELECT i.id, i.name, i.schema_json, inv.code, inv.id AS invariant_id
      FROM intents i
      LEFT JOIN invariants inv ON inv.intent_id = i.id AND inv.status = 'active'
      ORDER BY i.name
    `);

    console.log(`Found ${result.rows.length} intents\n`);

    for (const row of result.rows) {
      const hasCode = row.code && row.code.trim().length > 0;

      if (hasCode) {
        console.log(` ${row.name}: has invariant (${row.code.length} chars)`);
        continue;
      }

      console.log(` ${row.name}: generating invariant...`);

      try {
        const invariantCode = await generateInvariant(
          row.name,
          row.schema_json,
        );

        // Clean the code - remove markdown
        const cleanCode = invariantCode
          .replace(/```python\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();

        if (row.invariant_id) {
          // Update existing empty invariant
          await client.query(`UPDATE invariants SET code = $1 WHERE id = $2`, [
            cleanCode,
            row.invariant_id,
          ]);
          console.log(`  Updated invariant for ${row.name}`);
        } else {
          // Insert new invariant
          await client.query(
            `INSERT INTO invariants (id, intent_id, version, code)
             VALUES ($1, $2, 1, $3)`,
            [randomUUID(), row.id, cleanCode],
          );
          console.log(`  Created invariant for ${row.name}`);
        }

        console.log(`  Code: ${cleanCode.substring(0, 100)}...`);
      } catch (error: any) {
        console.log(`   Failed: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch(console.error);
