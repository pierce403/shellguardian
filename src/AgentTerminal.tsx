import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Bot, LoaderCircle, Terminal as TerminalIcon, X } from 'lucide-react';
import * as api from './api';
import type { AgentTerminalTarget } from './types';
import '@xterm/xterm/css/xterm.css';
import './agent-terminal.css';

const MAX_WRITE_BYTES = 16 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** Split pasted text without splitting a UTF-8 code point or issuing concurrent writes. */
function inputChunks(data: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of data) {
    const length = encoder.encode(character).length;
    if (bytes + length > MAX_WRITE_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** A session-scoped terminal, never a host command runner or a stored conversation. */
export default function AgentTerminal({
  target,
  onClose,
}: {
  target: AgentTerminalTarget;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeSessionRef = useRef<() => Promise<void>>(async () => {});
  const [closing, setClosing] = useState(false);
  const [phase, setPhase] = useState<'opening' | 'connected' | 'exited' | 'error'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const isAgent = target.kind === 'agent';
  const preview = api.previewMode;

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (preview) return;
    let disposed = false;
    let sessionId: string | null = null;
    let finished = false;
    let writing = false;
    let resizing = false;
    let queuedBytes = 0;
    let queue: string[] = [];
    let pendingSize: { cols: number; rows: number } | null = null;
    let resizeTimer: number | undefined;
    let readTimer: number | undefined;
    let releaseReadDelay: (() => void) | undefined;
    let releaseRender: (() => void) | undefined;
    let closePromise: Promise<void> | null = null;
    const closeNative = (id: string) => {
      if (!closePromise)
        closePromise = api.closeAgentTerminal(id).catch((cause: unknown) => {
          closePromise = null;
          throw cause;
        });
      return closePromise;
    };
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Liberation Mono', Consolas, monospace",
      fontSize: 14,
      scrollback: 2000,
      screenReaderMode: true,
      allowProposedApi: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Remote output cannot read/write the system clipboard or activate hyperlink targets.
    const clipboard = term.parser.registerOscHandler(52, () => true);
    const links = term.parser.registerOscHandler(8, () => true);
    term.open(containerRef.current!);
    const applyTheme = () => {
      const style = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: style.getPropertyValue('--surface').trim(),
        foreground: style.getPropertyValue('--ink').trim(),
        cursor: style.getPropertyValue('--accent').trim(),
        selectionBackground: style.getPropertyValue('--line-strong').trim(),
      };
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const fail = (cause: unknown) => {
      if (disposed || finished) return;
      finished = true;
      queue = [];
      queuedBytes = 0;
      term.options.disableStdin = true;
      setError(api.errorMessage(cause));
      setPhase('error');
      if (sessionId) void closeNative(sessionId).catch(() => {});
    };
    const flushInput = async () => {
      if (writing || !sessionId) return;
      writing = true;
      try {
        while (queue.length && !disposed && !finished) {
          const chunk = queue.shift()!;
          await api.writeAgentTerminal(sessionId, chunk);
          queuedBytes -= encoder.encode(chunk).length;
        }
      } catch (cause) {
        queue = [];
        queuedBytes = 0;
        if (!disposed && !finished)
          setInputNotice(
            `${api.errorMessage(cause)} Input may be partial. Check the terminal before typing or pasting again.`,
          );
      } finally {
        writing = false;
      }
    };
    const input = term.onData((data) => {
      if (disposed || finished || !sessionId) return;
      const bytes = encoder.encode(data).length;
      if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
        setInputNotice('Input queue is full. Wait for pending input, then paste again.');
        return;
      }
      setInputNotice(null);
      queuedBytes += bytes;
      queue.push(...inputChunks(data));
      void flushInput();
    });
    const flushResize = async () => {
      if (resizing || !sessionId) return;
      resizing = true;
      try {
        while (pendingSize && !disposed && !finished) {
          const size = pendingSize;
          pendingSize = null;
          await api.resizeAgentTerminal(sessionId, size.cols, size.rows);
        }
      } catch (cause) {
        fail(cause);
      } finally {
        resizing = false;
      }
    };
    const resize = () => {
      if (disposed) return;
      const proposed = fit.proposeDimensions();
      if (!proposed) return;
      const cols = Math.max(20, Math.min(400, proposed.cols));
      const rows = Math.max(5, Math.min(200, proposed.rows));
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      pendingSize = { cols, rows };
      void flushResize();
    };
    resize();
    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 80);
    });
    resizeObserver.observe(containerRef.current!);
    closeSessionRef.current = async () => {
      finished = true;
      queue = [];
      term.options.disableStdin = true;
      if (sessionId) await closeNative(sessionId);
    };

    const poll = async (id: string) => {
      try {
        while (!disposed && !finished) {
          const result = await api.readAgentTerminal(id);
          if (disposed || finished) return;
          if (
            !Array.isArray(result.data) ||
            result.data.length > 65536 ||
            result.data.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
          )
            throw new Error('OpenShell returned an invalid terminal output frame.');
          if (result.data.length) {
            await new Promise<void>((resolve) => {
              releaseRender = resolve;
              term.write(new Uint8Array(result.data), () => {
                releaseRender = undefined;
                resolve();
              });
            });
          }
          if (disposed || finished) return;
          if (result.error) throw new Error(result.error);
          if (result.exited) {
            finished = true;
            queue = [];
            term.options.disableStdin = true;
            setExitCode(result.exitCode);
            setPhase('exited');
            return;
          }
          await new Promise<void>((resolve) => {
            releaseReadDelay = resolve;
            readTimer = window.setTimeout(() => {
              releaseReadDelay = undefined;
              resolve();
            }, 50);
          });
        }
      } catch (cause) {
        fail(cause);
      }
    };
    // React's development remount must not launch a second real remote process.
    void Promise.resolve()
      .then(() => (disposed ? null : api.openAgentTerminal(target, term.cols, term.rows)))
      .then((session) => {
        if (!session) return;
        if (disposed) {
          void closeNative(session.id).catch(() => {});
          return;
        }
        sessionId = session.id;
        setPhase('connected');
        term.options.disableStdin = false;
        term.focus();
        void flushResize();
        void poll(session.id);
      })
      .catch(fail);

    return () => {
      disposed = true;
      queue = [];
      window.clearTimeout(resizeTimer);
      window.clearTimeout(readTimer);
      releaseReadDelay?.();
      releaseRender?.();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      input.dispose();
      clipboard.dispose();
      links.dispose();
      term.dispose();
      if (sessionId) void closeNative(sessionId).catch(() => {});
    };
  }, [
    target.scope.gateway,
    target.scope.workspace,
    target.scope.connectionId,
    target.name,
    target.kind,
    preview,
  ]);

  return (
    <dialog
      ref={dialogRef}
      className="agent-terminal-dialog"
      aria-label={`${isAgent ? 'Talk to agent' : 'Terminal'}: ${target.name}`}
      onCancel={(event) => event.preventDefault()}
    >
      <header className="agent-terminal-header">
        <div>
          <div className="eyebrow">{isAgent ? 'AGENT SESSION' : 'SANDBOX TERMINAL'}</div>
          <h2>
            {isAgent ? <Bot size={24} /> : <TerminalIcon size={24} />}
            {target.name}
          </h2>
        </div>
        <button
          className="button"
          disabled={closing}
          onClick={() => {
            setClosing(true);
            void closeSessionRef
              .current()
              .then(onClose)
              .catch((cause: unknown) => {
                setError(api.errorMessage(cause));
                setPhase('error');
                setClosing(false);
              });
          }}
        >
          <X size={16} />
          {isAgent ? 'Detach agent' : 'Close terminal'}
        </button>
      </header>
      <div className="agent-terminal-context">
        <span>
          Gateway <strong>{target.scope.gateway}</strong>
        </span>
        <span>
          Workspace <strong>{target.scope.workspace}</strong>
        </span>
        <span>
          {target.scope.connectionId ? 'Via selected SSH connection' : 'Direct gateway connection'}
        </span>
      </div>
      <p className="agent-terminal-description">
        {isAgent
          ? 'Connect to the sandbox’s main process. If it is an interactive agent, talk to it here. Detach leaves that process running.'
          : 'A new interactive shell inside this sandbox, not on your host. Commands can change sandbox files and processes.'}{' '}
        Input goes directly to the session, including Ctrl+C. Output stays in memory and may contain
        sensitive information.
      </p>
      {preview ? (
        <div className="terminal-preview-note">
          <TerminalIcon size={30} />
          <h3>Interactive session preview</h3>
          <p>This sample is not connected. No process is attached and no commands can run.</p>
          <p>
            Use the desktop app with a running OpenShell sandbox to{' '}
            {isAgent ? 'talk to its agent' : 'open a terminal'}.
          </p>
        </div>
      ) : (
        <>
          <div className="agent-terminal-status" role="status">
            {phase === 'opening' && (
              <>
                <LoaderCircle size={15} className="spin" />
                Connecting to OpenShell…
              </>
            )}
            {phase === 'connected' &&
              'Terminal open. Wait for the agent or shell prompt before typing.'}
            {phase === 'exited' &&
              `Session ended${exitCode === null ? '.' : ` with exit code ${exitCode}.`}`}
            {phase === 'error' && 'Session unavailable. Close this window before trying again.'}
          </div>
          {error && (
            <p className="form-error terminal-error" role="alert">
              {error}
            </p>
          )}
          {inputNotice && (
            <p className="form-error terminal-error" role="alert">
              {inputNotice}
            </p>
          )}
          <div
            ref={containerRef}
            className="agent-terminal-surface"
            aria-label="Interactive terminal"
          />
        </>
      )}
    </dialog>
  );
}
