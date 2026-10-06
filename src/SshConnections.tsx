import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Globe2, LoaderCircle, LockKeyhole, RefreshCw, Unplug } from 'lucide-react';
import * as api from './api';
import type { Gateway, Selection, SshConnectRequest, SshConnection } from './types';
import './ssh-connections.css';

export function useSshConnections() {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changing = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    let alive = true;
    let polling = false;
    async function refresh() {
      if (changing.current || polling) return;
      polling = true;
      const requestRevision = revision.current;
      try {
        const result = await api.getSshConnections();
        if (alive && requestRevision === revision.current) setConnections(result);
      } catch (error) {
        if (alive && requestRevision === revision.current) setError(api.errorMessage(error));
      } finally {
        polling = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, []);

  const connect = useCallback(async (request: SshConnectRequest) => {
    if (changing.current) throw new Error('Wait for the current SSH connection request.');
    changing.current = true;
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await api.connectSsh(request);
      setConnections((current) => [...current.filter((item) => item.id !== result.id), result]);
      return result;
    } catch (error) {
      setError(api.errorMessage(error));
      throw error;
    } finally {
      revision.current += 1;
      changing.current = false;
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async (connectionId: string) => {
    if (changing.current) throw new Error('Wait for the current SSH connection request.');
    changing.current = true;
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      await api.disconnectSsh(connectionId);
      setConnections((current) => current.filter((item) => item.id !== connectionId));
    } catch (error) {
      setError(api.errorMessage(error));
      throw error;
    } finally {
      revision.current += 1;
      changing.current = false;
      setBusy(false);
    }
  }, []);
  return { connections, busy, error, connect, disconnect };
}

type ConnectionController = ReturnType<typeof useSshConnections>;

function port(value: string, optional = false): number | null {
  if (optional && !value.trim()) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Ports must be whole numbers between 1 and 65535.');
  }
  return Number(value);
}

