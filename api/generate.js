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

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || req.body?.apiKey || req.headers?.['x-api-key'];
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY no está configurada en las Variables de Entorno de Vercel.' });
  }

  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt es requerido' });
  }

  // Solo modelos Gemini 3.7 Flash y 3.6 Flash
  const modelsToTry = [
    'gemini-3.7-flash',
    'gemini-3.6-flash'
  ];
  let lastError = null;

  for (const mod of modelsToTry) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const googleRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${mod}:generateContent?key=${apiKey}`,
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
        lastError = errData.error?.message || `Google API (${mod}) respondió con código ${googleRes.status}`;
        console.warn(`Modelo ${mod} falló (${googleRes.status}), intentando siguiente modelo...`);
      }
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? `Tiempo de espera agotado en ${mod}`
        : error.message;
    }
  }

  return res.status(500).json({ error: lastError || 'Error al comunicarse con Google Gemini' });
}
