import { expect, test, type Page } from '@playwright/test';
import { sampleDetail, sampleSnapshot } from '../src/preview';

async function mockDesktop(page: Page, options: { delayOpen?: boolean; stopped?: boolean } = {}) {
  await page.addInitScript(
    (payload: string) => {
      const { snapshot, detail, options } = JSON.parse(payload);
      const state = {
        calls: [] as { command: string; args: Record<string, any> }[],
        frames: [
          {
            data: Array.from(new TextEncoder().encode('Sandbox terminal ready\r\n$ ')),
            exited: false,
            exitCode: null,
            error: null,
          },
        ] as { data: number[]; exited: boolean; exitCode: number | null; error: string | null }[],
        failOpen: false,
        failWrite: false,
        failRead: false,
        failClose: false,
        resolveOpen: null as (() => void) | null,
      };
      Object.defineProperty(window, 'isTauri', { value: true });
      Object.defineProperty(window, '__terminalTest', { value: state });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          invoke: async (command: string, args: Record<string, any> = {}) => {
            state.calls.push({ command, args });
            if (command === 'get_snapshot')
              return {
                ...snapshot,
                scope: { ...args.selection, gateway: args.selection.gateway ?? 'local' },
                agents: snapshot.agents.map((agent: { phase: string }) =>
                  options.stopped ? { ...agent, phase: 'Stopped' } : agent,
                ),
              };
            if (command === 'get_agent_detail')
              return options.stopped
                ? { ...detail, agent: { ...detail.agent, phase: 'Stopped' } }
                : detail;
            if (command === 'get_ssh_connections')
              return [
                {
                  id: 'ssh-fixture',
                  gateway: 'studio-remote',
                  destination: 'alice@remote',
                  remotePort: 17670,
                  sshPort: null,
                  localPort: 41000,
                  status: 'connected',
                  error: null,
                },
              ];
            if (command === 'get_shellguardian_update')
              return {
                appVersion: '0.3.2',
                enabled: true,
                supported: false,
                phase: 'unsupported',
                latestVersion: null,
                error: null,
              };
            if (command === 'check_openshell_updates')
              return {
                status: 'current',
                installedVersion: '0.1.2',
                latestVersion: '0.1.2',
                error: null,
              };
            if (command === 'open_agent_terminal') {
              if (state.failOpen)
                throw new Error('This sandbox does not have an interactive main process.');
              if (options.delayOpen)
                await new Promise<void>((resolve) => {
                  state.resolveOpen = resolve;
                });
              return { id: 'terminal-fixture', kind: args.kind };
            }
            if (command === 'read_agent_terminal') {
              if (state.failRead)
                throw new Error('SSH connection closed. Reconnect to this server.');
              return (
                state.frames.shift() ?? { data: [], exited: false, exitCode: null, error: null }
              );
            }
            if (command === 'write_agent_terminal' && state.failWrite)
              throw new Error('Terminal input is unavailable.');
            if (command === 'close_agent_terminal' && state.failClose)
              throw new Error('Could not close the terminal session.');
            if (
              ['write_agent_terminal', 'resize_agent_terminal', 'close_agent_terminal'].includes(
                command,
              )
            )
              return null;
            throw new Error('Unsupported test command');
          },
        },
      });
    },
    JSON.stringify({
      snapshot: sampleSnapshot,
      detail: sampleDetail('research-assistant', sampleSnapshot),
      options,
    }),
  );
}

async function openTerminal(page: Page, kind: 'agent' | 'terminal' = 'terminal') {
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  await page
    .getByRole('button', {
      name: kind === 'agent' ? 'Talk to agent' : 'Open terminal',
      exact: true,
    })
    .click();
  return page.getByRole('dialog', {
    name: `${kind === 'agent' ? 'Talk to agent' : 'Terminal'}: research-assistant`,
    exact: true,
  });
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      Reflect.get(window, '__terminalTest').calls.filter((call: any) => call.command === command),
    command,
  );
}

test('sample interaction is explicitly non-executable and stopped agents disable both actions', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  const dialog = await openTerminal(page, 'agent');
  await expect(dialog).toContainText('No process is attached and no commands can run.');
  await expect(dialog.locator('.xterm')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Detach agent' }).click();
  await page.getByRole('button', { name: 'Close agent details' }).click();
  await page.getByRole('button', { name: 'Inspect daily-curator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Talk to agent', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toBeDisabled();
});

test('native terminal captures SSH scope, renders bytes, forwards keyboard input, resizes and closes only its session', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('combobox', { name: 'OpenShell gateway' }).selectOption('ssh:ssh-fixture');
  const dialog = await openTerminal(page);
  await expect(dialog).toContainText('Via selected SSH connection');
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await expect(dialog.locator('.xterm-accessibility')).toContainText('Sandbox terminal ready');
  const opened = await calls(page, 'open_agent_terminal');
  expect(opened).toHaveLength(1);
  expect(opened[0].args).toMatchObject({
    scope: { gateway: 'studio-remote', workspace: 'default', connectionId: 'ssh-fixture' },
    name: 'research-assistant',
    kind: 'terminal',
  });
  await dialog.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () =>
      (await calls(page, 'write_agent_terminal')).map((call: any) => call.args.data).join(''),
    )
    .toContain('pwd\r\u001b');
  await page.setViewportSize({ width: 1050, height: 730 });
  await expect
    .poll(async () => (await calls(page, 'resize_agent_terminal')).length)
    .toBeGreaterThan(1);
  await dialog.getByRole('button', { name: 'Close terminal' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await calls(page, 'close_agent_terminal')).map((call: any) => call.args)).toEqual([
    { sessionId: 'terminal-fixture' },
  ]);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test('agent detach never sends exit or control-C and closes an opening session that arrives late', async ({
  page,
}) => {
  await mockDesktop(page, { delayOpen: true });
  await page.goto('/');
  const dialog = await openTerminal(page, 'agent');
  await expect.poll(async () => (await calls(page, 'open_agent_terminal')).length).toBe(1);
  await dialog.getByRole('button', { name: 'Detach agent' }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, '__terminalTest').resolveOpen());
  await expect.poll(async () => (await calls(page, 'close_agent_terminal')).length).toBe(1);
  expect(await calls(page, 'write_agent_terminal')).toEqual([]);
  expect(await calls(page, 'read_agent_terminal')).toEqual([]);
});

test('scope changes close the session without retargeting or opening another one', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await page
    .getByRole('combobox', { name: 'OpenShell gateway', includeHidden: true })
    .selectOption('studio-remote', { force: true });
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'close_agent_terminal')).length).toBe(1);
  expect(await calls(page, 'open_agent_terminal')).toHaveLength(1);
});

