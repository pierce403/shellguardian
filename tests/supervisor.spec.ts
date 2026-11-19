import { expect, test, type Page } from '@playwright/test';

// The sample preview is illustrative only: a chat turn takes about a second,
// and an assigned task starts after ~1 s and finishes after ~4 s.

async function openSupervisor(page: Page) {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Supervisor', level: 1 })).toBeVisible();
}
const tab = (page: Page, name: string) =>
  page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();

test('sample chat streams progress, keeps drafts, and can be stopped', async ({ page }) => {
  await openSupervisor(page);
  await expect(
    page.getByText(
      'Sample preview only. No Hermes agent is contacted and replies are illustrative.',
    ),
  ).toBeVisible();
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  await expect(chat.getByRole('heading', { name: 'Talk to guanyu' })).toBeVisible();
  await expect(chat).toContainText('sample/model via sample-plan');
  const box = chat.getByLabel('Message guanyu');

  // A suggestion fills the composer; it never sends on its own.
  await chat.getByRole('button', { name: 'What is on the board right now?' }).click();
  await expect(box).toHaveValue('What is on the board right now?');
  await expect(box).toBeFocused();
  await box.fill('line one');
  await box.press('Shift+Enter');
  await expect(box).toHaveValue('line one\n');

  await box.fill('How are my agents?');
  await box.press('Enter');
  await expect(chat.getByText('How are my agents?')).toBeVisible();
  await expect(chat.getByText('guanyu is working')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Stop' })).toBeVisible();
  // A second message while one is running is kept as a draft, not sent or lost.
  await box.fill('second thought');
  await box.press('Enter');
  await expect(box).toHaveValue('second thought');
  await expect(
    chat.getByText('Sample preview reply 1. No Hermes agent was contacted.'),
  ).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(chat.getByText('guanyu is working')).toHaveCount(0);
  await expect(chat).toContainText('This conversation so far: 18k tokens in, 96 out');

  // Stop ends the turn and keeps whatever had arrived.
  await box.fill('Tell me a long story');
  await box.press('Enter');
  await chat.getByRole('button', { name: 'Stop' }).click();
  await expect(chat.getByText('stopped by you')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

  await chat.getByRole('button', { name: 'New conversation' }).click();
  await expect(chat.getByText('How are my agents?')).toHaveCount(0);
  await expect(chat.getByText('Ask guanyu for work')).toBeVisible();

  // An unsent draft survives a visit to another tab.
  await box.fill('half-written thought');
  await tab(page, 'Board');
  await tab(page, 'Chat');
  await expect(page.getByLabel('Message guanyu')).toHaveValue('half-written thought');
});

test('a chat request becomes a task you can follow from start to finish', async ({ page }) => {
  await openSupervisor(page);
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  const box = chat.getByLabel('Message guanyu');
  await box.fill('Create a task to check the gateway logs');
  await box.press('Enter');
  // The supervisor's tool calls show up as plain-language steps while it works.
  await expect(chat.getByText('Reading a skill: shellguardian-supervisor')).toBeVisible();
  await expect(
    chat.getByText('Creating a task: Create a task to check the gateway logs'),
  ).toBeVisible();
  await expect(
    chat.getByText('Sample preview: created a task for guanyu.', { exact: false }),
  ).toBeVisible();
  await expect(chat.getByText('2 steps')).toBeVisible();

  // The task appears under the reply that created it, and in the rail.
  await expect(
    chat.getByRole('list', { name: 'Tasks created by this reply' }).getByRole('button'),
  ).toContainText('Create a task to check the gateway logs');
  const mine = page.getByRole('region', { name: 'Tasks from this conversation' });
  await expect(mine).toContainText('Create a task to check the gateway logs');
  const work = page.getByRole('region', { name: 'Work in progress' });
  await expect(work.getByRole('button', { name: /Create a task to check/ })).toBeVisible({
    timeout: 8000,
  });
  await expect(work).toContainText('Sample step 1 of 2');
  await expect(page.getByRole('tab', { name: /^Board/ })).toContainText('1');

  // The task opens in a drawer without leaving the chat.
  await work.getByRole('button', { name: /Create a task to check/ }).click();
  const task = page.getByRole('dialog', { name: 'Task: Create a task to check the gateway logs' });
  await expect(task.getByText('Running', { exact: true })).toBeVisible();
  const timeline = task.getByLabel('Task timeline');
  await expect(timeline).toContainText('Picked up');
  await expect(timeline).toContainText('Sample step 1 of 2');
  // It finishes on its own and the open drawer follows along.
  await expect(task.getByText('Done', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(timeline).toContainText('Completed');
  await expect(task.getByRole('region', { name: 'Result' })).toContainText(
    'Sample preview result. No agent ran.',
  );
  await task.getByRole('button', { name: 'Close task' }).click();
  await expect(task).toHaveCount(0);
  await expect(work).toContainText('Nothing is running.');
  await expect(mine.getByText('Done', { exact: true })).toBeVisible();
});

test('board shows every column, creates tasks, and follows them live', async ({ page }) => {
  await openSupervisor(page);
  await tab(page, 'Board');
  const board = page.getByRole('list', { name: 'Kanban board' });
  const column = (name: string) => board.getByRole('listitem', { name: `${name} tasks` });
  await expect(column('To do')).toContainText('Draft the weekly agent report');
  await expect(column('Ready')).toContainText('Summarize overnight sandbox activity');
  await expect(column('Running')).toContainText('Nothing here');
  await expect(column('Blocked')).toContainText('Rotate the staging access token');
  await expect(column('Done')).toContainText('Review provider access for scout');
  await expect(page.getByLabel('Board summary')).toContainText('0 running');

  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByRole('button', { name: 'Create task' })).toBeDisabled();
  await dialog.getByLabel('Title').fill('Check sandbox policies');
  await dialog.getByLabel('What should be done').fill('List each sandbox and its policy version.');
  await expect(dialog).toContainText('An unassigned task waits in To do');
  await dialog.getByLabel('Assign to').selectOption('guanyu');
  await expect(dialog).toContainText('guanyu starts this task');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(dialog).toHaveCount(0);

  // The board updates itself: the task starts, reports progress, and finishes.
  await expect(column('Running')).toContainText('Check sandbox policies', { timeout: 8000 });
  await expect(column('Running')).toContainText('Sample step 1 of 2');
  await expect(page.getByLabel('Board summary')).toContainText('1 running');
  await expect(column('Done')).toContainText('Check sandbox policies', { timeout: 10_000 });
  await expect(column('Running')).toContainText('Nothing here');

  await board.getByRole('button', { name: /Review provider access for scout/ }).click();
  const task = page.getByRole('dialog', { name: 'Task: Review provider access for scout' });
  await expect(task).toContainText('Assigned to guanyu');
  await expect(task.getByLabel('Task timeline')).toContainText('Created');
  await expect(task.getByLabel('Task timeline')).toContainText('Completed');
  await expect(task.getByRole('region', { name: 'Result' })).toContainText(
    'scout only needs read access',
  );
  await task.getByRole('button', { name: 'Show what guanyu did' }).click();
  await expect(task.getByLabel('Worker transcript')).toContainText('Sample answer for');
  await expect(task.getByLabel('Worker transcript')).toContainText('Reading a task');
  await task.getByText('Worker log').click();
  await expect(task.getByLabel('Worker log')).toContainText('Sample preview log');
  await task.getByLabel('Comment', { exact: true }).fill('Looks good');
  await task.getByRole('button', { name: 'Comment' }).click();
  await expect(task.getByRole('region', { name: 'Comments' })).toContainText('Looks good');
  await expect(task.getByLabel('Comment', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(task).toHaveCount(0);

  // A blocked task says why.
  await board.getByRole('button', { name: /Rotate the staging access token/ }).click();
  const blocked = page.getByRole('dialog', { name: 'Task: Rotate the staging access token' });
  await expect(blocked.getByLabel('Task timeline')).toContainText(
    'no credential for the staging host is attached',
  );
});

test('agents tab sets providers, keys, models, and supervisor duties', async ({ page }) => {
  await openSupervisor(page);
  await tab(page, 'Agents');
  const agents = page.getByRole('list', { name: 'Hermes agents' });
  await expect(agents.getByRole('listitem', { name: 'guanyu' })).toContainText('Gateway running');
  await expect(agents.getByRole('listitem', { name: 'guanyu' })).toContainText('Selected');
  await expect(agents.getByRole('listitem', { name: 'default' })).toContainText(
    'No provider chosen',
  );
  await expect(agents.getByRole('listitem', { name: 'default' })).toContainText('Gateway stopped');

  const panel = page.getByRole('region', { name: 'Model and provider for guanyu' });
  await expect(panel).toContainText('Using sample/model via Sample coding plan');
  // Usage limits come from the providers themselves.
  await expect(panel.getByRole('meter', { name: 'Sample coding plan Weekly' })).toHaveAttribute(
    'aria-valuetext',
    '13% used',
  );
  await expect(
    panel.getByRole('meter', { name: 'Sample assistant plan Current session' }),
  ).toHaveAttribute('aria-valuenow', '15');
  await expect(panel.getByRole('button', { name: 'Use this model' })).toBeDisabled();

  // An API-key provider: the key goes to Hermes and never stays in the page.
  await panel.getByLabel('Provider', { exact: true }).selectOption('sample-keys');
  await expect(panel.getByLabel('Model', { exact: true })).toBeDisabled();
  const key = panel.getByLabel('API key for Sample API-key provider');
  await key.fill('sample-not-a-real-key');
  await panel.getByRole('button', { name: 'Save key' }).click();
  await expect(panel).toContainText('Hermes saved the key for Sample API-key provider.');
  await expect(page.getByText('sample-not-a-real-key')).toHaveCount(0);
  await panel.getByLabel('Model', { exact: true }).selectOption('sample/keyed');
  await panel.getByRole('button', { name: 'Use this model' }).click();
  await expect(panel).toContainText('guanyu now uses sample/keyed.');
  await expect(agents.getByRole('listitem', { name: 'guanyu' })).toContainText(
    'sample/keyed via sample-keys',
  );

  // Hermes may ask to confirm an expensive model.
  await panel.getByLabel('Provider', { exact: true }).selectOption('sample-plan');
  await panel.getByLabel('Model', { exact: true }).selectOption('sample/model-max');
  await panel.getByRole('button', { name: 'Use this model' }).click();
  await expect(panel).toContainText('premium model');
  await panel.getByRole('button', { name: 'Confirm model' }).click();
  await expect(panel).toContainText('guanyu now uses sample/model-max.');

  // A sign-in provider hands off to Hermes in the in-app terminal.
  await panel.getByLabel('Provider', { exact: true }).selectOption('sample-signin');
  await panel.getByRole('button', { name: 'Sign in with Hermes' }).click();
  const terminal = page.getByRole('dialog', { name: 'Choose provider for guanyu' });
  await expect(terminal).toBeVisible();
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await expect(terminal).toHaveCount(0);

  const duties = page.getByRole('region', { name: 'Supervisor duties' });
  await duties.getByRole('button', { name: 'Prepare guanyu as supervisor' }).click();
  await expect(duties).toContainText('guanyu can now create and track kanban tasks.');

  // An agent whose gateway is stopped: nothing starts until you click.
  await agents.getByRole('button', { name: 'Select default' }).click();
  const stopped = page.getByRole('region', { name: 'Model and provider for default' });
  await expect(stopped).toContainText("default's Hermes gateway, which is not running");
  await expect(page.getByRole('button', { name: 'Start gateway', exact: true })).toBeVisible();
  await stopped.getByRole('button', { name: "Start default's gateway" }).click();
  await expect(stopped).toContainText('No model chosen yet');
  await expect(agents.getByRole('listitem', { name: 'default' })).toContainText('Gateway running');

  // A new agent starts empty and is guided to setup.
  const fresh = agents.getByRole('listitem', { name: 'New agent' });
  await fresh.getByLabel('Name').fill('Bad Name');
  await fresh.getByRole('button', { name: 'Create agent' }).click();
  await expect(fresh.getByRole('alert')).toContainText('lowercase letters');
  await fresh.getByLabel('Name').fill('scout');
  await fresh.getByRole('button', { name: 'Create agent' }).click();
  await expect(agents.getByRole('listitem', { name: 'scout' })).toContainText('Not set up yet');
  await agents.getByRole('button', { name: 'Chat with scout' }).click();
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  await expect(chat.getByRole('heading', { name: 'Talk to scout' })).toBeVisible();
  await expect(chat.getByLabel('Message scout')).toBeDisabled();
  await chat.getByRole('button', { name: 'Set up scout' }).click();
  const setup = page.getByRole('dialog', { name: 'Configure scout' });
  await expect(setup.getByText('This sample is not connected.', { exact: false })).toBeVisible();
  await setup.getByRole('button', { name: 'Close terminal' }).click();

  // The placeholder-provider notice leads to the model panel.
  await page.getByLabel('Supervisor agent').selectOption('default');
  await expect(chat.getByText('default has no provider chosen', { exact: false })).toBeVisible();
  await chat.getByRole('button', { name: 'Choose provider for default' }).click();
  await expect(page.getByRole('region', { name: 'Model and provider for default' })).toBeVisible();
});

test('sessions list every kind and transcripts are read-only views', async ({ page }) => {
  await openSupervisor(page);
  await tab(page, 'Sessions');
  const list = page.getByRole('region', { name: 'Hermes sessions' });
  await expect(list).toContainText('How are my agents doing today?');
  await expect(list).toContainText('Review provider access for scout');
  await expect(list).toContainText('Planning the week');
  const filters = list.getByRole('group', { name: 'Filter sessions' });
  await filters.getByRole('button', { name: /^Task runs/ }).click();
  await expect(filters.getByRole('button', { name: /^Task runs/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(list).not.toContainText('Planning the week');
  await list.getByRole('button', { name: /Review provider access for scout/ }).click();
  const detail = page.getByRole('region', { name: 'Session transcript' });
  await expect(detail).toContainText('Sample answer for sample_worker_session');
  await expect(detail).toContainText('Reading a task');

  // Reading a transcript needs the gateway; it is never started for you.
  await page.getByLabel('Supervisor agent').selectOption('default');
  const other = page.getByRole('region', { name: 'Hermes sessions' });
  await other.getByRole('button', { name: /Planning the week/ }).click();
  const blocked = page.getByRole('region', { name: 'Session transcript' });
  await expect(blocked).toContainText("needs default's Hermes gateway");
  await blocked.getByRole('button', { name: "Start default's gateway" }).click();
  await expect(blocked).toContainText('Sample answer for sample_conversation');
});

test('schedules show state, timing, and the last error', async ({ page }) => {
  await openSupervisor(page);
  await tab(page, 'Schedules');
  const schedules = page.getByRole('region', { name: 'Hermes schedules' });
  await expect(schedules).toContainText('Morning check');
  await expect(schedules).toContainText('0 9 * * *');
  await expect(schedules.getByText('Active', { exact: true })).toBeVisible();
  await expect(schedules.getByText('Paused', { exact: true }).first()).toBeVisible();
  await expect(schedules).toContainText('Sample error: the workspace was not reachable.');
});

test('supervisor tabs are keyboard operable', async ({ page }) => {
  await openSupervisor(page);
  const tabs = page.getByRole('tablist', { name: 'Supervisor views' });
  await tabs.getByRole('tab', { name: 'Chat' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /^Board/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: /^Board/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Schedules' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toContainText('Schedules for guanyu');
});

test('sidebar shows the Hermes gateway beside OpenShell', async ({ page }) => {
  await page.goto('/?preview=1');
  const foot = page.getByRole('button', { name: 'Hermes supervisor: Sample preview' });
  await expect(foot).toContainText('Hermes guanyu');
  await expect(foot.locator('.status-dot.connected')).toHaveCount(1);
  await foot.click();
  await expect(page.getByRole('heading', { name: 'Supervisor', level: 1 })).toBeVisible();
});

test('browser mode does not probe Hermes', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Hermes supervisor: Desktop app only' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await expect(page.getByText('Supervisor needs the desktop app')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Desktop mode with a mocked native bridge
// ---------------------------------------------------------------------------

type Bridge = {
  /** Makes every progress read fail. */
  progressError?: boolean;
  /** Holds the first task list until the test sets `__bridge.holdTasks = false`. */
  holdTasks?: boolean;
  /** Keeps a chat turn running until Stop is requested. */
  holdChat?: boolean;
  tasksError?: string | null;
  /** Profiles `discover_hermes` reports; null means Hermes is not installed. */
  profiles:
    { name: string; model: string | null; gateway: string; provider: string | null }[] | null;
};

/** Installs a fake native bridge. `window.__bridge` holds knobs tests can turn. */
async function mockDesktop(page: Page, bridge: Bridge) {
  await page.addInitScript((initial: Bridge) => {
    const calls: string[] = [];
    const state = {
      profiles: initial.profiles,
      revision: 'r1',
      tasks: [] as Record<string, unknown>[],
      truncated: false,
      holdTasks: initial.holdTasks ?? false,
      holdChat: initial.holdChat ?? false,
      stopRequested: false,
      tasksError: initial.tasksError ?? null,
      gatewayUp: false,
      chat: null as null | { text: string; steps: unknown[]; started: number },
    };
    const NOT_RUNNING = 'The Hermes gateway for this agent is not running. Start it first.';
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    Object.defineProperty(window, '__calls', { value: calls });
    Object.defineProperty(window, '__bridge', { value: state });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push(command + ':' + JSON.stringify(args));
          switch (command) {
            case 'discover_hermes':
              return state.profiles
                ? {
                    installed: true,
                    installation: '/usr/bin/hermes',
                    profiles: state.profiles.map((p) => ({
                      ...p,
                      active: false,
                      gateway: state.gatewayUp ? 'running' : p.gateway,
                    })),
                    profileText: '',
                  }
                : { installed: false, installation: null, profiles: [], profileText: '' };
            case 'hermes_chat': {
              const message = String(args.message);
              if (message === 'fail') throw 'Hermes reported an error: Invalid API key';
              const base = {
                sessionId: 's_1',
                model: 'x/y',
                tokens: null,
                durationMs: 3000,
                steps: [],
                stopped: false,
                timedOut: false,
                stopConfirmed: false,
                incomplete: false,
              };
              // A turn that ended early without Hermes confirming it stopped.
              if (message === 'detached')
                return { ...base, reply: 'Half an answer', stopped: true };
              if (message === 'slow')
                return {
                  ...base,
                  reply: 'So far',
                  stopped: true,
                  timedOut: true,
                  stopConfirmed: true,
                };
              if (message === 'limit')
                return {
                  ...base,
                  reply: '3. third\n\nA note in between.\n\n4. fourth',
                  incomplete: true,
                };
              state.chat = { text: '', steps: [], started: Date.now() };
              await wait(150);
              state.chat.steps = [
                { name: 'kanban_show', detail: 't_1', done: true, failed: false, durationMs: 1200 },
                { name: 'terminal', detail: null, done: false, failed: false, durationMs: null },
              ];
              state.chat.text = 'All ';
              // Long enough for the page's progress poll to show the live steps.
              if (state.holdChat) while (!state.stopRequested) await wait(40);
              else await wait(1600);
              const steps = [
                { name: 'kanban_show', detail: 't_1', done: true, failed: false, durationMs: 1200 },
                { name: 'terminal', detail: null, done: true, failed: true, durationMs: 300 },
              ];
              state.chat = null;
              return {
                reply: 'All **quiet**.\n\n- one\n- two\n\n```\ncode block\n```',
                sessionId: 's_1',
                model: 'x/y',
                tokens: { input: 23953, output: 5, total: 23958, cacheRead: 3968 },
                durationMs: 2400,
                steps,
                stopped: false,
                timedOut: false,
                stopConfirmed: false,
                incomplete: false,
              };
            }
            case 'hermes_chat_progress':
              if (initial.progressError) throw 'progress unavailable';
              return state.chat
                ? {
                    active: true,
                    profile: 'guanyu',
                    text: state.chat.text,
                    steps: state.chat.steps,
                    elapsedMs: Date.now() - state.chat.started,
                    stopping: false,
                  }
                : {
                    active: false,
                    profile: null,
                    text: '',
                    steps: [],
                    elapsedMs: 0,
                    stopping: false,
                  };
            case 'stop_hermes_chat':
              state.stopRequested = true;
              return state.chat !== null;
            case 'hermes_kanban_boards':
              return [
                { slug: 'default', name: 'Default', is_current: true, total: state.tasks.length },
              ];
            case 'hermes_kanban_revision':
              return state.revision;
            case 'hermes_kanban_tasks':
              while (state.holdTasks) await wait(40);
              if (state.tasksError) throw state.tasksError;
              return { tasks: state.tasks, truncated: state.truncated };
            case 'hermes_kanban_task':
              return {
                comments: [],
                events: [],
                runs: [],
                ...state.tasks.find((t) => t.id === args.id),
              };
            case 'hermes_kanban_log':
              return '';
            case 'hermes_gateway_status':
              return { state: state.gatewayUp ? 'ready' : 'absent', message: null };
            case 'start_hermes_gateway':
              state.gatewayUp = true;
              return { state: 'ready', message: null };
            case 'hermes_model_options':
              if (!state.gatewayUp) throw NOT_RUNNING;
              return {
                model: 'x/y',
                provider: 'keyed',
                providers: [
                  {
                    slug: 'keyed',
                    name: 'Keyed provider',
                    authenticated: !args.all || calls.some((c) => c.startsWith('save_hermes_key')),
                    auth_type: 'api_key',
                    is_current: true,
                    models: ['x/y', 'x/z'],
                  },
                ],
              };
            case 'save_hermes_key':
              return null;
            case 'hermes_sessions':
              return [];
            case 'hermes_schedules':
              if (!state.gatewayUp) throw NOT_RUNNING;
              return [];
            case 'get_snapshot':
              throw 'offline';
            case 'get_shellguardian_update':
              return {
                appVersion: '0',
                enabled: true,
                supported: false,
                phase: 'unsupported',
                latestVersion: null,
                error: null,
              };
            default:
              throw new Error(`Unsupported test command ${command}`);
          }
        },
      },
    });
  }, bridge);
}
const calls = (page: Page, prefix: string) =>
  page.evaluate(
    (wanted) =>
      (window as unknown as { __calls: string[] }).__calls.filter((c) => c.startsWith(wanted)),
    prefix,
  );
const GUANYU = [{ name: 'guanyu', model: 'x/y', gateway: 'stopped', provider: 'keyed' }];

test('desktop chat shows live steps, renders replies safely, and resumes the session', async ({
  page,
}) => {
  await mockDesktop(page, { profiles: GUANYU });
  await page.goto('/');
  const foot = page.getByRole('button', { name: 'Hermes supervisor: Gateway stopped' });
  await expect(foot.locator('.status-dot.connected')).toHaveCount(0);
  await foot.click();
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  const box = chat.getByLabel('Message guanyu');
  await box.fill('fail');
  await box.press('Enter');
  await expect(chat.getByRole('alert')).toContainText('Hermes reported an error: Invalid API key');
  await expect(chat.getByText('Not delivered')).toBeVisible();
  // Try again resends the same request.
  await chat.getByRole('button', { name: 'Try again' }).click();
  await expect(chat.getByRole('alert')).toHaveCount(2);

  await box.fill('status?');
  await box.press('Enter');
  // Live: a finished step with its task ID, and one still running.
  await expect(chat.getByText('Reading a task: t_1')).toBeVisible();
  await expect(chat.getByText('Running a command')).toBeVisible();
  // Final: markdown is rendered as elements, never as HTML.
  const reply = chat.locator('.sv-msg.agent').last();
  await expect(reply.locator('strong', { hasText: 'quiet' })).toBeVisible();
  await expect(reply.locator('.md li')).toHaveText(['one', 'two']);
  await expect(reply.locator('.md pre')).toHaveText('code block');
  await expect(reply).toContainText('2 steps');
  await reply.getByText('What guanyu did').click();
  await expect(reply).toContainText('did not succeed');
  await expect(chat).toContainText('This conversation so far: 24k tokens in, 5 out');

  await box.fill('again');
  await box.press('Enter');
  await expect(chat.locator('.sv-msg.agent')).toHaveCount(2);
  expect(await calls(page, 'hermes_chat:')).toEqual([
    'hermes_chat:{"profile":"guanyu","message":"fail","sessionId":null}',
    'hermes_chat:{"profile":"guanyu","message":"fail","sessionId":null}',
    'hermes_chat:{"profile":"guanyu","message":"status?","sessionId":null}',
    'hermes_chat:{"profile":"guanyu","message":"again","sessionId":"s_1"}',
  ]);
  // Usage needs the gateway, which this page never starts on its own.
  await expect(page.getByRole('region', { name: 'Usage limits' })).toContainText(
    'Usage is unavailable',
  );
  expect(await calls(page, 'start_hermes_gateway')).toEqual([]);
});

test('desktop chat says honestly how a turn ended', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  const box = chat.getByLabel('Message guanyu');
  const last = () => chat.locator('.sv-msg.agent').last();

  // The view detached but Hermes did not confirm the turn stopped: no claim that it did.
  await box.fill('detached');
  await box.press('Enter');
  await expect(last()).toContainText('Half an answer');
  await expect(last()).toContainText('stopped watching');
  await expect(last()).toContainText('Hermes did not confirm that guanyu stopped');
  await expect(last()).not.toContainText('stopped by you');
  // Unknown usage is not shown as zero.
  await expect(chat).not.toContainText('0 tokens');
  await expect(chat).toContainText('Enter to send');

  await box.fill('slow');
  await box.press('Enter');
  await expect(last()).toContainText('stopped at the time limit');
  await expect(last()).not.toContainText('did not confirm');

  // A reply that hit Hermes's step limit is still a reply, with a note.
  await box.fill('limit');
  await box.press('Enter');
  await expect(last()).toContainText('Hermes ended this turn before guanyu finished');
  await expect(chat.getByRole('alert')).toHaveCount(0);
  // A numbered list that resumes after a paragraph keeps its numbers.
  await expect(last().locator('.md ol').nth(0)).toHaveAttribute('start', '3');
  await expect(last().locator('.md ol').nth(1)).toHaveAttribute('start', '4');
});

test('desktop Stop arms on its own clock, even when progress cannot be read', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU, progressError: true, holdChat: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const chat = page.getByRole('region', { name: 'Supervisor chat' });
  const box = chat.getByLabel('Message guanyu');
  await box.fill('status');
  // Send and read the button inside the page: a round trip through the test
  // runner could outlast the guard on a slow machine.
  const disabledAtFirst = await box.evaluate(async (node) => {
    (node as HTMLTextAreaElement).form?.requestSubmit();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const stop = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Stop',
    );
    return stop ? stop.disabled : null;
  });
  // Not at once (a double-click on Send must not stop the turn), but soon.
  expect(disabledAtFirst).toBe(true);
  const stop = chat.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeEnabled();
  await stop.click();
  expect(await calls(page, 'stop_hermes_chat')).toHaveLength(1);
});

test('desktop board never shows counts it has not read', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU, holdTasks: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  // While the first read is in flight nothing claims the board is empty or idle.
  const work = page.getByRole('region', { name: 'Work in progress' });
  await expect(work).toContainText('Checking the board');
  await expect(work).not.toContainText('Nothing is running');
  await tab(page, 'Board');
  await expect(page.getByLabel('Board summary')).toContainText('Reading the board');
  await expect(page.getByLabel('Board summary')).not.toContainText('running');
  await expect(page.getByText('No tasks on this board yet')).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __bridge: { holdTasks: boolean } }).__bridge.holdTasks = false;
  });
  await expect(page.getByText('No tasks on this board yet')).toBeVisible();
  await expect(page.getByLabel('Board summary')).toContainText('0 running');
});

