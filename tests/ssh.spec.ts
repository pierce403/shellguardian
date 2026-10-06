import { expect, test, type Page } from '@playwright/test';
import { sampleDetail, sampleSnapshot } from '../src/preview';

async function mockDesktop(page: Page) {
  await page.addInitScript(
    (payload: string) => {
      const { snapshot, detail } = JSON.parse(payload);
      const calls: { command: string; args: Record<string, any> }[] = [];
      const failures = { connect: false, snapshot: false };
      let sequence = 0;
      let connections: any[] = [];
      Object.defineProperty(window, 'isTauri', { value: true });
      Object.defineProperty(window, '__sshCalls', { value: calls });
      Object.defineProperty(window, '__sshFailures', { value: failures });
      Object.defineProperty(window, '__dropSsh', {
        value: () => {
          connections = connections.map((connection) => ({
            ...connection,
            status: 'disconnected',
            error: 'SSH connection closed.',
          }));
        },
      });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          invoke: async (command: string, args: Record<string, any> = {}) => {
            calls.push({ command, args });
            if (command === 'get_snapshot') {
              if (
                args.selection.connectionId &&
                (failures.snapshot ||
                  !connections.some(
                    (connection) =>
                      connection.id === args.selection.connectionId &&
                      connection.status === 'connected',
                  ))
              ) {
                throw { message: 'SSH connection closed. Reconnect to this server.' };
              }
              return {
                ...snapshot,
                scope: { ...args.selection, gateway: args.selection.gateway ?? 'local' },
              };
            }
            if (command === 'get_shellguardian_update')
              return {
                appVersion: '0.2.0',
                enabled: true,
                supported: false,
                phase: 'unsupported',
                error: null,
                latestVersion: null,
              };
            if (command === 'check_openshell_updates')
              return {
                status: 'current',
                installedVersion: '0.1.2',
                latestVersion: '0.1.2',
                error: null,
              };
            if (command === 'get_ssh_connections')
              return connections.map((connection) => ({ ...connection }));
            if (command === 'connect_ssh_gateway') {
              if (failures.connect) throw { message: 'SSH server is unavailable.' };
              if (args.request.destination === 'unknown-host')
                throw {
                  message:
                    'SSH host key verification failed. Verify this host in your terminal first.',
                };
              const connection = {
                ...args.request,
                id: `ssh-${++sequence}`,
                localPort: 41000 + sequence,
                status: 'connected',
                error: null,
              };
              connections.push(connection);
              return connection;
            }
            if (command === 'disconnect_ssh_gateway') {
              connections = connections.filter((connection) => connection.id !== args.connectionId);
              return null;
            }
            if (command === 'get_agent_detail') return detail;
            throw new Error('Unsupported test command');
          },
        },
      });
    },
    JSON.stringify({
      snapshot: sampleSnapshot,
      detail: sampleDetail('research-assistant', sampleSnapshot),
    }),
  );
}

async function openSsh(page: Page) {
  await page.getByRole('button', { name: 'Connect to remote server', exact: true }).click();
  const region = page.getByRole('region', { name: 'Connect over SSH', exact: true });
  await expect(region).toBeVisible();
  return region;
}

