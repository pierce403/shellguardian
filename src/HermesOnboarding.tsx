import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

type Discovery = {
  installed: boolean;
  profileExists: boolean;
  profiles: string;
  installation: string | null;
};

export default function HermesOnboarding() {
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    setError(null);
    try {
      setDiscovery(await invoke<Discovery>('discover_hermes'));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function createProfile() {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await invoke('create_guanyu_profile');
      setConfirmed(false);
      setNotice('GuanYu profile created. Configure its provider and permissions next.');
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  async function setup() {
    setError(null);
    try {
      await invoke('start_guanyu_onboarding');
      setNotice('Hermes setup was launched in a separate terminal. Refresh when finished.');
    } catch (e) { setError(String(e)); }
  }
  return (
    <section className="settings-card" aria-label="Hermes onboarding">
      <div className="settings-heading">
        <div><h3>Hermes agents</h3><p>Discover existing profiles before provisioning GuanYu.</p></div>
      </div>
      {!isTauri() ? <p>Hermes discovery requires the ShellGuardian desktop app.</p> :
        <>
          <div className="settings-row"><span>Installation</span>
            <strong>{loading && !discovery ? 'Checking…' : discovery?.installed ? 'Detected' : 'Not detected'}</strong>
          </div>
          {discovery?.installation && <div className="settings-row"><span>Executable</span><code>{discovery.installation}</code></div>}
          {discovery?.installed && <div className="settings-row"><span>GuanYu profile</span>
            <strong>{discovery.profileExists ? 'Existing profile found' : 'Not configured'}</strong></div>}
          {discovery?.installed && discovery.profiles.trim() && (
            <details><summary>Existing Hermes profiles</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{discovery.profiles}</pre></details>
          )}
          {discovery && !discovery.installed && <p>
            Install Hermes from its <a href="https://hermes-agent.nousresearch.com/docs/getting-started/installation/" target="_blank" rel="noreferrer">official installation guide</a>,
            then select Refresh. ShellGuardian will never execute a downloaded install script automatically.
          </p>}
          {discovery?.installed && !discovery.profileExists && <>
            <p>GuanYu will be a separate Hermes profile. Existing Hermes profiles and credentials are not overwritten.</p>
            <label style={{display:'flex',gap:8,alignItems:'center'}}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}/>
              Create a new GuanYu profile
            </label>
            <button className="button primary" disabled={!confirmed || loading} onClick={() => void createProfile()}>
              Create GuanYu
            </button>
          </>}
          {discovery?.profileExists && <p>GuanYu is ready for Hermes provider and tool onboarding. Setup runs in a separate terminal so credentials stay outside ShellGuardian.</p>}
          <div className="drawer-actions">
            <button className="button" disabled={loading} onClick={() => void refresh()}>Refresh Hermes</button>
            {discovery?.profileExists && <button className="button primary" onClick={() => void setup()}>Configure GuanYu</button>}
          </div>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </>
      }
    </section>
  );
}
