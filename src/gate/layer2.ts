// src/gate/layer2.ts - Semantic Invariant Gate
// Executes Python invariant code in a restricted subprocess

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Clean invariant code (remove markdown, extract function)
function cleanInvariantCode(code: string): string {
  let cleaned = code;
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```python\s*/g, '');
  cleaned = cleaned.replace(/```\s*/g, '');
  
  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

// Extract just the verify_logic function if full code is provided
function extractVerifyLogic(code: string): string {
  // If it already has verify_logic, return as-is
  if (code.includes('def verify_logic')) {
    return code;
  }
  
  // If it's just assert statements, wrap them
  return `def verify_logic(payload, state):\n${code.split('\n').map(l => '    ' + l).join('\n')}`;
}

export async function layer2Validate(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<{ passed: boolean; output: string }> {
  if (!invariantCode || invariantCode.trim() === '') {
    console.log("[Layer 2] No invariant code - skipping");
    return { passed: true, output: "skipped" };
  }
  
  // Clean and prepare the code
  const cleanCode = cleanInvariantCode(invariantCode);
  const finalCode = extractVerifyLogic(cleanCode);
  
  console.log("[Layer 2] Invariant code preview:");
  console.log(finalCode.substring(0, 200) + "...");
  
  // Prepare payload and state as JSON strings
  const payloadJson = JSON.stringify(draft);
  const stateJson = JSON.stringify(state);
  
  // Build the Python script
  const script = `import json

${finalCode}

# Auto-invoke verify_logic
try:
    verify_logic(json.loads('${payloadJson.replace(/'/g, "\\'")}'), json.loads('${stateJson.replace(/'/g, "\\'")}'))
    print("PASS")
except AssertionError as e:
    print(f"FAIL: {e}")
except Exception as e:
    print(f"ERROR: {e}")
`;
  
  // Write script to temp file for easier debugging
  const fs = require('fs');
  const tmpFile = '/tmp/cascade_invariant_test.py';
  fs.writeFileSync(tmpFile, script);
  
  try {
    const { stdout, stderr } = await execAsync(`python3 ${tmpFile}`, { 
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    
    const output = stdout.trim();
    const passed = output.includes("PASS") && !output.includes("FAIL") && !output.includes("ERROR");
    
    console.log(`[Layer 2] ${passed ? ' PASSED' : ' FAILED'}`);
    if (!passed) {
      console.log(`[Layer 2] Output: ${output}`);
      if (stderr) console.log(`[Layer 2] Stderr: ${stderr}`);
    }
    
    return { passed, output };
  } catch (error: any) {
    const output = error.stdout || error.message;
    console.log(`[Layer 2]  FAILED (execution error)`);
    console.log(`[Layer 2] Output: ${output}`);
    
    return { passed: false, output };
  }
}

// Alternative: Use a sandboxed Python execution with resource limits
export async function layer2ValidateSandboxed(
  draft: any,
  invariantCode: string,
  state: any = {}
): Promise<{ passed: boolean; output: string }> {
  const cleanCode = cleanInvariantCode(invariantCode);
  const finalCode = extractVerifyLogic(cleanCode);
  
  const payloadJson = JSON.stringify(draft);
  const stateJson = JSON.stringify(state);
  
  const script = `import json

${finalCode}

try:
    verify_logic(json.loads('${payloadJson.replace(/'/g, "\\'")}'), json.loads('${stateJson.replace(/'/g, "\\'")}'))
    print("PASS")
except AssertionError as e:
    print(f"FAIL: {e}")
except Exception as e:
    print(f"ERROR: {e}")
`;
  
  // Use resource limits for security
  const sandboxCmd = `python3 -c "
import resource
import os
import sys

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (1, 1))  # 1 second CPU
resource.setrlimit(resource.RLIMIT_AS, (100 * 1024 * 1024, 100 * 1024 * 1024))  # 100MB memory

exec(open('${tmpFile}').read())
"`;
  
  // Write script to temp file
  const fs = require('fs');
  const tmpFile = '/tmp/cascade_invariant_sandboxed.py';
  fs.writeFileSync(tmpFile, script);
  
  try {
    const { stdout } = await execAsync(sandboxCmd, { timeout: 3000 });
    const output = stdout.trim();
    const passed = output.includes("PASS");
    
    console.log(`[Layer 2 Sandboxed] ${passed ? ' PASSED' : ' FAILED'}`);
    return { passed, output };
  } catch (error: any) {
    return { passed: false, output: error.stdout || error.message };
  }
}
