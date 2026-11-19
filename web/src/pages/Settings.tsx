import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { CheckCircle2, PlugZap, Save, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type AiMode, type RemoteProvider, type Settings as SettingsData, type SuggestionStatus } from '../api';
import { FocusGroup, Focusable } from '../components/Focusable';
import { TextField } from '../components/Sources';
import { Button, Spinner } from '../components/ui';
import { PinGate } from '../components/PinGate';
import { detectScreen, screenChoice, screenLabel, setScreenChoice, type ScreenChoice } from '../screen';

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {children}
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

export function Settings() {
  return (
    <PinGate title="Settings">
      <SettingsInner />
    </PinGate>
  );
}

function SettingsInner() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [aiTest, setAiTest] = useState<{ which: string; ok: boolean; message: string } | null>(null);
  const [aiTesting, setAiTesting] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setS);
  }, []);
  useEffect(() => {
    if (s) setTimeout(() => setFocus('set-tmdb'), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s === null]);

  if (!s) return <Spinner />;
  const set = <K extends keyof SettingsData>(k: K, v: SettingsData[K]) => {
    setS({ ...s, [k]: v });
    setSaved(null);
  };

  const save = async () => {
    const r = await api.saveSettings(s);
    setS(r);
    setSaved('Saved.');
    return r;
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await save();
      setTest(await api.testIndexer());
    } finally {
      setTesting(false);
    }
  };

  const isJackett = s.indexerType === 'jackett';

  const runAiTest = async (which: 'local' | 'remote') => {
    setAiTesting(which);
    setAiTest(null);
    try {
      await save();
      const r = await api.testAi(which);
      setAiTest({ which, ok: r.ok, message: r.message });
    } finally {
      setAiTesting(null);
    }
  };

  const usesLocal = s.aiMode === 'local' || s.aiMode === 'local+remote';
  const usesRemote = s.aiMode === 'remote' || s.aiMode === 'local+remote';
  const providers = s.aiProviders;
  const provider = providers?.[s.aiRemoteProvider];
  const aiResult = (which: string) =>
    aiTest?.which === which && (
      <span className={aiTest.ok ? 'test-ok' : 'test-fail'}>
        {aiTest.ok ? <CheckCircle2 /> : <XCircle />} {aiTest.message}
      </span>
    );

  return (
    <div className="page page-padded page-narrow">
      <h1 className="page-title">Settings</h1>
      <FocusGroup focusKey="settings" className="form">
        <h2>Catalog</h2>
        <Field
          label="TMDB API key"
          hint={
            <>
              Free at themoviedb.org → Settings → API. Paste either the “API Key” or the “API Read Access Token”.
            </>
          }
        >
          <TextField focusKey="set-tmdb" value={s.tmdbApiKey} onChange={(v) => set('tmdbApiKey', v)} placeholder="Paste your TMDB key" />
        </Field>

        <h2>Torrent search</h2>
        <Field label="Indexer manager" hint="Runs on this Mac and searches the torrent sites you add to it.">
          <div className="chips">
            {(['prowlarr', 'jackett'] as const).map((t) => (
              <Focusable
                key={t}
                className={`chip${s.indexerType === t ? ' is-active' : ''}`}
                onSelect={() => setS({ ...s, indexerType: t, indexerUrl: t === 'jackett' ? 'http://localhost:9117' : 'http://localhost:9696' })}
              >
                {t === 'prowlarr' ? 'Prowlarr' : 'Jackett'}
              </Focusable>
            ))}
          </div>
        </Field>
        <Field label={`${isJackett ? 'Jackett' : 'Prowlarr'} URL`}>
          <TextField value={s.indexerUrl} onChange={(v) => set('indexerUrl', v)} placeholder={isJackett ? 'http://localhost:9117' : 'http://localhost:9696'} />
        </Field>
        <Field label="API key" hint={isJackett ? 'Shown at the top right of the Jackett dashboard.' : 'Prowlarr → Settings → General → API Key.'}>
          <TextField value={s.indexerApiKey} onChange={(v) => set('indexerApiKey', v)} placeholder="Paste the API key" />
        </Field>
        <div className="actions">
          <Button icon={<PlugZap />} disabled={testing} onSelect={runTest}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          {test && (
            <span className={test.ok ? 'test-ok' : 'test-fail'}>
              {test.ok ? <CheckCircle2 /> : <XCircle />} {test.message}
            </span>
          )}
        </div>

        <h2>AI source check</h2>
        <p className="muted small form-intro">
          Checks a source before you watch or auto-download it: is it the right title, the full film, a theater copy? Runtime and file checks always run
          {s.hasFfmpeg === false ? ' (runtime check needs ffmpeg, which is missing)' : ''}; the AI adds a judgement on top.
        </p>
        <Field label="Mode">
          <div className="chips">
            {(
              [
                ['off', 'Off'],
                ['local', 'Local model'],
                ['remote', 'Remote API'],
                ['local+remote', 'Local, then remote if unsure'],
              ] as [AiMode, string][]
            ).map(([m, label]) => (
              <Focusable key={m} className={`chip${s.aiMode === m ? ' is-active' : ''}`} onSelect={() => set('aiMode', m)}>
                {label}
              </Focusable>
            ))}
          </div>
        </Field>
        {s.aiMode !== 'off' && (
          <Field label="Send video frames" hint="Three stills from the video help the AI spot camera recordings. Makes each check slower.">
            <div className="chips">
              {[true, false].map((v) => (
                <Focusable key={String(v)} className={`chip${s.aiFrames === v ? ' is-active' : ''}`} onSelect={() => set('aiFrames', v)}>
                  {v ? 'On' : 'Off'}
                </Focusable>
              ))}
            </div>
          </Field>
        )}
        {usesLocal && (
          <>
            <Field label="Ollama address" hint="Ollama runs on this Mac. From Docker use http://host.docker.internal:11434.">
              <TextField value={s.aiLocalUrl} onChange={(v) => set('aiLocalUrl', v)} placeholder="http://localhost:11434" />
            </Field>
            <Field label="Local model" hint="Any Ollama model; one with vision is needed for frames (gemma4:e2b has it).">
              <TextField value={s.aiLocalModel} onChange={(v) => set('aiLocalModel', v)} placeholder="gemma4:e2b" />
            </Field>
            <div className="actions">
              <Button icon={<PlugZap />} disabled={!!aiTesting} onSelect={() => runAiTest('local')}>
                {aiTesting === 'local' ? 'Testing… (first run loads the model)' : 'Test local model'}
              </Button>
              {aiResult('local')}
            </div>
          </>
        )}
        {usesRemote && providers && (
          <>
            <Field label="Remote provider">
              <div className="chips">
                {(Object.keys(providers) as RemoteProvider[]).map((p) => (
                  <Focusable
                    key={p}
                    className={`chip${s.aiRemoteProvider === p ? ' is-active' : ''}`}
                    onSelect={() => setS({ ...s, aiRemoteProvider: p, aiRemoteModel: '', aiRemoteBaseUrl: p === 'custom' ? s.aiRemoteBaseUrl : '' })}
                  >
                    {providers[p].name}
                    {p === 'google' ? ' (free tier)' : ''}
                  </Focusable>
                ))}
              </div>
            </Field>
            {s.aiRemoteProvider === 'google' && (
              <p className="muted small form-intro">
                Free API key at aistudio.google.com. On the free tier Google may use requests to improve its products; rate limits are shown in AI Studio.
              </p>
            )}
            {s.aiRemoteProvider === 'custom' && (
              <Field label="Server URL" hint="Any OpenAI-compatible API, ending in /v1 (LM Studio, vLLM, a proxy…).">
                <TextField value={s.aiRemoteBaseUrl} onChange={(v) => set('aiRemoteBaseUrl', v)} placeholder="http://localhost:1234/v1" />
              </Field>
            )}
            <Field label="API key">
              <TextField value={s.aiRemoteApiKey} onChange={(v) => set('aiRemoteApiKey', v)} placeholder={`${provider?.name || ''} API key`} />
            </Field>
            <Field label="Model" hint={provider?.defaultModel ? `Leave empty for the default: ${provider.defaultModel}` : 'Enter the model name to use.'}>
              <TextField value={s.aiRemoteModel} onChange={(v) => set('aiRemoteModel', v)} placeholder={provider?.defaultModel || 'model name'} />
            </Field>
            <div className="actions">
              <Button icon={<PlugZap />} disabled={!!aiTesting} onSelect={() => runAiTest('remote')}>
                {aiTesting === 'remote' ? 'Testing…' : 'Test remote model'}
              </Button>
              {aiResult('remote')}
            </div>
          </>
        )}

        <h2>Watching</h2>
        <Field label="When a watched title is found" hint="Only verified sources are used.">
          <div className="chips">
            {[false, true].map((v) => (
              <Focusable key={String(v)} className={`chip${s.watchAutoDownload === v ? ' is-active' : ''}`} onSelect={() => set('watchAutoDownload', v)}>
                {v ? 'Download it automatically' : 'Just notify me'}
              </Focusable>
            ))}
          </div>
        </Field>
        <Field label="Preferred quality">
          <div className="chips">
            {(['2160p', '1080p', '720p', 'any'] as const).map((r) => (
              <Focusable key={r} className={`chip${s.watchResolution === r ? ' is-active' : ''}`} onSelect={() => set('watchResolution', r)}>
                {r === '2160p' ? '4K' : r === 'any' ? 'Any' : r}
              </Focusable>
            ))}
          </div>
        </Field>
        <Field label="Largest file to pick (GB)">
          <TextField type="number" value={String(s.watchMaxSizeGb)} onChange={(v) => set('watchMaxSizeGb', Number(v) || 0)} />
        </Field>

        <ScreenField />

        <h2>Suggestions</h2>
        <Field
          label="Pick and explain with AI"
          hint={`Every night at 3am each profile gets “Top picks”, “Because you watched…” and themed rows on Home, built from what they watch and their list. With AI on, the model chosen above (${s.aiMode === 'off' ? 'currently off' : s.aiMode === 'remote' ? 'remote' : s.aiLocalModel}) ranks them, writes the reasons and names the themed rows; it can only choose real titles from a list. Off: scoring alone.`}
        >
          <div className="chips">
            {[true, false].map((v) => (
              <Focusable key={String(v)} className={`chip${s.suggestAi === v ? ' is-active' : ''}`} onSelect={() => set('suggestAi', v)}>
                {v ? 'On' : 'Off (scoring only)'}
              </Focusable>
            ))}
          </div>
        </Field>
        <SuggestionsStatus />

        <h2>Sharing</h2>
        <Field
          label="Share with other peers (upload)"
          hint="Off: download-only — peers can connect and send to you, but nothing is ever uploaded from this Mac. Applies to torrents started after the change."
        >
          <div className="chips">
            {[false, true].map((v) => (
              <Focusable key={String(v)} className={`chip${s.shareUploads === v ? ' is-active' : ''}`} onSelect={() => set('shareUploads', v)}>
                {v ? 'On (seed)' : 'Off (download only)'}
              </Focusable>
            ))}
          </div>
        </Field>

        <h2>Storage</h2>
        <Field label="Download folder" hint="Where streamed files are cached on this Mac.">
          <TextField value={s.downloadDir} onChange={(v) => set('downloadDir', v)} />
        </Field>
        <Field label="Cache limit (GB)" hint="When the folder grows past this, the least recently watched downloads are deleted.">
          <TextField type="number" value={String(s.cacheLimitGb)} onChange={(v) => set('cacheLimitGb', Number(v) || 0)} />
        </Field>

        <div className="actions">
          <Button variant="primary" icon={<Save />} onSelect={save}>
            Save
          </Button>
          {saved && <span className="test-ok">{saved}</span>}
        </div>
      </FocusGroup>
    </div>
  );
}

