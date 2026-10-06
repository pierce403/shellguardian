import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, Download, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import * as api from './api';
import type { AppUpdateStatus } from './types';

export function useAppUpdates() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void api
        .getAppUpdate()
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {
          // An IPC failure is unknown, never a claim that updates are current.
          if (alive) setStatus(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return { status, setStatus };
}

export default function AppUpdates({
  status,
  onStatus,
  onToast,
}: {
  status: AppUpdateStatus | null;
  onStatus: (value: AppUpdateStatus) => void;
  onToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const operate = useCallback(
    async (work: () => Promise<AppUpdateStatus>) => {
      setBusy(true);
      try {
        onStatus(await work());
      } catch (error) {
        onToast(api.errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [onStatus, onToast],
  );
  const working = busy || ['checking', 'downloading', 'installing'].includes(status?.phase ?? '');
  const enabledHere = api.desktopMode || api.previewMode;
  const phaseText =
    {
      checking: 'Checking ShellGuardian releases…',
      downloading: 'Downloading and verifying the update…',
      installing: 'Installing the verified update…',
      ready: `ShellGuardian ${status?.latestVersion} is ready`,
      available: `ShellGuardian ${status?.latestVersion} is available`,
      current: 'ShellGuardian is up to date',
      unavailable: 'ShellGuardian update unavailable',
      unsupported: api.previewMode
        ? 'Sample settings only'
        : 'Updates require an installed release',
      idle: status?.enabled ? 'Automatic updates are on' : 'Automatic updates are off',
    }[status?.phase ?? ''] ?? 'Update status unavailable';

  return (
    <section className="settings-card app-update-card" aria-label="ShellGuardian updates">
      <div className="settings-heading">
        <div className="provider-icon">
          <ShieldCheck size={23} />
        </div>
        <div>
          <h3>ShellGuardian</h3>
          <p>Keep your control room current.</p>
        </div>
        <span className="version-pill">{status ? `v${status.appVersion}` : 'Unknown'}</span>
      </div>
      <div className="auto-update-row">
        <div>
          <label htmlFor="auto-update">Automatic updates</label>
          <p>
            Download signed ShellGuardian updates in the background and install on normal close.
            OpenShell is never upgraded automatically.
          </p>
        </div>
        <input
          id="auto-update"
          type="checkbox"
          role="switch"
          aria-label="Automatic ShellGuardian updates"
          checked={status?.enabled ?? false}
          disabled={!status || busy || !enabledHere || status.phase === 'installing'}
          onChange={(event) => {
            const enabled = event.target.checked;
            void operate(() => api.setAutoUpdate(enabled));
          }}
        />
      </div>
      <div className="update-box" role="status">
        {working ? <LoaderCircle size={21} className="spin" /> : <CheckCheck size={21} />}
        <div>
          <h4>{phaseText}</h4>
          <p>
            {status?.error ??
              (api.previewMode
                ? 'Sample result only. No app update is downloaded or installed.'
                : status?.phase === 'ready'
                  ? status.enabled
                    ? 'Installs when you close ShellGuardian. You can also restart now.'
                    : 'Automatic updates are off. Install this verified download only when you choose.'
                  : 'Checks at launch and every six hours while open. Your opt-out is saved in one small preferences file.')}
          </p>
        </div>
      </div>
      <div className="settings-buttons">
        <button
          className="button"
          disabled={working || !enabledHere || (!status?.supported && !api.previewMode)}
          onClick={() => {
            void operate(() => api.checkAppUpdate());
          }}
        >
          <RefreshCw size={16} />
          Check ShellGuardian
        </button>
        {status?.phase === 'available' && (
          <button
            className="button primary"
            disabled={working}
            onClick={() => {
              void operate(() => api.checkAppUpdate(true));
            }}
          >
            <Download size={16} />
            Download update
          </button>
        )}
        {status?.phase === 'ready' && (
          <button
            className="button primary"
            disabled={working}
            onClick={() => {
              if (api.previewMode) {
                onToast('Sample preview: restart simulated. No app was changed.');
                return;
              }
              setBusy(true);
              void api.restartForUpdate().catch((error) => {
                onToast(api.errorMessage(error));
                setBusy(false);
              });
            }}
          >
            <RefreshCw size={16} />
            Restart to update
          </button>
        )}
      </div>
    </section>
  );
}