test('SSH preview uses default ports and remains explicitly simulated', async ({ page }) => {
  await page.goto('/?preview=1');
  const region = await openSsh(page);
  await region.getByRole('textbox', { name: 'SSH host', exact: true }).fill('alice@workstation');
  await region.getByRole('combobox', { name: 'OpenShell authentication' }).selectOption('local');
  await expect(region.getByLabel('OpenShell port', { exact: true })).toHaveValue('17670');
  await expect(region.getByLabel('SSH port (optional)')).toHaveValue('');
  await region.getByRole('button', { name: 'Simulate SSH connection' }).click();
  await expect(page.getByRole('status').last()).toContainText('No server was contacted');
  await expect(page.getByRole('combobox', { name: 'OpenShell gateway' })).toHaveValue(
    'ssh:sample-ssh-1',
  );
  await expect(region.getByRole('article')).toContainText('alice@workstation');
  await region.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(region.getByRole('article')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('ordinary browser mode cannot start SSH connections', async ({ page }) => {
  await page.goto('/');
  const region = await openSsh(page);
  await expect(region.getByRole('textbox', { name: 'SSH host', exact: true })).toBeDisabled();
  await expect(
    region.getByRole('button', { name: 'Connect to server', exact: true }),
  ).toBeDisabled();
});

test('SSH setup errors preserve the selected connection and do not retry', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  const region = await openSsh(page);
  await region.getByRole('textbox', { name: 'SSH host', exact: true }).fill('unknown-host');
  await region.getByRole('combobox', { name: 'OpenShell authentication' }).selectOption('local');
  await region.getByText('Port settings', { exact: true }).click();
  await region.getByLabel('OpenShell port', { exact: true }).fill('0');
  await region.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('between 1 and 65535');
  await region.getByLabel('OpenShell port', { exact: true }).fill('17670');
  await region.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('host key verification failed');
  await expect(page.getByRole('combobox', { name: 'OpenShell gateway' })).toHaveValue('local');
  const calls = await page.evaluate(() => Reflect.get(window, '__sshCalls'));
  expect(calls.filter((call: any) => call.command === 'connect_ssh_gateway')).toHaveLength(1);
});

test('SSH identity follows reads, a failed tunnel stays selected, and reconnect gets a new identity', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const region = await openSsh(page);
  await region.getByRole('textbox', { name: 'SSH host', exact: true }).fill('studio');
  await region.getByRole('combobox', { name: 'OpenShell authentication' }).selectOption('local');
  await region.getByText('Port settings', { exact: true }).click();
  await region.getByLabel('SSH port (optional)').fill('2222');
  await region.getByRole('button', { name: 'Connect to server', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'OpenShell gateway' });
  await expect(selector).toHaveValue('ssh:ssh-1');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /^Agents/ })
    .click();
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Agent details for research-assistant' }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => Reflect.get(window, '__sshCalls'));
      return calls.findLast((call: any) => call.command === 'get_agent_detail')?.args.scope;
    })
    .toEqual({ gateway: 'local', workspace: 'default', connectionId: 'ssh-1' });
  await page.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Stop this sandbox?' });
  await expect(review).toContainText('SSH serverstudio');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => Reflect.get(window, '__dropSsh')());
  await page.getByRole('button', { name: 'Refresh OpenShell state' }).click();
  await expect(page.getByRole('alert')).toContainText('SSH connection closed');
  await expect(selector).toHaveValue('ssh:ssh-1');
  await openSsh(page);
  await expect(region.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible({
    timeout: 8000,
  });
  await region.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(selector).toHaveValue('ssh:ssh-2');
  const calls = await page.evaluate(() => Reflect.get(window, '__sshCalls'));
  expect(
    calls
      .filter((call: any) => call.command === 'connect_ssh_gateway')
      .map((call: any) => call.args.request),
  ).toEqual([
    { gateway: 'local', destination: 'studio', remotePort: 17670, sshPort: 2222 },
    { gateway: 'local', destination: 'studio', remotePort: 17670, sshPort: 2222 },
  ]);
  await region.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(selector).toHaveValue('local');
});

test('failed initial SSH reads and reconnect preserve an explicit disconnected selection and recovery profiles', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const region = await openSsh(page);
  await region.getByRole('textbox', { name: 'SSH host', exact: true }).fill('studio');
  await region.getByRole('combobox', { name: 'OpenShell authentication' }).selectOption('local');
  await page.evaluate(() => {
    Reflect.get(window, '__sshFailures').snapshot = true;
  });
  await region.getByRole('button', { name: 'Connect to server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SSH connection closed');
  await expect(region.getByRole('combobox', { name: 'OpenShell authentication' })).toHaveValue(
    'local',
  );
  await page.evaluate(() => {
    Reflect.get(window, '__dropSsh')();
    Reflect.get(window, '__sshFailures').connect = true;
  });
  await expect(region.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible({
    timeout: 8000,
  });
  await region.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(region.getByRole('alert')).toContainText('SSH server is unavailable');
  const selector = page.getByRole('combobox', { name: 'OpenShell gateway' });
  await expect(selector).toHaveValue('ssh:ssh-1');
  await expect(selector.locator('option:checked')).toHaveText('SSH connection unavailable');
  await expect(region.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue(
    'studio',
  );
  await expect(region.getByRole('combobox', { name: 'OpenShell authentication' })).toHaveValue(
    'local',
  );
  await selector.selectOption('local');
  await expect(selector).toHaveValue('local');
});
