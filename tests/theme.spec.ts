import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectReadable(locator: Locator) {
  const contrast = await locator.evaluate((element) => {
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = (color: string) =>
      channels(color)
        .slice(0, 3)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    let background = getComputedStyle(element).backgroundColor;
    let parent = element.parentElement;
    while (channels(background)[3] === 0 && parent) {
      background = getComputedStyle(parent).backgroundColor;
      parent = parent.parentElement;
    }
    const foreground = luminance(getComputedStyle(element).color);
    const backdrop = luminance(background);
    return (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} theme covers cards, forms, warnings, and review dialogs`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?preview=1');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expectReadable(page.locator('.page-heading p'));
    await expectReadable(page.locator('.agent-card .agent-meta').first());
    await expectReadable(page.locator('.status.good').first());
    await expectReadable(page.locator('.status.attention').first());
    await expectReadable(page.getByRole('textbox', { name: 'Search agents' }));

    await page.getByRole('button', { name: 'Inspect research-assistant', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Agent details for research-assistant' });
    await expectReadable(drawer.locator('.detail-note'));
    await drawer.getByRole('button', { name: 'Edit base network policy' }).click();
    const editor = drawer.getByRole('textbox', { name: 'Base policy JSON' });
    await expectReadable(editor);
    const policy = JSON.parse(await editor.inputValue());
    delete policy.network_policies.package_registry;
    await editor.fill(JSON.stringify(policy, null, 2));
    await drawer.getByRole('button', { name: 'Review changes' }).click();
    const review = page.getByRole('dialog', { name: 'Apply this network policy?' });
    await expectReadable(review.locator('pre').first());
    await expectReadable(review.getByRole('button', { name: 'Apply policy', exact: true }));
    await page.screenshot({ path: `test-results/theme-${theme}-review.png`, fullPage: true });
  });
}

test('system appearance changes update an open window without saving a preference', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?preview=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightCanvas = await page
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkCanvas = await page
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  expect(darkCanvas).not.toBe(lightCanvas);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', lightCanvas);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

async function mockNativeTheme(page: Page, mode: 'normal' | 'race' | 'unavailable') {
  await page.addInitScript((mode) => {
    type Theme = 'light' | 'dark';
    let listener: ((event: { event: string; id: number; payload: Theme }) => void) | undefined;
    let resolveTheme: ((theme: Theme) => void) | undefined;
    Object.assign(window, {
      isTauri: true,
      __changeNativeTheme: (theme: Theme) =>
        listener?.({ event: 'tauri://theme-changed', id: 1, payload: theme }),
      __resolveNativeTheme: (theme: Theme) => resolveTheme?.(theme),
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: (callback: typeof listener) => {
          listener = callback;
          return 1;
        },
        invoke: async (command: string) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:window|theme') {
            if (mode === 'unavailable') throw new Error('Theme unavailable');
            if (mode === 'race')
              return new Promise<Theme>((resolve) => {
                resolveTheme = resolve;
              });
            return 'dark';
          }
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });
  }, mode);
}

test('native theme and changes override browser fallback when available', async ({ page }) => {
  await mockNativeTheme(page, 'normal');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?preview=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() =>
    (window as unknown as { __changeNativeTheme(theme: string): void }).__changeNativeTheme(
      'light',
    ),
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a delayed native read cannot overwrite a newer system theme event', async ({ page }) => {
  await mockNativeTheme(page, 'race');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?preview=1');
  await page.getByRole('heading', { name: 'Give your agents room to work.' }).waitFor();
  await page.evaluate(() => {
    const native = window as unknown as {
      __changeNativeTheme(theme: string): void;
      __resolveNativeTheme(theme: string): void;
    };
    native.__changeNativeTheme('dark');
    native.__resolveNativeTheme('light');
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('unavailable native theme retains live OS media detection', async ({ page }) => {
  await mockNativeTheme(page, 'unavailable');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?preview=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
