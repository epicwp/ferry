import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const FIXTURE_DIR = process.env.FERRY_E2E_PROD ?? join(process.env.HOME ?? '', 'ferry-e2e', 'prod');
const SITE_URL = process.env.FERRY_E2E_URL ?? 'https://ferry-prod.ddev.site';

function pairingCode(): string {
  const raw = execFileSync(
    'ddev',
    ['wp', 'eval', 'print(json_encode(\\Ferry\\Auth::issue_pairing_code()));'],
    { cwd: FIXTURE_DIR, encoding: 'utf8' },
  ).trim();
  return (JSON.parse(raw.slice(raw.indexOf('{'))) as { code: string }).code;
}

/** Each test gets its own account; the server (and its DB) is fresh per Playwright run. */
async function signUp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
}

test('sign up lands in the dashboard shell', async ({ page }) => {
  await signUp(page);
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
});

test('a wrong password shows an inline error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('.form-error')).toContainText('Wrong email or password.');
  await expect(page).toHaveURL('/login');
});

test('a fresh account sees the empty sites state', async ({ page }) => {
  await signUp(page);
  await expect(page.getByText('Connect your first WordPress site')).toBeVisible();
  await expect(page.getByText('no connected sites')).toBeVisible();
  await expect(page.getByText('0 sites')).toBeVisible();
});

test('creating a site shows install instructions with the plugin download', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await expect(page).toHaveURL('/sites/new');
  await page.getByLabel('Name').fill('Demo');
  await page.getByLabel('Site URL').fill('https://demo-site.example');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/sites\/\d+\/install$/);
  await expect(page.locator('a[href="/api/plugin.zip"]')).toBeVisible();
  await expect(page.getByText('wp plugin install ferry-connect.zip --activate')).toBeVisible();
  await page.getByRole('button', { name: /I have a code/ }).click();
  await expect(page).toHaveURL(/\/pair$/);
});

test('a bad site id on the install page shows an error instead of a blank page', async ({ page }) => {
  await signUp(page);
  await page.goto('/sites/999999/install');
  await expect(page.locator('.form-error')).toContainText('Site not found.');
});

test('a failed pair shows an inline error and stays on the pairing screen', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await page.getByLabel('Name').fill('Unreachable');
  await page.getByLabel('Site URL').fill('https://127.0.0.1:9');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /I have a code/ }).click();
  await page.getByPlaceholder('XXXX-XXXX').fill('AAAA-BBBB');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.form-error')).toBeVisible();
  await expect(page).toHaveURL(/\/pair$/);
});

test('3b gate: sign up → add site → pair → watch progress → ready in the list', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await page.getByLabel('Name').fill('Ferry Prod');
  await page.getByLabel('Site URL').fill(SITE_URL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /I have a code/ }).click();

  // wrong code first: inline error, stays on the pairing screen (screen 3 scope)
  await page.getByPlaceholder('XXXX-XXXX').fill('AAAA-BBBB');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.form-error')).toBeVisible();
  await expect(page).toHaveURL(/\/pair$/);

  // real code from the fixture plugin
  await page.getByPlaceholder('XXXX-XXXX').fill(pairingCode());
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page).toHaveURL(/\/sync$/);

  // flow step 5: connection test, then start the first sync
  await expect(page.getByText(/Connected — WordPress/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Start first sync' }).click();
  await expect(page.getByText('Transferring unique files')).toBeVisible({ timeout: 30_000 });

  // done: verified clone, URL as copyable text — never a link (§1 decision)
  await expect(page.getByText('Clone verified ✓')).toBeVisible({ timeout: 150_000 });
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
  expect(page.url()).not.toContain('admin');

  await page.getByRole('button', { name: 'Back to sites' }).click();
  await expect(page.locator('.chip--ready')).toBeVisible();
  await expect(page.getByText(/synced (just now|\d+ min ago)/)).toBeVisible();
});
