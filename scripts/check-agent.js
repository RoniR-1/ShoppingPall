import 'dotenv/config';
import { callGeminiJSON } from '../src/web-demo/luna.js';

try {
  const result = await callGeminiJSON(
    'Return a JSON object.',
    'Return {"lines":[{"query":"milk","quantity":1}]}.'
  );
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'AI_ERROR', error: error.message }));
  process.exitCode = 1;
}
