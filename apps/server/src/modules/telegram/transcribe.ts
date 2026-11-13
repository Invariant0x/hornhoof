import type { Config } from '../../config.js';

/* How long a transcription may take before the voice message goes on without its words. */
const TRANSCRIBE_MS = 60_000;

/* The words of a voice message, from the speech-to-text service the server is given (any that answers as OpenAI's
   /v1/audio/transcriptions does), or null when none is given or it fails: the recording still goes to the agent. The key
   goes only into the request's header, never into a log. */
export async function transcribe(config: Pick<Config, 'transcribeUrl' | 'transcribeKey' | 'transcribeModel'>, bytes: Buffer, name: string): Promise<string | null> {
  if (!config.transcribeUrl) return null;
  const form = new FormData();
  form.append('model', config.transcribeModel);
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  try {
    const res = await fetch(config.transcribeUrl, {
      method: 'POST',
      headers: config.transcribeKey ? { authorization: `Bearer ${config.transcribeKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_MS),
    });
    if (!res.ok) return null;
    const answer = (await res.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof answer?.text === 'string' ? answer.text.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}
