// src/gate/layer1.ts - Structural Validation Gate
// Validates draft against JSON schema (Pydantic-style)

export function layer1Validate(draft: any, schema: any): { passed: boolean; errors: string[] } {
  if (!schema || Object.keys(schema).length === 0) {
    console.log("[Layer 1] No schema provided - skipping validation");
    return { passed: true, errors: [] };
  }
  
  const errors: string[] = [];
  
  // Extract schema properties
  const properties = schema.properties || schema.fields || {};
  const requiredFields = schema.required || [];
  
  // 1. Check required fields
  for (const field of requiredFields) {
    if (!(field in draft)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // 2. Check field types
  for (const [field, fieldSchema] of Object.entries(properties)) {
    const fs = fieldSchema as any;
    
    if (!(field in draft)) continue; // Already caught by required check
    
    const value = draft[field];
    const expectedType = fs.type || fs.kind;
    
    if (expectedType) {
      switch (expectedType) {
        case 'string':
          if (typeof value !== 'string') {
            errors.push(`Field "${field}" should be string, got ${typeof value}`);
          }
          break;
        case 'number':
        case 'integer':
          if (typeof value !== 'number') {
            errors.push(`Field "${field}" should be number, got ${typeof value}`);
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            errors.push(`Field "${field}" should be boolean, got ${typeof value}`);
          }
          break;
        case 'array':
          if (!Array.isArray(value)) {
            errors.push(`Field "${field}" should be array, got ${typeof value}`);
          }
          break;
        case 'object':
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push(`Field "${field}" should be object, got ${typeof value}`);
          }
          break;
      }
    }
    
    // 3. Check enum values if specified
    if (fs.enum && Array.isArray(fs.enum)) {
      if (!fs.enum.includes(value)) {
        errors.push(`Field "${field}" should be one of: ${fs.enum.join(', ')}`);
      }
    }
  }
  
  // 4. Check nested object properties (if any)
  for (const [field, fieldSchema] of Object.entries(properties)) {
    const fs = fieldSchema as any;
    if (fs.type === 'object' && fs.properties && field in draft) {
      const nestedResult = layer1Validate(draft[field], { properties: fs.properties, required: fs.required || [] });
      errors.push(...nestedResult.errors.map(e => `${field}.${e}`));
    }
  }
  
  const passed = errors.length === 0;
  
  console.log(`[Layer 1] ${passed ? ' PASSED' : ' FAILED'}`);
  if (!passed) {
    console.log(`[Layer 1] Errors:`);
    errors.forEach(err => console.log(`  - ${err}`));
  }
  
  return { passed, errors };
}
