import { expect, test, type Page } from '@playwright/test';

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
