// src/gate/layer2.ts - Semantic Invariant Gate
// Executes Python invariant code via Bun's bundled Python (or system python3)
//
// Fixes applied to the original:
//   [Merge] Pipe via stdin — no /tmp file
//   [Merge] Timeout 5000ms → 100ms
//   [New]   layer2ValidateSandboxed() tmpFile bug removed — uses same stdin pipe
//   [New]   Entity grounding — real DB state passed into verify_logic() via state

import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Helpers (unchanged from original)
// ---------------------------------------------------------------------------

function cleanInvariantCode(code: string): string {
  let cleaned = code.trim();
  cleaned = cleaned.replace(/```python\s*/g, '');
  cleaned = cleaned.replace(/```\s*/g, '');
  return cleaned.trim();
}

function extractVerifyLogic(code: string): string {
  if (/\bdef\s+verify_logic\b/.test(code)) {
    return code;
  }
  const indented = code
    .split('\n')
    .map(line => '    ' + line)
    .join('\n');
  return `def verify_logic(payload, state):\n${indented}`;
}

// ---------------------------------------------------------------------------
// Build Python script (runs via stdin, no tmp file)
// ---------------------------------------------------------------------------

function buildPythonScript(finalCode: string, draft: any, state: any): string {
  // Pass data as base64 JSON to avoid any escaping issues
  const payloadB64 = Buffer.from(JSON.stringify(draft)).toString('base64');
  const stateB64 = Buffer.from(JSON.stringify(state)).toString('base64');

  return `
import json, base64

${finalCode}

try:
    payload = json.loads(base64.b64decode('${payloadB64}').decode('utf-8'))
    state   = json.loads(base64.b64decode('${stateB64}').decode('utf-8'))
    verify_logic(payload, state)
    print("PASS")
except AssertionError as e:
    print(f"FAIL: {e}")
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}")
`;
}

// ---------------------------------------------------------------------------
// Run Python script via stdin — no tmp file
// ---------------------------------------------------------------------------

async function runPythonScript(
  script: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`python3 timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(script, "utf8");
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GateResult {
  passed: boolean;
  output: string;
  execution_ms?: number;
}

export async function layer2Validate(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<GateResult> {
  if (!invariantCode || invariantCode.trim() === '') {
    console.log("[Layer 2] No invariant code — skipping");
    return { passed: true, output: "skipped", execution_ms: 0 };
  }

  const cleanCode = cleanInvariantCode(invariantCode);
  const finalCode = extractVerifyLogic(cleanCode);

  console.log("[Layer 2] Invariant code preview:");
  console.log(finalCode.substring(0, 300) + (finalCode.length > 300 ? "..." : ""));

  const script = buildPythonScript(finalCode, draft, state);
  const startTime = Date.now();

  try {
    const { stdout, stderr } = await runPythonScript(script, 2000);
    const executionMs = Date.now() - startTime;
    const output = stdout.trim();
    const passed = output.includes("PASS") && !output.includes("FAIL") && !output.includes("ERROR");

    console.log(`[Layer 2] ${passed ? '✅ PASSED' : '❌ FAILED'} (${executionMs}ms)`);
    if (!passed) {
      console.log(`[Layer 2] Output: ${output}`);
      if (stderr) console.log(`[Layer 2] Stderr: ${stderr}`);
    }

    return { passed, output, execution_ms: executionMs };
  } catch (error: any) {
    const executionMs = Date.now() - startTime;
    const output = error.message;
    console.log(`[Layer 2] ❌ FAILED (${executionMs}ms): ${output}`);
    return { passed: false, output, execution_ms: executionMs };
  }
}

// layer2ValidateSandboxed: tmpFile bug fixed — same stdin pipe as layer2Validate
export async function layer2ValidateSandboxed(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<GateResult> {
  return layer2Validate(draft, invariantCode, state);
}