export default function SshConnections({
  gateways,
  selection,
  controller,
  mutationBusy,
  onSelect,
  onDisconnected,
  onToast,
}: {
  gateways: Gateway[];
  selection: Selection;
  controller: ConnectionController;
  mutationBusy: boolean;
  onSelect: (connection: SshConnection) => void;
  onDisconnected: (connectionId: string) => void;
  onToast: (message: string) => void;
}) {
  const profiles = gateways.filter((gateway) => gateway.auth.toLowerCase() === 'mtls');
  const [gateway, setGateway] = useState('');
  const [destination, setDestination] = useState('');
  const [remotePort, setRemotePort] = useState('17670');
  const [sshPort, setSshPort] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const enabled = api.desktopMode || api.previewMode;
  const disabled = controller.busy || mutationBusy || !enabled;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      if (!profiles.some((profile) => profile.name === gateway)) {
        throw new Error('Choose the OpenShell authentication profile for this server.');
      }
      const host = destination.trim();
      if (!host || host.startsWith('-') || /\s/.test(host)) {
        throw new Error('Enter an SSH host, user@host, or configured SSH alias.');
      }
      const connection = await controller.connect({
        gateway,
        destination: host,
        remotePort: port(remotePort)!,
        sshPort: port(sshPort, true),
      });
      onSelect(connection);
      onToast(
        api.previewMode
          ? 'Sample preview: SSH connection simulated. No server was contacted.'
          : `Connected to ${connection.destination} over SSH.`,
      );
    } catch (error) {
      setFormError(api.errorMessage(error));
    }
  }

  async function disconnect(connection: SshConnection) {
    setFormError(null);
    try {
      await controller.disconnect(connection.id);
      onDisconnected(connection.id);
      onToast(
        api.previewMode
          ? 'Sample preview: SSH disconnect simulated.'
          : `Disconnected from ${connection.destination}.`,
      );
    } catch (error) {
      setFormError(api.errorMessage(error));
    }
  }

  async function reconnect(connection: SshConnection) {
    setFormError(null);
    setGateway(connection.gateway);
    setDestination(connection.destination);
    setRemotePort(String(connection.remotePort));
    setSshPort(connection.sshPort === null ? '' : String(connection.sshPort));
    try {
      await controller.disconnect(connection.id);
      const replacement = await controller.connect({
        gateway: connection.gateway,
        destination: connection.destination,
        remotePort: connection.remotePort,
        sshPort: connection.sshPort,
      });
      onSelect(replacement);
      onToast(`Reconnected to ${replacement.destination} over SSH.`);
    } catch (error) {
      setFormError(api.errorMessage(error));
    }
  }

  return (
    <section className="settings-card ssh-card" aria-labelledby="ssh-title">
      <div className="settings-heading">
        <div className="provider-icon">
          <Globe2 size={23} />
        </div>
        <div>
          <h3 id="ssh-title">Connect over SSH</h3>
          <p>Reach an OpenShell server on another machine.</p>
        </div>
        <span className="small-tag">This session</span>
      </div>
      {controller.connections.length > 0 && (
        <div className="ssh-session-list" aria-label="SSH connections">
          {controller.connections.map((connection) => (
            <article
              className="ssh-session"
              key={connection.id}
              aria-label={`SSH connection to ${connection.destination}`}
            >
              <div className="ssh-session-summary">
                <LockKeyhole size={18} />
                <div>
                  <strong>{connection.destination}</strong>
                  <span>
                    {connection.gateway} · OpenShell port {connection.remotePort}
                  </span>
                </div>
                <span
                  className={`status ${connection.status === 'connected' ? 'good' : 'attention'}`}
                >
                  {connection.status === 'connected' ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              {connection.error && <p className="form-error">{connection.error}</p>}
              <div className="ssh-session-actions">
                {connection.status === 'connected' ? (
                  <button
                    className="button"
                    disabled={disabled || selection.connectionId === connection.id}
                    onClick={() => onSelect(connection)}
                  >
                    {selection.connectionId === connection.id ? (
                      <>
                        <Check size={15} />
                        In use
                      </>
                    ) : (
                      'Use connection'
                    )}
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={disabled}
                    onClick={() => void reconnect(connection)}
                  >
                    <RefreshCw size={15} />
                    Reconnect
                  </button>
                )}
                <button
                  className="button"
                  disabled={disabled}
                  onClick={() => void disconnect(connection)}
                >
                  <Unplug size={15} />
                  {connection.status === 'connected' ? 'Disconnect' : 'Remove'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {!enabled && (
        <p className="muted-copy">Open the desktop app to connect to a remote server.</p>
      )}
      <form className="ssh-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field-label" htmlFor="ssh-destination">
          SSH host
        </label>
        <input
          id="ssh-destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder="user@server or SSH alias"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        <label className="field-label" htmlFor="ssh-gateway">
          OpenShell authentication
        </label>
        <select
          id="ssh-gateway"
          value={gateway}
          disabled={disabled}
          onChange={(event) => {
            setGateway(event.target.value);
            const profile = profiles.find((profile) => profile.name === event.target.value);
            if (profile?.remote_host && !destination) setDestination(profile.remote_host);
          }}
        >
          <option value="">Choose this server’s OpenShell profile</option>
          {profiles.map((profile) => (
            <option value={profile.name} key={profile.name}>
              {profile.name}
            </option>
          ))}
        </select>
        <p className="ssh-help">
          Uses the server’s mTLS credentials already configured in OpenShell and your SSH key or
          agent.
        </p>
        <details className="ssh-advanced">
          <summary>Port settings</summary>
          <div className="ssh-port-fields">
            <div>
              <label className="field-label" htmlFor="ssh-remote-port">
                OpenShell port
              </label>
              <input
                id="ssh-remote-port"
                inputMode="numeric"
                value={remotePort}
                disabled={disabled}
                onChange={(event) => setRemotePort(event.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="ssh-port">
                SSH port (optional)
              </label>
              <input
                id="ssh-port"
                inputMode="numeric"
                value={sshPort}
                disabled={disabled}
                placeholder="SSH config or 22"
                onChange={(event) => setSshPort(event.target.value)}
              />
            </div>
          </div>
        </details>
        {(formError || controller.error) && (
          <p className="form-error" role="alert">
            {formError || controller.error}
          </p>
        )}
        <button
          className="button primary"
          type="submit"
          disabled={disabled || profiles.length === 0}
        >
          {controller.busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <LockKeyhole size={16} />
          )}
          {controller.busy
            ? 'Working…'
            : api.previewMode
              ? 'Simulate SSH connection'
              : 'Connect to server'}
        </button>
      </form>
      {profiles.length === 0 && (
        <p className="muted-copy">
          Set up the remote server’s mTLS profile in OpenShell first. It will appear here when you
          refresh.
        </p>
      )}
      <p className="muted-copy footnote">
        For a new SSH host, verify its host key once in your terminal. Connections close when you
        disconnect or quit ShellGuardian.
      </p>
      {api.previewMode && (
        <p className="muted-copy">Sample preview. SSH connections here are simulated.</p>
      )}
    </section>
  );
}
