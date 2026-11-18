import { useCallback, useEffect, useState } from 'react';
import { Bot, ExternalLink, LoaderCircle, RefreshCw, TerminalSquare, UserPlus } from 'lucide-react';
import * as api from './api';
import type { HermesDiscovery } from './types';

export default function HermesOnboarding({ onToast }: { onToast: (message: string) => void }) {
  const available = api.desktopMode || api.previewMode;
  const [discovery, setDiscovery] = useState<HermesDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    setError(null);
    try {
      setDiscovery(await api.discoverHermes());
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createProfile() {
    setError(null);
    setLoading(true);
    try {
      await api.createGuanyuProfile();
      setConfirmed(false);
      onToast('GuanYu profile created. Configure its provider next.');
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setLoading(false);
    }
    await refresh();
  }

  async function configure() {
    setError(null);
    try {
      await api.startGuanyuOnboarding();
      onToast(
        api.previewMode
          ? 'Sample preview only. No terminal was opened.'
          : 'Hermes setup opened in a separate terminal. Refresh when finished.',
      );
    } catch (e) {
      setError(api.errorMessage(e));
    }
  }

  const installation = !available
    ? 'Desktop app only'
    : loading && !discovery
      ? 'Checking…'
      : discovery?.installed
        ? 'Detected'
        : discovery
          ? 'Not detected'
          : 'Unavailable';

  return (
    <section className="settings-card" aria-label="Hermes onboarding">
      <div className="settings-heading">
        <div className="provider-icon">
          <Bot size={23} />
        </div>
        <div>
          <h3>Hermes agents</h3>
          <p>Discover existing profiles before provisioning GuanYu.</p>
        </div>
        <span className="version-pill">{installation}</span>
      </div>
      {api.previewMode && (
        <p className="muted-copy">Sample preview only. This is not a live Hermes installation.</p>
      )}
      {discovery?.installation && (
        <div className="settings-row">
          <span>Executable</span>
          <code>{discovery.installation}</code>
        </div>
      )}
      {discovery?.installed && (
        <div className="settings-row">
          <span>GuanYu profile</span>
          <strong>{discovery.profileExists ? 'Existing profile found' : 'Not configured'}</strong>
        </div>
      )}
      {discovery?.installed && discovery.profiles.trim() && (
        <details className="hermes-profiles">
          <summary>Existing Hermes profiles</summary>
          <pre>{discovery.profiles}</pre>
        </details>
      )}
      {discovery && !discovery.installed && (
        <p className="muted-copy">
          Install Hermes using its official installation guide, then select Refresh. ShellGuardian
          never downloads or runs an install script.
        </p>
      )}
      {discovery?.installed && !discovery.profileExists && (
        <>
          <p className="muted-copy">
            GuanYu will be a separate Hermes profile. Existing profiles and credentials are not
            changed.
          </p>
          <label className="hermes-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={loading}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Create a new GuanYu profile
          </label>
        </>
      )}
      {discovery?.profileExists && (
        <p className="muted-copy">
          GuanYu is ready for provider and tool setup. Setup runs in a separate terminal so
          credentials stay outside ShellGuardian.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-buttons">
        {discovery?.installed && !discovery.profileExists && (
          <button
            className="button primary"
            disabled={!confirmed || loading}
            onClick={() => void createProfile()}
          >
            <UserPlus size={16} />
            Create GuanYu
          </button>
        )}
        {discovery?.profileExists && (
          <button className="button primary" disabled={loading} onClick={() => void configure()}>
            <TerminalSquare size={16} />
            Configure GuanYu
          </button>
        )}
        <button className="button" disabled={!available || loading} onClick={() => void refresh()}>
          {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
        {discovery && !discovery.installed && (
          <button
            className="button"
            onClick={() => {
              void api.openHermesInstallGuide().catch((e) => onToast(api.errorMessage(e)));
            }}
          >
            Installation guide
            <ExternalLink size={15} />
          </button>
        )}
      </div>
    </section>
  );
}
