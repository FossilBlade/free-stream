/**
 * Provider-agnostic "is this torrent the right title, and the whole thing?" judge.
 *
 * - Local: Ollama on the Mac (default; nothing leaves the machine).
 * - Remote: Google Gemini (default, free tier), Anthropic, OpenAI, xAI, OpenRouter, or any
 *   OpenAI-compatible server. Google/OpenAI/xAI/OpenRouter all speak the OpenAI chat API.
 *
 * Every provider gets the same prompt and must answer in the same JSON shape (VerdictSchema).
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { getSettings, type RemoteProvider } from './store.ts';

export const VerdictSchema = z.strictObject({
  match: z.boolean().describe('True if this file is the requested title (right film/show, right year, right part/sequel, right episode).'),
  kind: z
    .enum(['full_release', 'theater_cam', 'theater_screener', 'tv_recording', 'trailer_or_sample', 'fake_or_malware', 'wrong_title', 'unknown'])
    .describe('What this file is.'),
  is_full_feature: z.boolean().describe('True if it is the complete film/episode (runtime close to the expected runtime), not a part, sample or trailer.'),
  quality: z.string().describe('Short quality description, e.g. "1080p WEB-DL", "720p camera recording".'),
  audio_languages: z.array(z.string()).describe('Audio languages, e.g. ["English", "Hindi"]. Empty if unknown.'),
  confidence: z.number().describe('0.0 to 1.0: how sure you are of this verdict.'),
  issues: z.array(z.string()).describe('Problems a viewer should know about, e.g. "Hindi dub only", "hardcoded Korean subtitles". Empty if none.'),
  summary: z.string().describe('One plain sentence for the viewer describing what this file is.'),
});
export type AiVerdict = z.infer<typeof VerdictSchema>;

/** JSON Schema for providers that take a schema directly (Ollama, OpenAI-compatible APIs). */
export const VERDICT_JSON_SCHEMA = (() => {
  const schema = z.toJSONSchema(VerdictSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

export const SYSTEM_PROMPT = `You check torrent releases for a home media player. You get details about a requested movie or TV episode and about one video file from a torrent, including automated measurements. Decide what the file is.

Apply these rules in order:
1. match: true when the release or file name contains the requested title (ignore case, punctuation, articles, dots/underscores and site tags like "www.site.com -") and the year matches within 1 year. For TV, season and episode must also match. Set match=false ONLY when the name clearly refers to a different film, a different sequel or "Part", a different year, or a different episode.
2. kind:
   - "theater_cam" if the name contains CAM, HDCAM, TS, HDTS, TC, HDTC, TELESYNC or PreDVD, or the frames clearly show a cinema screen filmed with a camera (skewed screen, audience heads, washed-out picture).
   - "theater_screener" if the name contains SCR, DVDScr or Screener.
   - "trailer_or_sample" if a movie's measured runtime is under 10 minutes or the name says trailer/sample.
   - "fake_or_malware" if the torrent contains program files (.exe, .scr, .lnk ...) or password-protected archives.
   - "wrong_title" if match is false.
   - otherwise "full_release".
3. is_full_feature: true when automatedChecks.runtimeCheck is "ok" (measured runtime within ~15% of expected). False when it is "short".
4. confidence: 0.9 or higher when name, year and runtime all agree. Use a lower value only when the evidence conflicts.
5. quality: resolution and source from the evidence, e.g. "1080p BluRay", "720p WEB-DL", "1080p camera recording".
6. audio_languages: from the audio tracks if tagged; otherwise infer from the release name (e.g. "Hindi" in the name); empty if unknown.
7. issues: things a viewer should know (dubbed-only audio, hardcoded subtitles, theater copy). Empty if none.

The name and the measured runtime ARE the evidence: do not answer "unknown" or lower confidence just because you cannot watch the whole film. Frames, if attached, are only for spotting camera recordings; normal-looking film frames support "full_release".`;

export interface JudgeInput {
  /** Structured facts about the title and the file (shown to the model as JSON). */
  evidence: Record<string, unknown>;
  /** JPEG frames from the video (optional). */
  frames: Buffer[];
}

export interface JudgeResult {
  provider: string;
  model: string;
  verdict: AiVerdict;
  usedFrames: boolean;
}

export class LlmError extends Error {}

const REMOTE: Record<RemoteProvider, { name: string; baseUrl: string; defaultModel: string }> = {
  // Free tier; multimodal; structured output through the OpenAI-compatible endpoint.
  google: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-4-hydrogen' },
  anthropic: { name: 'Anthropic Claude', baseUrl: '', defaultModel: 'claude-opus-5-5' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: '' },
  xai: { name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', defaultModel: '' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: '' },
  custom: { name: 'OpenAI-compatible', baseUrl: '', defaultModel: '' },
};

export const remoteDefaults = () =>
  Object.fromEntries(Object.entries(REMOTE).map(([k, v]) => [k, { name: v.name, defaultModel: v.defaultModel, baseUrl: v.baseUrl }]));

const userText = (input: JudgeInput) =>
  `Requested title and file details (JSON):\n${JSON.stringify(input.evidence, null, 2)}${
    input.frames.length ? `\n\n${input.frames.length} frame(s) from the video are attached, taken at roughly 20%, 50% and 80% of its length.` : ''
  }\n\nReturn your verdict.`;

/** Models sometimes wrap JSON in prose or code fences; take the outermost object and validate it. */
function parseVerdict(text: string): AiVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('The model did not return JSON.');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmError('The model returned malformed JSON.');
  }
  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError(`The model's answer didn't match the expected format: ${parsed.error.issues[0]?.message}`);
  const v = parsed.data;
  return { ...v, confidence: Math.max(0, Math.min(1, v.confidence)) };
}

/** The human message from a provider's error body (Google wraps it in a list: [{"error":{...}}]). */
function errorMessage(text: string): string {
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    const e = j?.error ?? j;
    const msg = typeof e === 'string' ? e : e?.message;
    if (msg) return String(msg).trim();
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300).trim();
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * POST JSON within one time budget (`timeoutMs` covers all attempts). A busy or rate-limited provider
 * (429/5xx) is retried after a short wait while enough of the budget is left.
 */
async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const host = new URL(url).host;
  const deadline = Date.now() + timeoutMs;
  let lastBusy = '';
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1000, left)) });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError') {
        throw new LlmError(`No answer within ${Math.round(timeoutMs / 1000)}s${lastBusy ? ` (earlier attempts: ${lastBusy})` : ''}. The model may be overloaded; try again later, or set a different model.`);
      }
      throw new LlmError(`Couldn't reach ${host}: ${err.message}`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError('Unexpected non-JSON response.');
      }
    }
    const msg = errorMessage(text);
    const wait = (attempt + 1) * 3000;
    if (RETRYABLE.has(res.status) && attempt < 2 && deadline - Date.now() > wait + 10000) {
      lastBusy = `${res.status} ${msg}`.slice(0, 160);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 503 || res.status === 529) throw new LlmError(`The model is overloaded right now (${res.status}): ${msg} Try again in a minute, or set a different model.`);
    if (res.status === 429) throw new LlmError(`Rate limit or quota reached (429): ${msg}`);
    if (res.status === 401 || res.status === 403) throw new LlmError(`The API key was rejected (${res.status}): ${msg}`);
    if (res.status === 404) throw new LlmError(`Model or address not found (404): ${msg} Check the model name.`);
    throw new LlmError(`${res.status}: ${msg}`);
  }
}