test('desktop board failure is reported, not shown as an empty board', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU, tasksError: 'Hermes kanban: database is locked' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const work = page.getByRole('region', { name: 'Work in progress' });
  await expect(work.getByRole('alert')).toContainText('database is locked');
  await expect(work).not.toContainText('Nothing is running');
  await tab(page, 'Board');
  await expect(page.getByLabel('Board summary')).toContainText('Board unavailable');
  await expect(page.getByText('No tasks on this board yet')).toHaveCount(0);
  await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('database is locked');
});

test('desktop board refetches tasks only when the change signal moves', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await tab(page, 'Board');
  await expect(page.getByText('No tasks on this board yet')).toBeVisible();
  // Several revision checks pass with no change: tasks are not fetched again.
  await page.waitForTimeout(4000);
  expect((await calls(page, 'hermes_kanban_revision')).length).toBeGreaterThanOrEqual(2);
  expect(await calls(page, 'hermes_kanban_tasks')).toHaveLength(1);

  await page.evaluate(() => {
    const bridge = (window as unknown as { __bridge: { revision: string; tasks: unknown[] } })
      .__bridge;
    bridge.tasks = [
      { id: 't_9', title: 'Arrived from the supervisor', status: 'running', assignee: 'guanyu' },
    ];
    bridge.revision = 'r2';
  });
  const board = page.getByRole('list', { name: 'Kanban board' });
  await expect(board.getByRole('listitem', { name: 'Running tasks' })).toContainText(
    'Arrived from the supervisor',
  );
  expect(await calls(page, 'hermes_kanban_tasks')).toHaveLength(2);
  // Its agent's gateway is stopped, so the board says the task will not move.
  await expect(page.getByText('guanyu has tasks waiting', { exact: false })).toBeVisible();
  expect(await calls(page, 'start_hermes_gateway')).toEqual([]);
  await page.getByRole('button', { name: "Start guanyu's gateway" }).click();
  await expect(page.getByText('guanyu has tasks waiting', { exact: false })).toHaveCount(0);
  expect(await calls(page, 'start_hermes_gateway')).toEqual([
    'start_hermes_gateway:{"profile":"guanyu"}',
  ]);
});

