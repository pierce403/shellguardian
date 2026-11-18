import { expect, test } from '@playwright/test';
import { sampleDetail, sampleSnapshot } from '../src/preview';

test('browser mode requires desktop connection and does not fabricate agents', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your agents belong here.' })).toBeVisible();
  await expect(page.getByText('research-assistant', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore sample preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Explore sample preview' }).click();
  await expect(
    page.getByText(
      'Illustrative agents only. OpenShell is not connected and controls are simulated.',
    ),
  ).toBeVisible();
});

test('sample overview exposes readiness and honest usage coverage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?preview=1');
  await expect(page.getByRole('heading', { name: 'Give your agents room to work.' })).toBeVisible();
  await expect(page.locator('.agent-card')).toHaveCount(4);
  await expect(page.getByText('Usage not reported by this CLI')).toBeVisible();
  await page.screenshot({ path: 'test-results/preview-overview.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Search agents' }).fill('curator');
  await expect(page.locator('.agent-card')).toHaveCount(1);
  await expect(page.locator('.agent-card')).toContainText('daily-curator');
  await page.getByRole('textbox', { name: 'Search agents' }).fill('no-match');
  await expect(page.getByText('No agents match your search.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('stop requires review, cancellation preserves state, and preview actions are labeled', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
  await expect(drawer.getByText('docs.rs', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Stop this sandbox?' });
  await expect(review).toContainText('local / default');
  await expect(review).toContainText('Sample preview. This action will only be simulated.');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Stop sandbox', exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  await review.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Start sandbox', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('No OpenShell agent was changed');
});

test('credential controls display names and support reviewed detach/attach', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
  await drawer.getByRole('tab', { name: 'Credentials', exact: true }).click();
  await expect(drawer.getByText('ANTHROPIC_API_KEY', { exact: true })).toBeVisible();
  await expect(
    drawer.getByText(
      "Credential values stay in OpenShell. Attachments grant the provider's access profile.",
    ),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Revoke access', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Revoke provider access?' })
    .getByRole('button', { name: 'Revoke access', exact: true })
    .click();
  await expect(drawer.getByText('No providers are attached to this sandbox.')).toBeVisible();
  await drawer
    .getByRole('combobox', { name: 'Provider to attach' })
    .selectOption('github-readonly');
  await drawer.getByRole('button', { name: 'Grant', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Grant provider access?' })
    .getByRole('button', { name: 'Grant access', exact: true })
    .click();
  await expect(drawer.getByText('GITHUB_TOKEN', { exact: true })).toBeVisible();
});

test('policy editor validates input and displays both policies before applying', async ({
  page,
}) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
  await drawer.getByRole('button', { name: 'Edit base network policy' }).click();
  const editor = drawer.getByRole('textbox', { name: 'Base policy JSON' });
  await editor.fill('[]');
  await drawer.getByRole('button', { name: 'Review changes' }).click();
  await expect(drawer.getByRole('alert')).toContainText('JSON object');
  await drawer.getByRole('button', { name: 'Reload access' }).click();
  await drawer.getByRole('button', { name: 'Edit base network policy' }).click();
  const policy = JSON.parse(await editor.inputValue());
  delete policy.network_policies.package_registry;
  await editor.fill(JSON.stringify(policy, null, 2));
  await drawer.getByRole('button', { name: 'Review changes' }).click();
  const review = page.getByRole('dialog', { name: 'Apply this network policy?' });
  await expect(review.getByRole('heading', { name: 'Current base policy' })).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Proposed base policy' })).toBeVisible();
  await review.getByRole('button', { name: 'Apply policy', exact: true }).click();
  await expect(drawer.getByText('registry.npmjs.org', { exact: true })).toHaveCount(0);
  await expect(drawer.getByText('api.anthropic.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('OpenShell was not contacted');
});

test('activity fetch is bounded in the UI and keyboard navigation works', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'research-assistant' }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
  await expect(drawer.locator('.log-view')).toContainText('NET:OPEN');
  await expect(drawer.getByText('Up to 150 lines from the last hour.')).toBeVisible();
  await drawer.getByRole('tab', { name: 'Activity', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(drawer.getByRole('tab', { name: 'Permissions' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('gateway and workspace selections are scoped to the session', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('combobox', { name: 'OpenShell gateway' }).selectOption('studio-remote');
  await page.getByRole('button', { name: 'OpenShell & settings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace name' }).fill('--global');
  await page.getByRole('button', { name: 'Use workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('valid OpenShell workspace name');
  await page.getByRole('textbox', { name: 'Workspace name' }).fill('team-research');
  await page.getByRole('button', { name: 'Use workspace' }).click();
  await expect(page.locator('.workspace-pill')).toHaveText('team-research');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test('update check is explicit and sample result is not presented as live', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'OpenShell & settings', exact: true }).click();
  await expect(page.getByText('Keep your guardrails up to date')).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('OpenShell 0.1.3 is available')).toBeVisible();
  await expect(
    page.getByText('Sample result only. This is not a live release check.'),
  ).toBeVisible();
});

test('small-screen layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 930 });
  await page.goto('/?preview=1');
  await expect(page.locator('.agent-card')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/preview-mobile.png', fullPage: true });
});

test('automatic app updates default on and sample controls remain simulated', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'OpenShell & settings', exact: true }).click();
  const updates = page.getByRole('region', { name: 'ShellGuardian updates' });
  const toggle = updates.getByRole('switch', { name: 'Automatic ShellGuardian updates' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await updates.getByRole('button', { name: 'Check ShellGuardian' }).click();
  await expect(updates.getByRole('button', { name: 'Download update' })).toBeVisible();
  await updates.getByRole('button', { name: 'Download update' }).click();
  await expect(updates).toContainText('No app update is downloaded or installed');
  await updates.getByRole('button', { name: 'Restart to update' }).click();
  await expect(page.getByRole('status').last()).toContainText('restart simulated');
  await toggle.check();
  await expect(toggle).toBeChecked();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('desktop bridge errors preserve uncertainty instead of showing sample data', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {
        invoke: async () => ({
          installedVersion: '0.1.2',
          gateways: [
            {
              name: 'offline',
              active: true,
              endpoint: 'http://127.0.0.1:18080',
              auth: 'plaintext',
              is_remote: false,
              remote_host: null,
            },
          ],
          scope: { gateway: 'offline', workspace: 'default' },
          status: null,
          agents: [],
          providers: [],
          observedAt: Date.now(),
          notices: [
            { area: 'connection', message: 'Connection refused' },
            { area: 'agents', message: 'Inventory unavailable' },
            { area: 'providers', message: 'Inventory unavailable' },
          ],
        }),
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agent inventory is unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Connection refused');
  await expect(page.getByText('research-assistant', { exact: true })).toHaveCount(0);
  await expect(page.locator('.summary-card').first().locator('small')).toHaveText(
    'Inventory unavailable',
  );
});

test('uncertain mutation failures require refresh and never retry automatically', async ({
  page,
}) => {
  await page.addInitScript(
    (payload: string) => {
      const { snapshot, detail } = JSON.parse(payload) as { snapshot: unknown; detail: unknown };
      const calls: string[] = [];
      Object.defineProperty(window, 'isTauri', { value: true });
      Object.defineProperty(window, '__shellguardianCalls', { value: calls });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          invoke: async (command: string) => {
            calls.push(command);
            if (command === 'get_snapshot') return snapshot;
            if (command === 'get_agent_detail') return detail;
            if (command === 'check_openshell_updates')
              return { status: 'unavailable', error: 'Release service unavailable' };
            if (command === 'change_agent_state')
              throw { message: 'OpenShell timed out. A change may already be saved.' };
            throw new Error('Unexpected test command');
          },
        },
      });
    },
    JSON.stringify({
      snapshot: sampleSnapshot,
      detail: sampleDetail('research-assistant', sampleSnapshot),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
  await drawer.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Stop this sandbox?' });
  await review.getByRole('button', { name: 'Stop sandbox', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('may already be saved');
  await expect(review.getByRole('button', { name: 'Stop sandbox', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => Reflect.get(window, '__shellguardianCalls') as string[]);
  expect(calls.filter((command) => command === 'change_agent_state')).toHaveLength(1);
  await review.getByRole('button', { name: 'Close and refresh current state' }).click();
  await expect(review).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Stop sandbox', exact: true })).toBeVisible();
});