// --- Local: Ollama (native API: JSON-schema `format` is the most reliable structured output there) ---

async function judgeOllama(input: JudgeInput): Promise<JudgeResult> {
  const s = getSettings();
  const data = (await postJson(
    `${s.aiLocalUrl}/api/chat`,
    {
      model: s.aiLocalModel,
      stream: false,
      think: false,
      format: VERDICT_JSON_SCHEMA,
      // A check needs a few thousand tokens; the model default (often 32K-128K) reserves far more memory.
      options: { temperature: 0, num_ctx: input.frames.length ? 8192 : 4096 },
      keep_alive: '5m', // free the RAM a few minutes after the last check
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText(input), ...(input.frames.length ? { images: input.frames.map((f) => f.toString('base64')) } : {}) },
      ],
    },
    {},
    180000, // first call loads the model into memory
  )) as { message?: { content?: string } };
  return { provider: 'Local (Ollama)', model: s.aiLocalModel, verdict: parseVerdict(data.message?.content || ''), usedFrames: input.frames.length > 0 };
}

// --- Remote: OpenAI-compatible chat API (Google Gemini, OpenAI, xAI, OpenRouter, custom) ---

async function judgeOpenAiCompatible(provider: RemoteProvider, input: JudgeInput, timeoutMs = 90000): Promise<JudgeResult> {
  const s = getSettings();
  const cfg = REMOTE[provider];
  const baseUrl = provider === 'custom' ? s.aiRemoteBaseUrl : cfg.baseUrl;
  const model = s.aiRemoteModel || cfg.defaultModel;
  if (!baseUrl) throw new LlmError('Set the server URL for the custom provider in Settings.');
  if (!model) throw new LlmError(`Set a model name for ${cfg.name} in Settings.`);
  if (!s.aiRemoteApiKey && provider !== 'custom') throw new LlmError(`Add your ${cfg.name} API key in Settings.`);

  const content: unknown[] = [{ type: 'text', text: userText(input) }];
  for (const f of input.frames) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.toString('base64')}` } });

  const data = (await postJson(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT_JSON_SCHEMA } },
    },
    s.aiRemoteApiKey ? { authorization: `Bearer ${s.aiRemoteApiKey}` } : {},
    timeoutMs,
  )) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new LlmError(`The model declined: ${msg.refusal}`);
  return { provider: cfg.name, model, verdict: parseVerdict(msg?.content || ''), usedFrames: input.frames.length > 0 };
}

// --- Remote: Anthropic (official SDK, structured output via the Zod schema) ---

async function judgeAnthropic(input: JudgeInput): Promise<JudgeResult> {
  const s = getSettings();
  if (!s.aiRemoteApiKey) throw new LlmError('Add your Anthropic API key in Settings.');
  const model = s.aiRemoteModel || REMOTE.anthropic.defaultModel;
  const client = new Anthropic({ apiKey: s.aiRemoteApiKey, timeout: 90000, maxRetries: 1 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = input.frames.map((f) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: f.toString('base64') },
  }));
  content.push({ type: 'text', text: userText(input) });

  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
      // A short classification: low effort keeps it fast and cheap.
      output_config: { format: zodOutputFormat(VerdictSchema), effort: 'low' },
      // If the model declines (safety classifier), Anthropic re-runs the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // A refusal on the final response means the whole fallback chain declined.
    if (response.stop_reason === 'refusal') throw new LlmError('The model declined to answer.');
    if (!response.parsed_output) throw new LlmError("The model's answer didn't match the expected format.");
    const v = response.parsed_output;
    return { provider: REMOTE.anthropic.name, model, verdict: { ...v, confidence: Math.max(0, Math.min(1, v.confidence)) }, usedFrames: input.frames.length > 0 };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic rejected the API key.');
    if (e instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic rate limit reached; try again later.');
    if (e instanceof Anthropic.APIError) throw new LlmError(`Anthropic error ${e.status}: ${e.message}`);
    throw new LlmError((e as Error).message);
  }
}

function judgeRemote(input: JudgeInput, timeoutMs?: number): Promise<JudgeResult> {
  const p = getSettings().aiRemoteProvider;
  return p === 'anthropic' ? judgeAnthropic(input) : judgeOpenAiCompatible(p, input, timeoutMs);
}

/** "Unsure" answers worth a second opinion from the remote model in local+remote mode. */
const unsure = (v: AiVerdict) => v.kind === 'unknown' || v.confidence < 0.6;

/** Runs the configured judge. Returns null when AI checks are off. */
export async function judge(input: JudgeInput): Promise<JudgeResult | null> {
  const mode = getSettings().aiMode;
  if (mode === 'off') return null;
  if (mode === 'remote') return judgeRemote(input);
  if (mode === 'local') return judgeOllama(input);
  // local+remote: local first; ask the remote model only when the local one is unsure or fails.
  try {
    const local = await judgeOllama(input);
    if (!unsure(local.verdict)) return local;
  } catch {
    /* fall through to remote */
  }
  return judgeRemote(input);
}

export async function testJudge(which: 'local' | 'remote'): Promise<{ ok: boolean; message: string; ms: number }> {
  const started = Date.now();
  const sample: JudgeInput = {
    evidence: {
      requested: { type: 'movie', title: 'Sintel', year: '2010', runtimeMinutes: 15 },
      release: { name: 'Sintel.2010.1080p.WEB-DL.x264.AAC', sizeMB: 123, seeders: 120 },
      file: { name: 'Sintel.mp4', sizeMB: 123, measuredRuntimeMinutes: 14.8, resolution: '1024x436', audio: ['aac (und, 2ch)'] },
    },
    frames: [],
  };
  try {
    // The Settings button shouldn't spin for minutes: remote tests get 45 s including retries.
    const r = which === 'local' ? await judgeOllama(sample) : await judgeRemote(sample, 45000);
    const ok = r.verdict.match && r.verdict.kind === 'full_release';
    return { ok, ms: Date.now() - started, message: `${r.provider} (${r.model}) answered in ${((Date.now() - started) / 1000).toFixed(1)}s: “${r.verdict.summary}”${ok ? '' : ' — unexpected verdict for a known-good file.'}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, message: (e as Error).message };
  }
}

