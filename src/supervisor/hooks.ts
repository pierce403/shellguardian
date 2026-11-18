// Data hooks for the Supervisor views.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { HermesTranscriptRow, KanbanBoard, KanbanTask, KanbanTaskDetail } from '../types';

const NOT_RUNNING = 'not running';
/** True when an error says the agent's gateway is not running. */
export const gatewayDown = (error: string | null | undefined) =>
  Boolean(error && error.includes(NOT_RUNNING));

/** Async data with loading and error state. `reload(true)` refreshes quietly. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Loading from the first render: the effect below starts the load at once.
  const [loading, setLoading] = useState(true);
  const latest = useRef(load);
  latest.current = load;
  const generation = useRef(0);
  // A quiet reload shows no spinner and keeps the last data if it fails.
  const reload = useCallback(async (quiet = false) => {
    const mine = (generation.current += 1);
    if (!quiet) setLoading(true);
    try {
      const value = await latest.current();
      if (mine !== generation.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (mine !== generation.current) return;
      if (!quiet) setData(null);
      setError(api.errorMessage(e));
    } finally {
      if (mine === generation.current && !quiet) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    setData(null);
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  return { data, error, loading, reload };
}

/** Runs `tick` every `ms` while the page is visible. Ticks never overlap. */
export function useVisibleInterval(tick: () => void | Promise<void>, ms: number, enabled = true) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      void Promise.resolve()
        .then(() => latest.current())
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
}

/** Re-renders once a second while `active`, for elapsed-time labels. */
export function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

const REVISION_MS = 1500;
const FALLBACK_MS = 15_000;

/**
 * The kanban board, kept current without polling Hermes. A cheap change token
 * is checked every 1.5 seconds; tasks are refetched only when it moves. If the
 * token is unavailable the board falls back to a slow refetch.
 */
export function useBoard(archived: boolean) {
  const [boards, setBoards] = useState<KanbanBoard[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [tasks, setTasks] = useState<KanbanTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Bumps whenever the board content may have changed; details reload on it. */
  const [version, setVersion] = useState(0);
  const revision = useRef<string | null>(null);
  const signal = useRef(true);
  const generation = useRef(0);

  const active = chosen ?? boards?.find((b) => b.is_current)?.slug ?? boards?.[0]?.slug ?? null;

  const loadBoards = useCallback(async () => {
    try {
      setBoards(await api.kanbanBoards());
    } catch (e) {
      setBoards([]);
      setError(api.errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!active) return;
      const mine = (generation.current += 1);
      if (!quiet) setLoading(true);
      try {
        const next = await api.kanbanTasks(active, archived);
        if (mine !== generation.current) return;
        setTasks(next);
        setError(null);
        setVersion((n) => n + 1);
      } catch (e) {
        if (mine !== generation.current) return;
        setError(api.errorMessage(e));
      } finally {
        if (mine === generation.current && !quiet) setLoading(false);
      }
    },
    [active, archived],
  );

  useEffect(() => {
    setTasks(null);
    revision.current = null;
    signal.current = true;
    void refresh();
  }, [refresh]);

  useVisibleInterval(
    async () => {
      if (!active || !signal.current) return;
      try {
        const next = await api.kanbanRevision(active);
        if (revision.current !== null && revision.current !== next) await refresh(true);
        revision.current = next;
      } catch {
        // No change signal for this board: fall back to the slow refetch below.
        signal.current = false;
      }
    },
    REVISION_MS,
    Boolean(active),
  );
  useVisibleInterval(
    async () => {
      // Safety net (and the only refresh when there is no change signal).
      await refresh(true);
    },
    FALLBACK_MS,
    Boolean(active),
  );

  return {
    boards: boards ?? [],
    active,
    choose: setChosen,
    tasks: tasks ?? [],
    loaded: tasks !== null,
    loading,
    error,
    version,
    refresh: useCallback(async () => {
      await Promise.all([loadBoards(), refresh()]);
    }, [loadBoards, refresh]),
  };
}

/** One task's detail and worker log, reloaded when the board changes. */
export function useTask(board: string | null, id: string | null, version: number) {
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  const reload = useCallback(async () => {
    if (!board || !id) return;
    const key = `${board}/${id}`;
    const fresh = shown.current !== key;
    if (fresh) {
      shown.current = key;
      setDetail(null);
      setLog(null);
      setError(null);
    }
    try {
      const [task, text] = await Promise.all([
        api.kanbanTask(board, id),
        api.kanbanLog(board, id).catch(() => null),
      ]);
      if (shown.current !== key) return;
      setDetail(task);
      setLog(text);
      setError(null);
    } catch (e) {
      if (shown.current !== key) return;
      setError(api.errorMessage(e));
    }
  }, [board, id]);
  useEffect(() => {
    if (!id) {
      shown.current = null;
      setDetail(null);
      setLog(null);
      setError(null);
      return;
    }
    void reload();
  }, [reload, id, version]);
  return { detail, log, error, reload };
}

/** Details of every running task, for progress notes in the live list. */
export function useRunningDetails(board: string | null, tasks: KanbanTask[], version: number) {
  const [details, setDetails] = useState<Record<string, KanbanTaskDetail>>({});
  const ids = tasks
    .filter((task) => task.status === 'running')
    .map((task) => String(task.id))
    .join(',');
  useEffect(() => {
    if (!board || !ids) {
      setDetails({});
      return;
    }
    let cancelled = false;
    void Promise.all(ids.split(',').map((id) => api.kanbanTask(board, id).catch(() => null))).then(
      (found) => {
        if (cancelled) return;
        setDetails(
          Object.fromEntries(found.flatMap((task) => (task ? [[String(task.id), task]] : []))),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [board, ids, version]);
  return details;
}

/** The latest progress note a worker reported, if any. */
export function lastNote(task: KanbanTaskDetail | undefined): string | null {
  const events = task?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const note = events[index].detail?.note;
    if (note) return note;
  }
  return null;
}

/** The worker's session for a task's latest run, from its `owner_admitted` event. */
export function workerSession(task: KanbanTaskDetail): string | null {
  const events = task.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const id = events[index].detail?.session_id;
    if (events[index].kind === 'owner_admitted' && id) return id;
  }
  return null;
}

/** A session transcript loaded on demand. */
export function useTranscript() {
  const [rows, setRows] = useState<HermesTranscriptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const wanted = useRef<string | null>(null);
  const load = useCallback(async (profile: string, sessionId: string) => {
    const key = `${profile}/${sessionId}`;
    if (wanted.current !== key) setRows(null);
    wanted.current = key;
    setLoading(true);
    setError(null);
    try {
      const next = await api.hermesTranscript(profile, sessionId);
      if (wanted.current === key) setRows(next);
    } catch (e) {
      if (wanted.current === key) setError(api.errorMessage(e));
    } finally {
      if (wanted.current === key) setLoading(false);
    }
  }, []);
  const clear = useCallback(() => {
    wanted.current = null;
    setRows(null);
    setError(null);
    setLoading(false);
  }, []);
  return { rows, error, loading, load, clear };
}
