import OpenAI from 'openai';

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  throw new Error('Worker requires GROQ_API_KEY in env. See .env.example.');
}

export const groq = new OpenAI({
  apiKey,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 8,
});

export const MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