// --- Generic structured call (used by suggestions) ---------------------------------------------

export interface StructuredResult<T> {
  provider: string;
  model: string;
  data: T;
}

function parseWith<T>(schema: z.ZodType<T>, text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('The model did not return JSON.');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmError('The model returned malformed JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new LlmError(`The model's answer didn't match the expected format: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

const jsonSchemaOf = (schema: z.ZodType) => {
  const s = z.toJSONSchema(schema) as Record<string, unknown>;
  delete s.$schema;
  return s;
};

interface AskOptions {
  /** Context window for Ollama. */
  numCtx: number;
  /** Ollama keep_alive: 0 unloads the model right after (background jobs shouldn't hold RAM). */
  keepAlive: string | number;
  name: string;
}

async function askOllama<T>(schema: z.ZodType<T>, system: string, user: string, o: AskOptions): Promise<StructuredResult<T>> {
  const s = getSettings();
  const data = (await postJson(
    `${s.aiLocalUrl}/api/chat`,
    {
      model: s.aiLocalModel,
      stream: false,
      think: false,
      format: jsonSchemaOf(schema),
      options: { temperature: 0.2, num_ctx: o.numCtx },
      keep_alive: o.keepAlive,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    {},
    300000,
  )) as { message?: { content?: string } };
  return { provider: 'Local (Ollama)', model: s.aiLocalModel, data: parseWith(schema, data.message?.content || '') };
}

async function askOpenAiCompatible<T>(provider: RemoteProvider, schema: z.ZodType<T>, system: string, user: string, o: AskOptions): Promise<StructuredResult<T>> {
  const s = getSettings();
  const cfg = REMOTE[provider];
  const baseUrl = provider === 'custom' ? s.aiRemoteBaseUrl : cfg.baseUrl;
  const model = s.aiRemoteModel || cfg.defaultModel;
  if (!baseUrl) throw new LlmError('Set the server URL for the custom provider in Settings.');
  if (!model) throw new LlmError(`Set a model name for ${cfg.name} in Settings.`);
  if (!s.aiRemoteApiKey && provider !== 'custom') throw new LlmError(`Add your ${cfg.name} API key in Settings.`);
  const data = (await postJson(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: o.name, strict: true, schema: jsonSchemaOf(schema) } },
    },
    s.aiRemoteApiKey ? { authorization: `Bearer ${s.aiRemoteApiKey}` } : {},
    120000,
  )) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new LlmError(`The model declined: ${msg.refusal}`);
  return { provider: cfg.name, model, data: parseWith(schema, msg?.content || '') };
}