test('desktop board filters by agent, caps long columns, and folds check-ins', async ({ page }) => {
  await mockDesktop(page, {
    profiles: [...GUANYU, { name: 'scout', model: 'x/y', gateway: 'running', provider: 'keyed' }],
  });
  await page.goto('/');
  await page.evaluate(() => {
    const bridge = (window as unknown as { __bridge: { tasks: unknown[]; truncated: boolean } })
      .__bridge;
    bridge.truncated = true;
    bridge.tasks = [
      ...Array.from({ length: 15 }, (_, n) => ({
        id: `t_done${n}`,
        title: `Finished job ${n}`,
        status: 'done',
        assignee: 'guanyu',
      })),
      {
        id: 't_live',
        title: 'Long running job',
        status: 'running',
        assignee: 'scout',
        started_at: Math.floor(Date.now() / 1000) - 125,
        events: [
          { kind: 'claimed', created_at: 1 },
          { kind: 'worker_bound', created_at: 2 },
          { kind: 'heartbeat', created_at: 3 },
          { kind: 'heartbeat', created_at: 4 },
          { kind: 'heartbeat', created_at: 5 },
          { kind: 'heartbeat', created_at: 6, detail: { note: 'Halfway there' } },
          { kind: 'heartbeat', created_at: 7 },
        ],
      },
    ];
  });
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await tab(page, 'Board');
  const board = page.getByRole('list', { name: 'Kanban board' });
  const done = board.getByRole('listitem', { name: 'Done tasks' });
  await expect(done.getByRole('button', { name: /Finished job/ })).toHaveCount(12);
  // The board says when Hermes holds more tasks than are shown.
  await expect(page.getByLabel('Board summary')).toContainText('Newest 16 shown');
  await done.getByRole('button', { name: 'Show all 15' }).click();
  await expect(done.getByRole('button', { name: /Finished job/ })).toHaveCount(15);

  const running = board.getByRole('listitem', { name: 'Running tasks' });
  await expect(running).toContainText('Long running job');
  await expect(running).toContainText('Halfway there');
  await expect(running).toContainText('Running 2m');
  await page.getByLabel('Filter by agent').selectOption('guanyu');
  await expect(running).toContainText('Nothing here');
  await expect(page.getByLabel('Board summary')).toContainText('0 running');
  await page.getByLabel('Filter by agent').selectOption('');

  await running.getByRole('button', { name: /Long running job/ }).click();
  const timeline = page
    .getByRole('dialog', { name: 'Task: Long running job' })
    .getByLabel('Task timeline');
  await expect(timeline.getByRole('listitem')).toHaveCount(4);
  await expect(timeline.getByRole('listitem').nth(0)).toContainText('Picked up');
  await expect(timeline.getByRole('listitem').nth(1)).toContainText('Still working · 3 check-ins');
  await expect(timeline.getByRole('listitem').nth(2)).toContainText('Halfway there');
  await expect(timeline.getByRole('listitem').nth(3)).toContainText('Still working');
  await expect(timeline.getByRole('listitem').nth(3)).not.toContainText('check-ins');
});

