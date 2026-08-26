// Parser inteligente y auto-reparador de JSON para respuestas de LLMs
function parseCardsFromAIResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // 1. Intento de parseo directo
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.cards && Array.isArray(parsed.cards) && parsed.cards.length > 0) return parsed;
    if (Array.isArray(parsed) && parsed.length > 0) return { cards: parsed };
  } catch (e) {}

  // 2. Auto-reparación si el JSON fue cortado antes del cierre
  try {
    const lastObjIdx = cleaned.lastIndexOf('}');
    if (lastObjIdx !== -1) {
      const repaired = cleaned.slice(0, lastObjIdx + 1) + ']}';
      const parsed = JSON.parse(repaired);
      if (parsed.cards && Array.isArray(parsed.cards) && parsed.cards.length > 0) return parsed;
    }
  } catch (e) {}

  // 3. Extracción robusta de objetos individuales { question, answer }
  try {
    const cardMatches = [...cleaned.matchAll(/\{\s*"question"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/gs)];
    if (cardMatches.length > 0) {
      const cards = cardMatches.map(m => ({
        question: m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        answer: m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        topic: 'Estudio',
        tags: ['flashcard']
      }));
      return { cards };
    }
  } catch (e) {}

  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, engine = 'openrouter' } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt es requerido' });
  }

  const cerebrasKey = process.env.CEREBRAS_API_KEY || req.body?.cerebrasApiKey || req.headers?.['x-cerebras-key'] || 'csk-jyh22cx6n4eh84ek94fjdwtj6935k5m2rj8k6xhrkrjw8w3k';
  const openRouterKey = process.env.OPENROUTER_API_KEY || req.body?.openRouterApiKey || req.headers?.['x-openrouter-key'];
  const groqKey = process.env.GROQ_API_KEY || req.body?.groqApiKey || req.headers?.['x-groq-key'];
  const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || req.body?.apiKey || req.headers?.['x-api-key'];

  // ==================== MOTOR CEREBRAS CLOUD ULTRA-FAST (1,800 tok/s · LLaMA 3.3 70B) ====================
  if (engine === 'cerebras' || (!groqKey && !geminiKey && !openRouterKey && cerebrasKey)) {
    if (!cerebrasKey) {
      return res.status(500).json({ error: 'CEREBRAS_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
    }

    const cerebrasModels = ['llama-3.3-70b', 'gpt-oss-120b', 'gemma-4-31b', 'llama3.1-8b'];
    let lastCerebrasError = null;

    const cleanedCerebrasKey = cerebrasKey.trim();
    const authHeader = cleanedCerebrasKey.startsWith('Bearer ') ? cleanedCerebrasKey : `Bearer ${cleanedCerebrasKey}`;

    for (const model of cerebrasModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const cerebrasRes = await fetch('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'User-Agent': 'PulseDeck-AI/1.0 (Web Platform)'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'Eres un profesor universitario experto en pedagogía y diseño de exámenes. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido con la clave "cards". Debes seguir ESTRICTAMENTE cualquier directiva de enfoque específico (como temas o capítulos concretos) solicitada en el mensaje.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 4096
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (cerebrasRes.ok) {
          const data = await cerebrasRes.json();
          const rawText = data.choices?.[0]?.message?.content;
          const parsed = parseCardsFromAIResponse(rawText);
          if (parsed) return res.status(200).json(parsed);
        } else {
          const errData = await cerebrasRes.json().catch(() => ({}));
          lastCerebrasError = errData.error?.message || `Cerebras Cloud (${model}) respondió con código ${cerebrasRes.status}`;
          console.warn(`Cerebras modelo ${model} falló, intentando siguiente...`);
        }
      } catch (error) {
        lastCerebrasError = error.name === 'AbortError'
          ? `Tiempo de espera agotado en Cerebras (${model})`
          : error.message;
      }
    }

    return res.status(500).json({ error: lastCerebrasError || 'Error al comunicarse con Cerebras Cloud API' });
  }

  // ==================== MOTOR 1: OPENROUTER (DeepSeek V3 / Llama 3.3 / Multi-IA) ====================
  if (engine === 'openrouter' || (!groqKey && !geminiKey && openRouterKey)) {
    if (!openRouterKey) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
    }

    const openRouterModels = [
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001',
      'mistralai/mistral-small-24b-instruct-2501'
    ];
    let lastOpenRouterError = null;

    const cleanedOpenRouterKey = openRouterKey.trim();
    const authHeader = cleanedOpenRouterKey.startsWith('Bearer ') ? cleanedOpenRouterKey : `Bearer ${cleanedOpenRouterKey}`;

    for (const model of openRouterModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'HTTP-Referer': 'https://pulsedeck-six.vercel.app',
            'X-Title': 'PulseDeck Flashcards AI'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'Eres un profesor universitario experto en pedagogía y diseño de exámenes. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido con la clave "cards". Debes seguir ESTRICTAMENTE cualquier directiva de enfoque específico (como temas o capítulos concretos) solicitada en el mensaje.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 4096
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (openRouterRes.ok) {
          const data = await openRouterRes.json();
          const rawText = data.choices?.[0]?.message?.content;
          const parsed = parseCardsFromAIResponse(rawText);
          if (parsed) return res.status(200).json(parsed);
        } else {
          const errData = await openRouterRes.json().catch(() => ({}));
          lastOpenRouterError = errData.error?.message || `OpenRouter (${model}) respondió con código ${openRouterRes.status}`;
          console.warn(`OpenRouter modelo ${model} falló, intentando siguiente...`);
        }
      } catch (error) {
        lastOpenRouterError = error.name === 'AbortError'
          ? `Tiempo de espera agotado en OpenRouter (${model})`
          : error.message;
      }
    }

    return res.status(500).json({ error: lastOpenRouterError || 'Error al comunicarse con OpenRouter API' });
  }

  // ==================== MOTOR 2: GROQ ULTRA-FAST (LLaMA 3.3 70B / 3.1 8B) ====================
  if (engine === 'groq' || (!geminiKey && groqKey)) {
    if (!groqKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
    }

    // Modelos estables y vigentes a largo plazo de Groq
    const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    let lastGroqError = null;

    // Asegurar que el prompt no exceda el límite de tokens de Groq (~1800 tokens = ~8000 caracteres)
    let safePrompt = prompt.length > 8500 ? prompt.slice(0, 8500) : prompt;

    for (const model of groqModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqKey.trim()}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'Eres un profesor universitario experto en pedagogía y diseño de exámenes. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido con la clave "cards". Debes seguir ESTRICTAMENTE cualquier directiva de enfoque específico (como temas o capítulos concretos) solicitada en el mensaje.'
              },
              {
                role: 'user',
                content: safePrompt
              }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 2048
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (groqRes.ok) {
          const data = await groqRes.json();
          const rawText = data.choices?.[0]?.message?.content;
          const parsed = parseCardsFromAIResponse(rawText);
          if (parsed) return res.status(200).json(parsed);
        } else {
          const errData = await groqRes.json().catch(() => ({}));
          const errMsg = errData.error?.message || `Groq API (${model}) respondió con código ${groqRes.status}`;
          if (!errMsg.includes('decommissioned')) {
            lastGroqError = errMsg;
          }
          console.warn(`Groq modelo ${model} falló (${errMsg}), reintentando con modelo de alta cuota...`);
          // Reducción preventiva de tokens para el reintento
          safePrompt = safePrompt.slice(0, 6000);
        }
      } catch (error) {
        lastGroqError = error.name === 'AbortError'
          ? `Tiempo de espera agotado en Groq (${model})`
          : error.message;
      }
    }

    return res.status(500).json({ error: lastGroqError || 'Error al comunicarse con Groq API' });
  }

  // ==================== MOTOR 3: GOOGLE GEMINI FLASH (3.7 / 3.6) ====================
  if (!geminiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
  }

  const geminiModels = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  let lastGeminiError = null;

  for (const mod of geminiModels) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const googleRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${geminiKey.trim()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 8192
            }
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (googleRes.ok) {
        const data = await googleRes.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = parseCardsFromAIResponse(rawText);
        if (parsed) return res.status(200).json(parsed);
      } else {
        const errData = await googleRes.json().catch(() => ({}));
        lastGeminiError = errData.error?.message || `Google API (${mod}) respondió con código ${googleRes.status}`;
        console.warn(`Gemini modelo ${mod} falló (${googleRes.status}), intentando siguiente modelo...`);
      }
    } catch (error) {
      lastGeminiError = error.name === 'AbortError'
        ? `Tiempo de espera agotado en Gemini (${mod})`
        : error.message;
    }
  }

  return res.status(500).json({ error: lastGeminiError || 'Error al comunicarse con Google Gemini' });
}
