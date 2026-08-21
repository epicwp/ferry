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

test('a bad site id on the sync page shows an error instead of a blank page', async ({ page }) => {
  await signUp(page);
  await page.goto('/sites/999999/sync');
  await expect(page.locator('.form-error')).toContainText('Site not found.');
});

test('an unknown route redirects to the sites list', async ({ page }) => {
  await signUp(page);
  await page.goto('/definitely-not-a-route');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
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
  expect(await page.locator('a[href*="fly.dev"]').count()).toBe(0);
  expect(page.url()).not.toContain('admin');

  await page.getByRole('button', { name: 'Back to sites' }).click();
  await expect(page.locator('.chip--ready')).toBeVisible();
  await expect(page.getByText(/synced (just now|\d+ min ago)/)).toBeVisible();

  // --- Plan 4: agent chat on the ready site (scripted runner — no API tokens) ---
  await page.goto('/');
  await page.getByRole('button', { name: 'Open' }).click();          // ready site -> /sites/:id
  // 'Agent chat' also labels the sidebar nav item, so scope to the chat header title.
  await expect(page.locator('.chat__title')).toHaveText('Agent chat');
  await expect(page.getByText('SSE live')).toBeVisible();
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0); // binding constraint: no clone link, ever (§1 decision)
  expect(await page.locator('a[href*="fly.dev"]').count()).toBe(0);

  const composer = page.getByPlaceholder('Ask a follow-up or request another fix…');
  await composer.fill('Why is VAT wrong on orders above €100?');
  await page.getByRole('button', { name: 'Send message' }).click();

  // Scoped to the user-bubble class: the final agent text below echoes this same string,
  // so an unscoped getByText matches both bubbles (strict-mode violation).
  await expect(page.locator('.chat__msg--user')).toHaveText('Why is VAT wrong on orders above €100?'); // user bubble via SSE echo
  await expect(page.getByText('Grep')).toBeVisible();                 // tool row
  await expect(page.getByText('functions.php:412')).toBeVisible();    // tool result
  await expect(page.getByText(/Plan: check the tax settings/)).toBeVisible(); // final agent text

  // Tool rows start collapsed to a single truncated line; the chevron expands and re-collapses.
  const toolRow = page.locator('.chat__toolrow');
  await expect(toolRow).not.toHaveClass(/chat__toolrow--open/);
  const collapsedHeight = (await toolRow.boundingBox())?.height ?? 0;
  await toolRow.locator('.chat__tool-chevron').click();
  await expect(toolRow).toHaveClass(/chat__toolrow--open/);
  expect((await toolRow.boundingBox())?.height ?? 0).toBeGreaterThan(collapsedHeight);
  await toolRow.locator('.chat__tool-chevron').click();
  await expect(toolRow).not.toHaveClass(/chat__toolrow--open/);

  // history survives reload
  await page.reload();
  await expect(page.getByText(/Plan: check the tax settings/)).toBeVisible();

  // SSE error state is visible, not a silent freeze (3b fold-in). Note: browser-context
  // setOffline() does not interrupt an already-open EventSource stream (verified against a
  // minimal repro — heartbeats kept flowing while "offline"); it only blocks new connection
  // attempts. So we force a fresh, blocked connection attempt instead: intercept the events
  // endpoint, then reload (remounts the chat and opens a new EventSource, which now fails).
  await page.route('**/agent/events*', (route) => route.abort());
  await page.reload();
  await expect(page.getByText('connection lost')).toBeVisible();
  await page.unroute('**/agent/events*');
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByText('SSE live')).toBeVisible();

  // new session escape hatch clears the thread
  await page.getByRole('button', { name: 'Start a new session' }).click();
  await expect(page.getByText(/Plan: check the tax settings/)).not.toBeVisible();
  await expect(page.getByText('New session started.')).toBeVisible();

  // ---- 5b: runner errors are visible (issue #9) ----
  await page.getByPlaceholder('Ask a follow-up or request another fix…').fill('trigger-runner-error');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat__status--error')).toContainText('The agent hit an internal error');

  // ---- 5b: inline change card over live SSE ----
  const siteId = Number(page.url().match(/sites\/(\d+)/)![1]);
  const seedRes = await page.request.post('/e2e/changes', { data: { siteId, emitCard: true } });
  expect(seedRes.ok()).toBeTruthy();
  const seeded = await seedRes.json();
  await expect(page.locator('.ccard')).toBeVisible();
  await expect(page.locator('.ccard__title')).toHaveText('VAT calculation fixed');
  await expect(page.locator('.ccard')).toContainText('2 files changed');
  await expect(page.locator('.ccard')).toContainText('nothing goes to production automatically');
  // composer stays usable with the card in the feed
  await expect(page.getByPlaceholder('Ask a follow-up or request another fix…')).toBeEnabled();

  // The card must keep its height when the chat overflows the viewport. The chat body is a
  // flex column; an overflow:hidden child's automatic min-height is 0, so without flex-shrink:0
  // the card (and tool blocks) get squeezed toward a ~2px strip once the thread is long enough.
  const fullHeight = (await page.locator('.ccard').boundingBox())?.height ?? 0;
  await page.setViewportSize({ width: 1280, height: 300 });
  const squeezedHeight = (await page.locator('.ccard').boundingBox())?.height ?? 0;
  expect(squeezedHeight).toBeGreaterThanOrEqual(fullHeight - 5);
  await page.setViewportSize({ width: 1280, height: 720 });

  // replayed from history after a reload
  await page.reload();
  await expect(page.locator('.ccard')).toBeVisible();

  // ---- 5b: a failed change-detail fetch degrades honestly, not silently ----
  await page.route('**/api/sites/*/changes/*', (route) => {
    const r = route.request();
    if (r.method() === 'GET' && /\/api\/sites\/\d+\/changes\/\d+$/.test(r.url())) return route.abort();
    return route.continue();
  });
  await page.reload();
  await expect(page.locator('.ccard__title')).toHaveText('VAT calculation fixed'); // from the event payload, not the failed fetch
  await expect(page.locator('.ccard')).toContainText("Couldn't load the change details — open it via View diff.");
  await expect(page.getByRole('link', { name: 'View diff' })).toBeVisible();
  await page.unroute('**/api/sites/*/changes/*');
  await page.reload();
  await expect(page.locator('.ccard')).toContainText('2 files changed'); // healthy again for the sections below

  // View diff navigates to the change page
  await page.getByRole('link', { name: 'View diff' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes/${seeded.seq}`);
  await expect(page.locator('.change-head__title')).toHaveText('VAT calculation fixed');
  await page.goBack();

  // ---- 5b: the one click, straight from the card (turn-scoped guard, Task 12) ----
  // The chat session is hot but idle — this must NOT 409.
  await page.locator('.ccard').getByRole('button', { name: 'Push to production' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes/${seeded.seq}`);
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
  await page.goBack();

  // ---- 6a: rolling back and clicking "Let the agent adjust it" prefills the composer
  // with the rollback nudge (issue #11), but a reload must not re-seed it — the useEffect
  // in chat.tsx clears the history state right after consuming it.
  await page.goto(`/sites/${siteId}/changes/${seeded.seq}`);
  await page.getByRole('button', { name: '↺ Roll back' }).click();
  await expect(page.getByText('Your site is back to how it was')).toBeVisible();
  await page.getByRole('link', { name: 'Let the agent adjust it' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}`);
  const adjustComposer = page.getByPlaceholder('Ask a follow-up or request another fix…');
  await expect(adjustComposer).toHaveValue(
    `CHANGE-${String(seeded.seq).padStart(4, '0')} ("VAT calculation fixed") was rolled back — please take another look and adjust the fix.`,
  );
  await page.reload();
  await expect(adjustComposer).toHaveValue('');

  // ---- 5b: retry posts the conflict into the chat ----
  const conflictSeed = await page.request.post('/e2e/changes', { data: { siteId, status: 'conflict' } });
  const conflictChange = await conflictSeed.json();
  await page.goto(`/sites/${siteId}/changes/${conflictChange.seq}`);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}`);
  await expect(page.locator('.chat__msg--user').last()).toContainText('hit a conflict');
});
