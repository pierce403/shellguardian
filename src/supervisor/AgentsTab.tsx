// Agents (Hermes profiles): who they are, which model they use, and what
// they are allowed to do as a supervisor.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bot,
  ClipboardCheck,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  TerminalSquare,
  UserPlus,
} from 'lucide-react';
import * as api from '../api';
import type { HermesModelOptions, HermesProviderOption } from '../types';
import { gatewayDown, useLoad } from './hooks';
import { GatewayNotice, RefreshButton, Select, UsageMeters } from './parts';
import { DEFAULT_SUPERVISOR, type Hermes } from './useHermes';

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function providerNote(provider: HermesProviderOption): string {
  if (provider.authenticated) return 'ready';
  return provider.auth_type === 'api_key' ? 'needs a key' : 'needs sign-in';
}

/** Choose an agent's provider and model through Hermes's own validated assignment. */
export function ProviderPanel({
  profile,
  gatewayRunning,
  onChanged,
  onSignIn,
}: {
  profile: string;
  /** Reloads the list when the agent's gateway comes up. */
  gatewayRunning: boolean;
  onChanged: () => void;
  onSignIn: (profile: string) => void;
}) {
  const options = useLoad<HermesModelOptions>(
    () => api.hermesModelOptions(profile, true),
    [profile, gatewayRunning],
  );
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const current = options.data;
  // Start from the agent's current choice, once. Later reloads must not put
  // the old model back after the user has picked another provider.
  const seeded = useRef(false);
  useEffect(() => {
    if (!current || seeded.current) return;
    seeded.current = true;
    setProvider(current.provider ?? '');
    setModel(current.model ?? '');
  }, [current]);

  const providers = current?.providers ?? [];
  const ready = providers.filter((p) => p.authenticated);
  const rest = providers.filter((p) => !p.authenticated);
  const chosen = providers.find((p) => p.slug === provider);
  const currentName = providers.find((p) => p.slug === current?.provider)?.name;
  const needsKey = chosen !== undefined && !chosen.authenticated && chosen.auth_type === 'api_key';
  const needsSignIn =
    chosen !== undefined && !chosen.authenticated && chosen.auth_type !== 'api_key';
  const unchanged = provider === (current?.provider ?? '') && model === (current?.model ?? '');

  async function apply(confirmed: boolean) {
    if (!provider || !model.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.setHermesModel(profile, provider, model.trim(), confirmed);
      if (result.confirm_required) {
        setConfirm(result.confirm_message ?? 'Hermes asks you to confirm this model.');
      } else {
        setConfirm(null);
        setMessage(`${profile} now uses ${model.trim()}.`);
        onChanged();
        void options.reload(true);
      }
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!provider || !key.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.saveHermesKey(profile, provider, key);
      setMessage(`Hermes saved the key for ${chosen?.name ?? provider}. Now choose a model.`);
      void options.reload(true);
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      // The key never stays in the page, whether or not Hermes accepted it.
      setKey('');
      setBusy(false);
    }
  }

  return (
    <section className="settings-card" aria-label={`Model and provider for ${profile}`}>
      <div className="section-label">
        <KeyRound size={18} aria-hidden="true" />
        <h3>Model and provider for {profile}</h3>
        <RefreshButton loading={options.loading} onClick={() => void options.reload()} />
      </div>
      {options.loading && !current && (
        <p className="muted-copy" role="status">
          Asking Hermes for {profile}'s providers…
        </p>
      )}
      {options.error &&
        (gatewayDown(options.error) ? (
          <GatewayNotice
            profile={profile}
            onStarted={() => {
              onChanged();
              void options.reload();
            }}
          />
        ) : (
          <p className="form-error" role="alert">
            {options.error}
          </p>
        ))}
      {current && (
        <>
          <p className="sv-current-model">
            {current.model ? (
              <>
                Using <strong>{current.model}</strong>
                {current.provider ? ` via ${currentName ?? current.provider}` : ''}
              </>
            ) : (
              'No model chosen yet'
            )}
          </p>
          <UsageMeters providers={ready} />

          <div className="sv-form-grid">
            <div className="sv-field">
              <label className="field-label" htmlFor={`sv-provider-${profile}`}>
                Provider
              </label>
              <Select
                id={`sv-provider-${profile}`}
                className="block"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel('');
                  setConfirm(null);
                  setMessage(null);
                }}
              >
                <option value="">Choose a provider</option>
                {ready.length > 0 && (
                  <optgroup label="Ready to use">
                    {ready.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name ?? p.slug}
                      </option>
                    ))}
                  </optgroup>
                )}
                {rest.length > 0 && (
                  <optgroup label="Needs setup">
                    {rest.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name ?? p.slug} ({providerNote(p)})
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </div>
            <div className="sv-field">
              <label className="field-label" htmlFor={`sv-model-${profile}`}>
                Model
              </label>
              <Select
                id={`sv-model-${profile}`}
                className="block"
                value={model}
                disabled={!chosen || chosen.models.length === 0}
                onChange={(e) => {
                  setModel(e.target.value);
                  setConfirm(null);
                  setMessage(null);
                }}
              >
                <option value="">
                  {!chosen
                    ? 'Choose a provider first'
                    : chosen.models.length === 0
                      ? 'Set up this provider to see its models'
                      : 'Choose a model'}
                </option>
                {(chosen?.models ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {needsKey && (
            <form className="sv-key-form" onSubmit={(e) => void saveKey(e)}>
              <label className="field-label" htmlFor={`sv-key-${profile}`}>
                API key for {chosen?.name ?? provider}
              </label>
              <div className="workspace-form">
                <input
                  id={`sv-key-${profile}`}
                  type="password"
                  value={key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button className="button primary" disabled={busy || !key.trim()}>
                  Save key
                </button>
              </div>
              <p className="muted-copy">
                The key goes straight to Hermes, which stores it in this agent's profile.
                ShellGuardian does not keep it.
              </p>
            </form>
          )}
          {needsSignIn && (
            <div className="sv-notice" role="status">
              <TerminalSquare size={18} aria-hidden="true" />
              <p>
                {chosen?.name ?? provider} uses a sign-in that Hermes runs in a terminal. Finish it
                there, then refresh this list.
              </p>
              <button className="button" onClick={() => onSignIn(profile)}>
                Sign in with Hermes
              </button>
            </div>
          )}
          {confirm && (
            <div className="sv-notice" role="status">
              <KeyRound size={18} aria-hidden="true" />
              <p>{confirm}</p>
              <button className="button primary" disabled={busy} onClick={() => void apply(true)}>
                Confirm model
              </button>
            </div>
          )}
          {message && (
            <p className="sv-success" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-buttons">
            <button
              className="button primary"
              disabled={busy || !provider || !model.trim() || unchanged || Boolean(confirm)}
              onClick={() => void apply(false)}
            >
              {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
              Use this model
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Lets an agent turn requests into kanban tasks. An explicit, additive change. */
function SupervisorDuties({ profile, onChanged }: { profile: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const done = await api.prepareHermesSupervisor(profile);
      setMessage(
        done.kanbanEnabled || done.skillInstalled
          ? `${profile} can now create and track kanban tasks.`
          : `${profile} was already prepared.`,
      );
      onChanged();
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card" aria-label="Supervisor duties">
      <div className="section-label">
        <ClipboardCheck size={18} aria-hidden="true" />
        <h3>Supervisor duties for {profile}</h3>
      </div>
      <p className="muted-copy">
        Lets {profile} turn your requests into kanban tasks. This turns on Hermes's kanban tools for{' '}
        {profile} and adds one ShellGuardian playbook skill. Nothing else in the profile changes.
      </p>
      {error &&
        (gatewayDown(error) ? (
          <GatewayNotice profile={profile} onStarted={() => void prepare()} />
        ) : (
          <p className="form-error" role="alert">
            {error}
          </p>
        ))}
      {message && (
        <p className="sv-success" role="status">
          {message}
        </p>
      )}
      <div className="settings-buttons">
        <button className="button" disabled={busy} onClick={() => void prepare()}>
          {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
          Prepare {profile} as supervisor
        </button>
      </div>
    </section>
  );
}

export function AgentsTab({
  hermes,
  onChat,
  onConfigure,
  onSignIn,
  onToast,
}: {
  hermes: Hermes;
  onChat: (profile: string) => void;
  onConfigure: (profile: string) => void;
  onSignIn: (profile: string) => void;
  onToast: (message: string) => void;
}) {
  const { profiles, supervisor } = hermes;
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const hasDefault = profiles.some((profile) => profile.name === DEFAULT_SUPERVISOR);

  async function create(event: FormEvent) {
    event.preventDefault();
    const wanted = name.trim();
    if (!PROFILE_NAME.test(wanted)) {
      setFormError(
        'Use lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.',
      );
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      await api.createHermesProfile(wanted);
      setName('');
      await hermes.refresh();
      hermes.choose(wanted);
      onToast(`${wanted} created. Choose its model and provider next.`);
    } catch (e) {
      setFormError(api.errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="sv-agents-view">
      <div className="sv-agent-grid" role="list" aria-label="Hermes agents">
        {profiles.map((profile) => {
          const selected = profile.name === supervisor?.name;
          const model =
            profile.model === null
              ? 'Not set up yet'
              : profile.provider === 'auto'
                ? 'No provider chosen'
                : `${profile.model}${profile.provider ? ` via ${profile.provider}` : ''}`;
          return (
            <article
              key={profile.name}
              role="listitem"
              className={`agent-card sv-agent${selected ? ' selected' : ''}`}
              aria-label={profile.name}
            >
              <div className="agent-card-top">
                <div className={`agent-avatar ${selected ? 'sage' : 'blue'}`}>
                  <Bot size={22} aria-hidden="true" />
                </div>
                <span className={`status ${profile.gateway === 'running' ? 'good' : 'muted'}`}>
                  <span className="status-dot" />
                  Gateway {profile.gateway === 'running' ? 'running' : 'stopped'}
                </span>
              </div>
              <h3>{profile.name}</h3>
              <p className="agent-meta">{model}</p>
              <div className="sv-agent-tags">
                {selected && <span className="small-tag">Selected</span>}
                {profile.active && <span className="small-tag">Hermes default</span>}
              </div>
              <div className="sv-agent-actions">
                <button
                  className="button compact"
                  aria-label={`Chat with ${profile.name}`}
                  onClick={() => onChat(profile.name)}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                  Chat
                </button>
                {!selected && (
                  <button
                    className="button compact"
                    aria-label={`Select ${profile.name}`}
                    onClick={() => hermes.choose(profile.name)}
                  >
                    Select
                  </button>
                )}
                <button
                  className="button compact"
                  aria-label={`Open setup for ${profile.name}`}
                  onClick={() => onConfigure(profile.name)}
                >
                  <TerminalSquare size={14} aria-hidden="true" />
                  Setup wizard
                </button>
              </div>
            </article>
          );
        })}
        <form
          className="agent-card sv-agent sv-agent-new"
          role="listitem"
          aria-label="New agent"
          onSubmit={(e) => void create(e)}
        >
          <div className="agent-card-top">
            <div className="agent-avatar sand">
              <UserPlus size={22} aria-hidden="true" />
            </div>
          </div>
          <h3>New agent</h3>
          <p className="agent-meta">
            An empty Hermes profile. Nothing is copied from your other agents.
          </p>
          <label className="field-label" htmlFor="sv-new-agent">
            Name
          </label>
          <div className="workspace-form">
            <input
              id="sv-new-agent"
              value={name}
              placeholder={hasDefault ? 'agent-name' : DEFAULT_SUPERVISOR}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="button primary" disabled={creating || !name.trim()}>
              {creating && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
              Create agent
            </button>
          </div>
          {!hasDefault && (
            <button
              type="button"
              className="link-button"
              onClick={() => setName(DEFAULT_SUPERVISOR)}
            >
              Use the suggested supervisor name, {DEFAULT_SUPERVISOR}
            </button>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
        </form>
      </div>

      {supervisor && (
        <div className="sv-agent-detail" data-agent-detail>
          <ProviderPanel
            key={supervisor.name}
            profile={supervisor.name}
            gatewayRunning={supervisor.gateway === 'running'}
            onChanged={() => void hermes.refresh()}
            onSignIn={onSignIn}
          />
          <SupervisorDuties
            key={`duties-${supervisor.name}`}
            profile={supervisor.name}
            onChanged={() => void hermes.refresh()}
          />
        </div>
      )}
    </div>
  );
}
