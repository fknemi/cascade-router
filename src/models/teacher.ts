// src/models/teacher.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { config as dotenvConfig } from "dotenv";

// Load .env file
dotenvConfig();

// Also load opencode config for API key
function loadConfig(): any {
  const locations = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(process.cwd(), "opencode.jsonc"),
    join(process.cwd(), "opencode.json"),
  ];

  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const raw = readFileSync(loc, "utf-8");
        const cleanRaw = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        return JSON.parse(cleanRaw);
      }
    } catch (e) {}
  }
  return null;
}

const config = loadConfig();
const deepseekProvider = config?.provider?.deepseek;

const DEEPSEEK_URL = "https://api.deepseek.com";
// Get key from env first, then from opencode config
const DEEPSEEK_API_KEY =
  process.env.DEEPSEEK_API_KEY || deepseekProvider?.options?.apiKey || "";
const TEACHER_MODEL = "deepseek-v4-pro";
export async function callTeacherModel(
  prompt: string,
  sopText: string,
  schema?: any
): Promise<string> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek API key not set in .env or opencode config');
  }

  const schemaInstruction = schema ? `\n\nREQUIRED SCHEMA:\n${JSON.stringify(schema, null, 2)}` : '';

  const systemPrompt = `You are a highly capable execution agent. Follow the SOP and schema exactly. Output ONLY valid JSON matching the required schema, no markdown, no explanations.

CURRENT SYSTEM CONTEXT:
- Current Date/Time: ${new Date().toISOString()}
- Local Timezone: Asia/Kolkata (Indore)

SOP INSTRUCTIONS:
${sopText}
${schemaInstruction}`;

  const response = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: TEACHER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek teacher failed: ${response.status} - ${body}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}
