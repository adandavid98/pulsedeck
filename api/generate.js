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

  const { prompt, engine = 'groq' } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt es requerido' });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY || req.body?.openRouterApiKey || req.headers?.['x-openrouter-key'];
  const groqKey = process.env.GROQ_API_KEY || req.body?.groqApiKey || req.headers?.['x-groq-key'];
  const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || req.body?.apiKey || req.headers?.['x-api-key'];

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

    for (const model of openRouterModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openRouterKey}`,
            'HTTP-Referer': 'https://pulsedeck-six.vercel.app',
            'X-Title': 'PulseDeck Flashcards AI'
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'Eres un profesor universitario experto en pedagogía. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido que contenga la clave "cards".'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 2048
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (openRouterRes.ok) {
          const data = await openRouterRes.json();
          const rawText = data.choices?.[0]?.message?.content;
          if (rawText) {
            const parsed = JSON.parse(rawText);
            return res.status(200).json(parsed);
          }
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

    // Lista de modelos activos de Groq con auto-detección dinámica
    let groqModels = ['gpt-oss-120b', 'gpt-oss-20b', 'qwen3.6-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    try {
      const modelsListRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` }
      });
      if (modelsListRes.ok) {
        const modelsData = await modelsListRes.json();
        const activeIds = (modelsData.data || []).map(m => m.id);
        const filtered = groqModels.filter(m => activeIds.includes(m));
        if (filtered.length > 0) {
          groqModels = filtered;
        } else if (activeIds.length > 0) {
          const chatModels = activeIds.filter(id => !id.includes('whisper') && !id.includes('vision') && !id.includes('guard'));
          if (chatModels.length > 0) groqModels = chatModels;
        }
      }
    } catch (e) {
      console.warn('Auto-detección de modelos Groq omitida, usando lista predeterminada', e);
    }
    let lastGroqError = null;

    for (const model of groqModels) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              {
                role: 'system',
                content: 'Eres un profesor universitario experto en pedagogía. Responde ÚNICA Y EXCLUSIVAMENTE con un objeto JSON válido que contenga la clave "cards".'
              },
              {
                role: 'user',
                content: prompt
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
          if (rawText) {
            const parsed = JSON.parse(rawText);
            return res.status(200).json(parsed);
          }
        } else {
          const errData = await groqRes.json().catch(() => ({}));
          lastGroqError = errData.error?.message || `Groq API (${model}) respondió con código ${groqRes.status}`;
          console.warn(`Groq modelo ${model} falló, intentando siguiente...`);
        }
      } catch (error) {
        lastGroqError = error.name === 'AbortError'
          ? `Tiempo de espera agotado en Groq (${model})`
          : error.message;
      }
    }

    return res.status(500).json({ error: lastGroqError || 'Error al comunicarse con Groq API' });
  }

  // ==================== MOTOR 2: GOOGLE GEMINI FLASH (3.7 / 3.6) ====================
  if (!geminiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
  }

  const geminiModels = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  let lastGeminiError = null;

  for (const mod of geminiModels) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const googleRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              response_mime_type: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 2048
            }
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (googleRes.ok) {
        const data = await googleRes.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          return res.status(200).json(parsed);
        }
      } else {
        const errData = await googleRes.json().catch(() => ({}));
        lastGeminiError = errData.error?.message || `Google API (${mod}) respondió con código ${googleRes.status}`;
        console.warn(`Gemini modelo ${mod} falló, intentando siguiente...`);
      }
    } catch (error) {
      lastGeminiError = error.name === 'AbortError'
        ? `Tiempo de espera agotado en Gemini (${mod})`
        : error.message;
    }
  }

  return res.status(500).json({ error: lastGeminiError || 'Error al comunicarse con Google Gemini' });
}