async function askAnthropic<T>(schema: z.ZodType<T>, system: string, user: string): Promise<StructuredResult<T>> {
  const s = getSettings();
  if (!s.aiRemoteApiKey) throw new LlmError('Add your Anthropic API key in Settings.');
  const model = s.aiRemoteModel || REMOTE.anthropic.defaultModel;
  const client = new Anthropic({ apiKey: s.aiRemoteApiKey, timeout: 120000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(schema as z.ZodType<T> & z.ZodObject), effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal') throw new LlmError('The model declined to answer.');
    if (!response.parsed_output) throw new LlmError("The model's answer didn't match the expected format.");
    return { provider: REMOTE.anthropic.name, model, data: response.parsed_output as T };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic rejected the API key.');
    if (e instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic rate limit reached; try again later.');
    if (e instanceof Anthropic.APIError) throw new LlmError(`Anthropic error ${e.status}: ${e.message}`);
    throw new LlmError((e as Error).message);
  }
}

function askRemote<T>(schema: z.ZodType<T>, system: string, user: string, o: AskOptions): Promise<StructuredResult<T>> {
  const p = getSettings().aiRemoteProvider;
  return p === 'anthropic' ? askAnthropic(schema, system, user) : askOpenAiCompatible(p, schema, system, user, o);
}

/**
 * Asks the configured AI (same provider choice as source checks) for an answer in `schema`'s shape.
 * Returns null when AI is off. local+remote: local first, remote if the local call fails.
 */
export async function askStructured<T>(schema: z.ZodType<T>, system: string, user: string, o: AskOptions): Promise<StructuredResult<T> | null> {
  const mode = getSettings().aiMode;
  if (mode === 'off') return null;
  if (mode === 'remote') return askRemote(schema, system, user, o);
  if (mode === 'local') return askOllama(schema, system, user, o);
  try {
    return await askOllama(schema, system, user, o);
  } catch {
    return askRemote(schema, system, user, o);
  }
}
