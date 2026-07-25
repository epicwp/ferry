import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000, // the happy path includes a real initial sync (~25s) — generous headroom
  workers: 1, // flows share one server and one DDEV fixture
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run e2e:server',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
