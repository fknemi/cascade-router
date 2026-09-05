// ao-router-server.js
const express = require('express');
const axios = require('axios');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY = "local-router-key"

// Model mapping based on complexity
const MODEL_MAP = {
  'complex': 'anthropic/claude-sonnet-4',
  'medium': 'google/gemini-2.0-flash-exp',
  'simple': 'meta-llama/llama-3.3-70b-instruct',
};

// AO session query
function getAOSessionContext(sessionId) {
  try {
    if (!sessionId) return null;
    const output = execSync(`ao session get ${sessionId}`, { 
      encoding: 'utf8',
      timeout: 5000 
    });
    return JSON.parse(output);
  } catch (e) {
    console.warn('AO session lookup failed:', e.message);
    return null;
  }
}

// Complexity heuristic
function determineComplexity(req, aoContext) {
  // Safely get messages
  const messages = req.messages || req.body?.messages || [];
  const text = JSON.stringify(messages).toLowerCase();
  
  const sessionTitle = aoContext?.title?.toLowerCase() || '';
  const fileCount = aoContext?.files?.length || 0;
  
  // Check explicit model override first
  if (req.model === 'sonnet') return 'complex';
  if (req.model === 'small-model') return 'simple';
  
  // AO-aware heuristics
  if (
    sessionTitle.includes('refactor') ||
    sessionTitle.includes('architecture') ||
    fileCount > 5 ||
    text.includes('documentation') ||
    text.includes('explain') ||
    text.includes('design') ||
    messages.length > 10
  ) {
    return 'complex';
  }
  
  if (
    fileCount > 2 ||
    text.includes('test') ||
    text.includes('debug') ||
    messages.length > 4
  ) {
    return 'medium';
  }
  
  return 'simple';
}

// Main endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('Received request:', {
      model: req.body?.model,
      hasMessages: !!req.body?.messages,
      messageCount: req.body?.messages?.length,
      headers: req.headers
    });
    
    // Handle both cases: body might be at req.body or spread across req
    const requestData = req.body || {};
    
    // Extract AO session info
    const aoSessionId = req.headers['x-ao-session-id'] || requestData.ao_session_id;
    const aoContext = getAOSessionContext(aoSessionId);
    
    // Determine complexity and target model
    const complexity = determineComplexity(requestData, aoContext);
    const targetModel = MODEL_MAP[complexity];
    
    console.log(`[AO Router] Session: ${aoSessionId || 'none'}, Complexity: ${complexity}, Model: ${targetModel}`);
    
    // Forward to OpenRouter with the selected model
    const openRouterReq = {
      ...requestData,
      model: targetModel,
      ao_session_id: undefined
    };
    
    // Remove undefined fields
    Object.keys(openRouterReq).forEach(key => 
      openRouterReq[key] === undefined && delete openRouterReq[key]
    );
    
    const response = await axios.post(OPENROUTER_URL, openRouterReq, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'AO Router'
      }
    });
    
    // Add routing metadata
    response.data.routing = {
      ao_session: aoSessionId,
      complexity,
      actual_model: targetModel,
      timestamp: new Date().toISOString()
    };
    
    res.json(response.data);
    
  } catch (error) {
    console.error('Router error:', {
      message: error.message,
      response: error.response?.data,
      requestBody: req.body
    });
    
    res.status(500).json({
      error: {
        message: error.message,
        type: 'ao_router_error',
        details: error.response?.data || null
      }
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    backends: ['openrouter'],
    models: Object.keys(MODEL_MAP)
  });
});

// List models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'auto', object: 'model', owned_by: 'ao-router' },
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AO Router running on http://localhost:${PORT}`);
  console.log('Backend: OpenRouter');
  console.log('Models: auto, sonnet, small-model');
});
