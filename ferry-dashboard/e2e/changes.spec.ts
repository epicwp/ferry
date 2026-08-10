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

async function createSite(page: Page, name: string, url: string): Promise<number> {
  const res = await page.request.post('/api/sites', { data: { name, url } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as number;
}

async function seedChange(page: Page, siteId: number, extra: Record<string, unknown> = {}): Promise<{ seq: number }> {
  const res = await page.request.post('/e2e/changes', { data: { siteId, ...extra } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test('the changes tab lists changes with status pills, filters and a draft badge', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'List shop', `https://list-${Date.now()}.example.com`);
  await seedChange(page, siteId); // draft
  await seedChange(page, siteId, { status: 'pushed' });
  await seedChange(page, siteId, { status: 'rolled_back' });

  await page.goto(`/sites/${siteId}/changes`);
  await expect(page.locator('.changes__title')).toHaveText('Changes');
  await expect(page.locator('.change-row')).toHaveCount(3);
  await expect(page.locator('.change-row--draft .status-pill')).toHaveText('draft');
  await expect(page.locator('.status-pill--pushed')).toHaveText('pushed');
  await expect(page.locator('.status-pill--rolled_back')).toHaveText('rolled back');
  // draft row: amber border + Push action; others: View
  await expect(page.locator('.change-row--draft').getByRole('button', { name: 'Push' })).toBeVisible();
  await expect(page.locator('.change-row').filter({ hasText: 'pushed' }).first().getByRole('link', { name: 'View' })).toBeVisible();
  // filter pills with counts
  await expect(page.locator('.filter-pill--active')).toHaveText('all 3');
  await page.getByRole('button', { name: 'draft 1' }).click();
  await expect(page.locator('.change-row')).toHaveCount(1);
  // sidebar: Changes is a live link here with the draft-count badge
  await expect(page.locator('.sidebar__badge')).toHaveText('1');
  // standing constraint: no clickable clone URL anywhere
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
});

test('an empty changes tab shows the empty state', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Empty shop', `https://empty-${Date.now()}.example.com`);
  await page.goto(`/sites/${siteId}/changes`);
  await expect(page.getByText('No changes yet')).toBeVisible();
});

test('a draft change page shows the full card and can be discarded', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Draft shop', `https://draft-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.locator('.breadcrumb__here')).toHaveText('CHANGE-0001');
  await expect(page.locator('.change-head__title')).toHaveText('VAT calculation fixed');
  await expect(page.locator('.change-summary')).toContainText('I have fixed both');
  // diff: two file blocks, add/del coloring
  await expect(page.locator('.diff-file')).toHaveCount(2);
  await expect(page.locator('.diff-line--add').first()).toBeVisible();
  await expect(page.locator('.diff-line--del').first()).toBeVisible();
  await expect(page.getByText('2 files changed')).toBeVisible();
  // DB journal: risk chip + old/new
  await expect(page.locator('.risk-chip')).toHaveText('low risk');
  await expect(page.locator('.ops-table')).toContainText('woocommerce_tax_display_cart');
  await expect(page.locator('.ops-old')).toHaveText('incl');
  await expect(page.locator('.ops-new')).toHaveText('excl');
  // preconditions + smoke plan + drift preview (scripted hashes match)
  await expect(page.locator('.precondition')).toHaveCount(1);
  await expect(page.locator('.drift-strip__state--ok')).toHaveText('production unchanged');
  await expect(page.getByText('if one fails → automatic rollback')).toBeVisible();
  // actions
  await expect(page.getByRole('button', { name: 'Push to production' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes`);
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
});

test('the drift preview reports a drifted production honestly', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Drifted preview', `https://driftedpreview-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);
  await expect(page.locator('.drift-strip__state--bad')).toContainText('production drifted');
});