/** Per-device: the screen resolution sources are picked for (stored in this browser, not on the server). */
function ScreenField() {
  const [choice, setChoice] = useState<ScreenChoice>(screenChoice());
  const detected = screenLabel(detectScreen());
  const pick = (v: ScreenChoice) => {
    setScreenChoice(v);
    setChoice(v);
  };
  return (
    <Field label="This screen" hint={`“Best pick” prefers sources that match it — no 4K downloads for a 1080p screen. Saved on this device only. Detected: ${detected}.`}>
      <div className="chips">
        {(['auto', '2160', '1080', '720'] as const).map((v) => (
          <Focusable key={v} className={`chip${choice === v ? ' is-active' : ''}`} onSelect={() => pick(v)}>
            {v === 'auto' ? `Auto (${detected})` : v === '2160' ? '4K' : `${v}p`}
          </Focusable>
        ))}
      </div>
    </Field>
  );
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function SuggestionsStatus() {
  const [list, setList] = useState<SuggestionStatus[] | null>(null);
  const [asked, setAsked] = useState(false);
  const load = () =>
    api
      .suggestionStatus()
      .then((r) => setList(r.profiles))
      .catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  // While a rebuild runs, refresh every few seconds.
  useEffect(() => {
    if (!asked && !list?.some((p) => p.building)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [asked, list]);
  if (!list) return null;
  return (
    <div className="form-field">
      <label>Status</label>
      <ul className="suggest-status muted small">
        {list.map((p) => (
          <li key={p.profileId}>
            <strong>{p.name}</strong>:{' '}
            {p.building
              ? 'building now…'
              : p.builtAt
                ? `${p.rows} rows from ${p.basedOn} watched/listed titles, ${ago(p.builtAt)} · ${p.ai ? `${p.ai.model}, ${Math.round(p.ai.ms / 1000)}s` : p.aiError ? `AI failed (${p.aiError}) — scoring only` : 'scoring only'}`
                : 'nothing yet (needs something watched or in My List)'}
          </li>
        ))}
      </ul>
      <div className="actions actions-tight">
        <Button
          onSelect={() => {
            setAsked(true);
            api.rebuildSuggestions().then(load);
            setTimeout(() => setAsked(false), 5 * 60 * 1000);
          }}
        >
          Rebuild now
        </Button>
      </div>
    </div>
  );
}