test('desktop key entry reaches only the native bridge and is cleared', async ({ page }) => {
  await mockDesktop(page, { profiles: GUANYU });
  await page.goto('/');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await tab(page, 'Agents');
  const panel = page.getByRole('region', { name: 'Model and provider for guanyu' });
  await panel.getByRole('button', { name: "Start guanyu's gateway" }).click();
  const key = panel.getByLabel('API key for Keyed provider');
  await key.fill('sk-test-0123456789');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('autocomplete', 'off');
  await panel.getByRole('button', { name: 'Save key' }).click();
  await expect(panel).toContainText('Hermes saved the key for Keyed provider.');
  expect(await calls(page, 'save_hermes_key')).toEqual([
    'save_hermes_key:{"profile":"guanyu","provider":"keyed","key":"sk-test-0123456789"}',
  ]);
  await expect(page.locator('body')).not.toContainText('sk-test-0123456789');
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('input')].some((input) => input.value.includes('sk-test')),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('desktop install runs only the reviewed installer hash in an in-app terminal', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    let installed = false;
    let reads = 0;
    Object.defineProperty(window, '__calls', { value: calls });
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (command: string, args: Record<string, unknown>) => {
          calls.push(command + ':' + JSON.stringify(args ?? {}));
          if (command === 'discover_hermes')
            return installed
              ? {
                  installed: true,
                  installation: '/home/u/.local/bin/hermes',
                  profiles: [
                    {
                      name: 'default',
                      model: null,
                      gateway: 'stopped',
                      active: true,
                      provider: null,
                    },
                  ],
                  profileText: '',
                }
              : { installed: false, installation: null, profiles: [], profileText: '' };
          if (command === 'prepare_hermes_installer')
            return {
              url: 'https://hermes-agent.nousresearch.com/install.sh',
              sha256: 'a'.repeat(64),
              size: 1234,
              script: '#!/bin/bash\necho installing\n',
            };
          if (command === 'open_hermes_terminal') return { id: 'terminal-1', kind: 'terminal' };
          if (command === 'resize_agent_terminal') return null;
          if (command === 'read_agent_terminal') {
            reads += 1;
            if (reads === 1)
              return {
                data: Array.from(new TextEncoder().encode('Hermes installed\r\n')),
                exited: false,
                exitCode: null,
                error: null,
              };
            installed = true;
            return { data: [], exited: true, exitCode: 0, error: null };
          }
          if (command === 'close_agent_terminal') return null;
          if (command === 'hermes_kanban_boards') {
            if (!installed) throw 'Hermes is not installed.';
            return [{ slug: 'default', name: 'Default', is_current: true, total: 1 }];
          }
          if (command === 'hermes_kanban_revision') return 'r1';
          if (command === 'hermes_kanban_tasks')
            return {
              tasks: [{ id: 't_1', title: 'First task', status: 'todo' }],
              truncated: false,
            };
          if (command === 'hermes_model_options')
            throw 'The Hermes gateway for this agent is not running. Start it first.';
          if (command === 'get_snapshot') throw 'offline';
          if (command === 'get_shellguardian_update')
            return {
              appVersion: '0',
              enabled: true,
              supported: false,
              phase: 'unsupported',
              latestVersion: null,
              error: null,
            };
          throw new Error('Unsupported test command');
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Hermes supervisor: Not detected' })).toBeVisible();
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const card = page.getByRole('region', { name: 'Install Hermes' });
  await expect(card.getByRole('button', { name: 'Run installer' })).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Supervisor views' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Download installer' }).click();
  const review = card.getByRole('region', { name: 'Installer review' });
  await expect(review).toContainText('a'.repeat(64));
  await expect(review).toContainText('is not signed');
  await review.getByText('Read the installer script').click();
  await expect(review.getByText('echo installing')).toBeVisible();
  await card.getByRole('button', { name: 'Run installer' }).click();
  const terminal = page.getByRole('dialog', { name: 'Install Hermes' });
  await expect(terminal.getByText('Session ended with exit code 0.')).toBeVisible();
  await terminal.getByRole('button', { name: 'Close terminal' }).click();
  await expect(
    page.getByRole('button', { name: 'Hermes supervisor: Gateway stopped' }),
  ).toBeVisible();
  await tab(page, 'Agents');
  await expect(
    page.getByRole('list', { name: 'Hermes agents' }).getByRole('listitem', { name: 'default' }),
  ).toContainText('Not set up yet');
  // The board is read once Hermes exists (and not before), without a restart.
  await tab(page, 'Board');
  await expect(page.getByRole('button', { name: /First task/ })).toBeVisible();
  const order = await page.evaluate(() =>
    (window as unknown as { __calls: string[] }).__calls.map((call) => call.split(':')[0]),
  );
  expect(order.indexOf('hermes_kanban_boards')).toBeGreaterThan(
    order.indexOf('open_hermes_terminal'),
  );
  const opens = await calls(page, 'open_hermes_terminal');
  expect(opens).toHaveLength(1);
  expect(JSON.parse(opens[0].slice('open_hermes_terminal:'.length)).action).toEqual({
    action: 'install',
    sha256: 'a'.repeat(64),
  });
});
