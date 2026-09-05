const OLLAMA_URL = "http://localhost:11434/api/generate";
const STUDENT_MODEL = "llama3.2:3b"; // Small, fast model

export async function callStudentModel(
  prompt: string,
  sopText: string,
  systemPrompt?: string
): Promise<string> {
  const fullPrompt = `${systemPrompt || "You are a task execution agent. Follow the SOP exactly and output valid JSON."}

SOP Instructions:
${sopText}

User Query:
${prompt}

Generate the output as a valid JSON object:`;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: STUDENT_MODEL,
      prompt: fullPrompt,
      stream: false,
      options: {
        temperature: 0.2, // Low temperature for more deterministic output
        num_predict: 2048,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.response;
}

export async function callTeacherModel(
  prompt: string,
  sopText: string
): Promise<string> {
  // For now, use same Ollama but with a bigger model
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.1:8b", // Bigger model for Teacher
      prompt: `${sopText}\n\nUser Query: ${prompt}\n\nExecute this task correctly and output JSON:`,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 4096,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.response;
}
