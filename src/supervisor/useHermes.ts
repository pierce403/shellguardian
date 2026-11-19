// Shared, in-memory Hermes state for the Supervisor page and the sidebar status.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { ChatProgress, ChatStep, ChatTokens, HermesDiscovery, HermesProfile } from '../types';

export const DEFAULT_SUPERVISOR = 'guanyu';
const REFRESH_INTERVAL_MS = 60_000;
const PROGRESS_INTERVAL_MS = 400;

export type ChatMessage = {
  id: number;
  role: 'user' | 'agent' | 'error';
  text: string;
  at: number;
  /** Tool calls the agent made while writing this reply. */
  steps?: ChatStep[];
  /** Running token totals for the conversation, as Hermes reports them. */
  tokens?: ChatTokens | null;
  durationMs?: number | null;
  /** The turn ended early: by you, or by the time limit when `timedOut`. */
  stopped?: boolean;
  timedOut?: boolean;
  /** False when the view detached but Hermes did not confirm the turn ended. */
  stopConfirmed?: boolean;
  /** Hermes replied but said the turn did not complete. */
  incomplete?: boolean;
};
export type Conversation = { sessionId: string | null; messages: ChatMessage[] };

export function useHermes() {
  const available = api.desktopMode || api.previewMode;
  const [discovery, setDiscovery] = useState<HermesDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  // Unsent text per agent, kept here so it survives switching tabs.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const nextId = useRef(1);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    try {
      setDiscovery(await api.discoverHermes());
      setError(null);
    } catch (e) {
      setError(api.errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
    if (!available) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [available, refresh]);

  // While a turn runs, poll its live progress (reply text so far and tool steps).
  useEffect(() => {
    if (!sending) {
      setProgress(null);
      return;
    }
    let alive = true;
    const poll = () =>
      void api
        .hermesChatProgress()
        .then((next) => {
          if (alive && next.active) setProgress(next);
        })
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, PROGRESS_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [sending]);

  const profiles = discovery?.profiles ?? [];
  const supervisor: HermesProfile | null =
    profiles.find((p) => p.name === chosen) ??
    profiles.find((p) => p.name === DEFAULT_SUPERVISOR) ??
    profiles.find((p) => p.active) ??
    profiles[0] ??
    null;

  const append = useCallback((profile: string, message: Omit<ChatMessage, 'id' | 'at'>) => {
    const entry: ChatMessage = { ...message, id: nextId.current++, at: Date.now() };
    setConversations((all) => {
      const current = all[profile] ?? { sessionId: null, messages: [] };
      return { ...all, [profile]: { ...current, messages: [...current.messages, entry] } };
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!supervisor || busy.current) return false;
      const profile = supervisor.name;
      const sessionId = conversations[profile]?.sessionId ?? null;
      busy.current = true;
      append(profile, { role: 'user', text });
      setSending(profile);
      try {
        const reply = await api.hermesChat(profile, text, sessionId);
        setConversations((all) => {
          const current = all[profile] ?? { sessionId: null, messages: [] };
          return {
            ...all,
            [profile]: { ...current, sessionId: reply.sessionId ?? current.sessionId },
          };
        });
        append(profile, {
          role: 'agent',
          text: reply.reply,
          steps: reply.steps,
          tokens: reply.tokens,
          durationMs: reply.durationMs,
          stopped: reply.stopped,
          timedOut: reply.timedOut,
          stopConfirmed: reply.stopConfirmed,
          incomplete: reply.incomplete,
        });
      } catch (e) {
        append(profile, { role: 'error', text: api.errorMessage(e) });
      } finally {
        busy.current = false;
        setSending(null);
        // A turn starts the agent's gateway if it was stopped: show that now
        // instead of at the next scheduled check.
        void refresh();
      }
      return true;
    },
    [append, conversations, refresh, supervisor],
  );

  const stop = useCallback(() => {
    void api.stopHermesChat().catch(() => undefined);
    setProgress((current) => (current ? { ...current, stopping: true } : current));
  }, []);

  const resetConversation = useCallback((profile: string) => {
    setConversations((all) => ({ ...all, [profile]: { sessionId: null, messages: [] } }));
  }, []);

  return {
    available,
    discovery,
    profiles,
    loading,
    error,
    refresh,
    supervisor,
    choose: setChosen,
    conversation: supervisor ? conversations[supervisor.name] : undefined,
    /** True while the selected agent is answering. */
    sending: Boolean(supervisor && sending === supervisor.name),
    /** True while any agent is answering (only one turn runs at a time). */
    busy: sending !== null,
    /** The agent that is answering, when it is not the selected one. */
    busyWith: sending !== null && sending !== supervisor?.name ? sending : null,
    draft: supervisor ? (drafts[supervisor.name] ?? '') : '',
    setDraft: useCallback(
      (text: string) => {
        const name = supervisor?.name;
        if (name) setDrafts((all) => ({ ...all, [name]: text }));
      },
      [supervisor?.name],
    ),
    progress: supervisor && sending === supervisor.name ? progress : null,
    send,
    stop,
    resetConversation,
  };
}
export type Hermes = ReturnType<typeof useHermes>;
