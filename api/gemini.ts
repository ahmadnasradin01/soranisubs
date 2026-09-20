export const config = {
  maxDuration: 60,
};

export default async function handler(req: any, res: any) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Support server environment variables (GEMINI_API_KEY or fallbacks) or header
  const apiKey =
    req.headers['x-gemini-key'] ||
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY_FALLBACK_1 ||
    process.env.GEMINI_API_KEY_FALLBACK_2 ||
    process.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error: 'No Gemini API key configured on server. Please add GEMINI_API_KEY in Vercel Environment Variables.',
    });
  }

  const { model = 'gemini-3.8-flash', contents, generationConfig } = req.body || {};

  if (!contents) {
    return res.status(400).json({ error: 'Missing contents in request body' });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
    });

    const data = await geminiRes.json();
    return res.status(geminiRes.status).json(data);
  } catch (err: any) {
    return res.status(500).json({
      error: err.message || 'Internal proxy error communicating with Gemini',
    });
  }
}
