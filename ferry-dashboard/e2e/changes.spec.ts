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
  await seedChange(page, siteId, { status: 'pushed', fields: { title: 'Pushed with smoke' } });
  await seedChange(page, siteId, { status: 'rolled_back' });
  await seedChange(page, siteId, { status: 'pushed', fields: { title: 'Pushed no smoke data' }, smokeResult: null });

  await page.goto(`/sites/${siteId}/changes`);
  await expect(page.locator('.changes__title')).toHaveText('Changes');
  await expect(page.locator('.change-row')).toHaveCount(4);
  await expect(page.locator('.change-row--draft .status-pill')).toHaveText('draft');
  await expect(page.locator('.status-pill--pushed').first()).toHaveText('pushed');
  await expect(page.locator('.status-pill--rolled_back')).toHaveText('rolled back');
  // draft row: amber border + Push action; others: View
  await expect(page.locator('.change-row--draft').getByRole('button', { name: 'Push' })).toBeVisible();
  await expect(page.locator('.change-row').filter({ hasText: 'pushed' }).first().getByRole('link', { name: 'View' })).toBeVisible();
  // honest smoke meta: default smokeResult -> "smoke test ✓"; explicit smokeResult: null -> "smoke unknown"
  const pushedWithSmoke = page.locator('.change-row').filter({ hasText: 'Pushed with smoke' });
  await expect(pushedWithSmoke.locator('.change-row__meta')).toContainText('smoke test ✓');
  const pushedNoSmoke = page.locator('.change-row').filter({ hasText: 'Pushed no smoke data' });
  await expect(pushedNoSmoke.locator('.change-row__meta')).toContainText('smoke unknown');
  await expect(pushedNoSmoke.locator('.change-row__meta')).not.toContainText('smoke test ✓');
  // filter pills with counts
  await expect(page.locator('.filter-pill--active')).toHaveText('all 4');
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

test('pushing a draft walks the six steps once each and lands on the pushed card', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Push shop', `https://push-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  // The scripted runner finishes in ~120ms, so the 13-event burst and the push_done-triggered
  // reload() land within a few ms of each other — PushingView unmounts (status flips to pushed)
  // before the dedupe assertions below get a chance to observe the fully-drained log. The first
  // two GET /changes/:seq calls (the page's mount-time fetch, then the one right after the
  // click, which shows the pushing state in the first place) must stay fast — only the *third*
  // call (fired from push_done, once PushingView is already mounted) is delayed, opening a wide,
  // stable window to assert the deduped log without touching app code or the reducer/dedupe
  // logic under test.
  let reloadCount = 0;
  await page.route(`**/api/sites/${siteId}/changes/${seq}`, async (route) => {
    reloadCount += 1;
    if (reloadCount > 2) await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Push to production' }).click();

  await expect(page.getByText('Nothing is final until the last step succeeds.', { exact: false })).toBeVisible();
  await expect(page.locator('.phase')).toHaveCount(6); // exactly one row per step — duplicate drift start deduped
  await expect(page.locator('.push-log')).toBeVisible();
  // dedupe proof: 13 wire events minus the suppressed duplicate `drift start` = 12 log lines,
  // with the duplicate drift-start marker collapsed to exactly one line.
  await expect(page.locator('.push-log > div')).toHaveCount(12, { timeout: 15_000 });
  await expect(page.locator('.push-log > div', { hasText: 'drift: start' })).toHaveCount(1);
  // the page transitions to the pushed state once the (deliberately delayed) reload resolves
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
});

test('a pushed change shows smoke results and rolls back to screen 12', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Pushed shop', `https://pushed-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId, { status: 'pushed' });
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.getByText('Live on production')).toBeVisible();
  await expect(page.locator('.smoke-row')).toHaveCount(3);
  await expect(page.getByText('€24.79')).toBeVisible();
  await expect(page.getByText('2 files · 1 DB operation')).toBeVisible();
  await expect(page.getByText('.ferry-backup/a3f19c2')).toBeVisible();
  await expect(page.getByText('30 days')).toBeVisible();

  await page.getByRole('button', { name: '↺ Roll back' }).click();
  await expect(page.getByText('Your site is back to how it was')).toBeVisible();
  await expect(page.locator('.verify-row')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Back to chat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Let the agent adjust it' })).toBeVisible();
});

test('a conflicted change shows the read-set table; Force re-pushes after a confirm', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Conflict view', `https://cview-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId, { status: 'conflict' });
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.getByText('Push stopped — production changed in the meantime')).toBeVisible();
  await expect(page.getByText('Nothing was changed on your site.', { exact: false })).toBeVisible();
  await expect(page.locator('.conflict-table__row--data')).toHaveCount(1);
  await expect(page.getByText('now on prod')).toBeVisible();
  // deferred option is NOT rendered (design decision 3)
  await expect(page.getByText('Push the code only')).toHaveCount(0);
  await expect(page.getByText('no backup needed · no rollback needed · production untouched')).toBeVisible();

  // Retry on a non-ready site surfaces the guard honestly
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.form-error')).toHaveText('Sync the site first.');

  // Force → confirm dialog → scripted happy push → pushed
  await page.getByRole('button', { name: 'Force' }).click();
  await expect(page.getByText('Force overwrite?')).toBeVisible();
  await page.getByRole('button', { name: 'Force push' }).click();
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
});

test('a push that hits drift lands on the conflict card', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Conflict push', `https://conflict-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);
  await page.getByRole('button', { name: 'Push to production' }).click();
  await expect(page.getByText('Push stopped — production changed in the meantime')).toBeVisible({ timeout: 15_000 });
});

test('a higher-risk draft routes Push through the confirm dialog', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Higher risk shop', `https://higherrisk-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId, {
    fields: { ops: [{ kind: 'row_update', table: 'wp_wc_custom_rates', pkCol: 'id', pk: 3, old: { rate: '19' }, new: { rate: '21' } }] },
  });
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.locator('.risk-chip')).toHaveText('higher risk');
  await page.getByRole('button', { name: 'Push to production' }).click();
  await expect(page.getByText('Push higher-risk operations?')).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: 'Push to production' }).click();
  await expect(page.locator('.status-pill--pushing, .status-pill--pushed')).toBeVisible({ timeout: 15_000 });
});