test('terminal exits and native failures remain explicit with no reconnect loop', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await page.evaluate(() =>
    Reflect.get(window, '__terminalTest').frames.push({
      data: [],
      exited: true,
      exitCode: 7,
      error: null,
    }),
  );
  await expect(dialog.getByRole('status')).toContainText('Session ended with exit code 7.');
  await dialog.getByRole('button', { name: 'Close terminal' }).click();
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failOpen = true;
  });
  await page.getByRole('button', { name: 'Talk to agent', exact: true }).click();
  const failed = page.getByRole('dialog', { name: 'Talk to agent: research-assistant' });
  await expect(failed.getByRole('alert')).toContainText(
    'does not have an interactive main process',
  );
  expect(await calls(page, 'open_agent_terminal')).toHaveLength(2);
});

test('tunnel loss closes the native session and stops accepting input', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failRead = true;
  });
  await expect(dialog.getByRole('alert')).toContainText('SSH connection closed');
  await expect.poll(async () => (await calls(page, 'close_agent_terminal')).length).toBe(1);
  await dialog.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('do not send');
  expect(await calls(page, 'write_agent_terminal')).toEqual([]);
});

test('input backpressure preserves the session and allows deliberate typing after checking partial input', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failWrite = true;
  });
  await dialog.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('a');
  await expect(dialog.getByRole('alert')).toContainText('Input may be partial. Check the terminal');
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  expect(await calls(page, 'close_agent_terminal')).toEqual([]);
  const readsBeforeRetry = (await calls(page, 'read_agent_terminal')).length;
  await expect
    .poll(async () => (await calls(page, 'read_agent_terminal')).length)
    .toBeGreaterThan(readsBeforeRetry);
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failWrite = false;
  });
  await page.keyboard.type('b');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => (await calls(page, 'write_agent_terminal')).at(-1)?.args.data)
    .toBe('b');
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  expect(await calls(page, 'open_agent_terminal')).toHaveLength(1);
  expect(await calls(page, 'close_agent_terminal')).toEqual([]);
});

test('paste is bounded into UTF-8 writes and OSC links and clipboard requests are inert', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await dialog.locator('.xterm-helper-textarea').evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '界'.repeat(12000));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  });
  await expect
    .poll(
      async () =>
        (await calls(page, 'write_agent_terminal')).map((call: any) => call.args.data).join('')
          .length,
    )
    .toBe(12000);
  const writes = await calls(page, 'write_agent_terminal');
  expect(writes.length).toBeGreaterThan(1);
  for (const write of writes)
    expect(new TextEncoder().encode(write.args.data).length).toBeLessThanOrEqual(16384);
  await page.evaluate(() =>
    Reflect.get(window, '__terminalTest').frames.push({
      data: Array.from(
        new TextEncoder().encode(
          '\u001b]8;;https://example.invalid/\u0007untrusted link\u001b]8;;\u0007\u001b]52;c;dW50cnVzdGVk\u0007',
        ),
      ),
      exited: false,
      exitCode: null,
      error: null,
    }),
  );
  await expect(dialog.locator('.xterm-accessibility')).toContainText('untrusted link');
  await expect(dialog.getByRole('link')).toHaveCount(0);
  const previousWrites = writes.length;
  await dialog.locator('.xterm-helper-textarea').evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'x'.repeat(300000));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  });
  await expect(dialog.getByRole('alert')).toContainText('Input queue is full');
  expect(await calls(page, 'write_agent_terminal')).toHaveLength(previousWrites);
});

test('close failure remains visible and cleanup can be retried without another open', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failClose = true;
  });
  await dialog.getByRole('button', { name: 'Close terminal' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not close the terminal session.');
  await expect(dialog.getByRole('button', { name: 'Close terminal' })).toBeEnabled();
  await page.evaluate(() => {
    Reflect.get(window, '__terminalTest').failClose = false;
  });
  await dialog.getByRole('button', { name: 'Close terminal' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, 'open_agent_terminal')).toHaveLength(1);
  expect(await calls(page, 'close_agent_terminal')).toHaveLength(2);
});

test('terminal follows OS theme changes and remains usable on a small screen', async ({ page }) => {
  await mockDesktop(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const dialog = await openTerminal(page);
  await expect(dialog.getByRole('status')).toContainText('Terminal open.');
  await expect(dialog.locator('.xterm-scrollable-element')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(dialog.locator('.xterm-scrollable-element')).toHaveCSS(
    'background-color',
    'rgb(28, 40, 34)',
  );
  await page.setViewportSize({ width: 430, height: 930 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/interaction-terminal-mobile.png', fullPage: true });
});
