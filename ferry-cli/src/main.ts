#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { fetchUploads } from './fetch-uploads.js';
import { runGit } from './git.js';
import { link } from './link.js';
import { loadProfile } from './profile.js';
import { pull } from './pull.js';
import { push } from './push.js';
import type { ChangeSpec } from './push-types.js';

const program = new Command();

program
  .name('ferry')
  .description('Give coding agents safe local access to WordPress sites - clone, debug at production parity, push back under control.');

program
  .command('link <url>')
  .description('Pair with a WordPress site running the Ferry Connect plugin')
  .requiredOption('--code <code>', 'pairing code shown by the plugin')
  .option('--dir <path>', 'directory for the local clone')
  .action(async (url: string, opts: { code: string; dir?: string }) => {
    const profile = await link(url, opts.code, opts.dir);
    console.log(`✔ Paired with ${profile.url}`);
    console.log(`  Clone directory: ${profile.clonePath}`);
    console.log(`  Next: ferry pull ${profile.slug}`);
  });

program
  .command('pull <site>')
  .description('Clone the site into a local DDEV environment at production parity')
  .option('--full', 'pull the complete database (skip the lite exclusions)')
  .action(async (site: string, opts: { full?: boolean }) => {
    const result = await pull(site, {}, { full: opts.full });
    console.log(`✔ Clone ready: ${result.url}`);
    console.log(`  Admin: ${result.url}/wp-admin/ - ${result.adminUser} / ${result.adminPassword}`);
    console.log(
      result.liteSkip.length > 0
        ? `  Lite DB pull: skipped ${result.liteSkip.join(', ')} (use --full for everything)`
        : '  Full DB pull: no exclusions',
    );
    console.log('  Media is not cloned upfront - missing uploads materialize from production on first request (ferry fetch-uploads for bulk).');
    console.log(
      `  Committed production snapshot ${result.commit.slice(0, 7)}` +
        (result.neutralizedRepos > 0 ? ` (${result.neutralizedRepos} nested repo(s) neutralized)` : ''),
    );
    console.log(`  Files: ${result.provenance.reused} reused, ${result.provenance.reconstructed} reconstructed, ${result.provenance.fetched} fetched`);
    console.log(`  Provenance: ${result.provenance.summary}`);
    console.log(`    Report: ${result.provenance.reportPath}`);
    if (result.skipped.length > 0) {
      console.log(`  Skipped ${result.skipped.length} unreadable file(s): ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', ...' : ''}`);
    }
  });

program
  .command('fetch-uploads <site> [prefix]')
  .description('Materialize production uploads into the clone (e.g. 2026/07/), or everything with --all')
  .option('--all', 'fetch every upload')
  .action(async (site: string, prefix: string | undefined, opts: { all?: boolean }) => {
    const result = await fetchUploads(site, { prefix, all: opts.all });
    console.log(`✔ Materialized ${result.fetched} file(s) (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
    if (result.skipped.length > 0) {
      console.log(`  Skipped ${result.skipped.length} (gone on production, or failed hash verification): ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', ...' : ''}`);
    }
  });

program
  .command('push <site>')
  .description('Push staged changes back to production: stage, two-phase commit, smoke test, automatic rollback on failure')
  .requiredOption('--spec <file>', 'path to the ChangeSpec JSON file')
  .option('--force', 'skip drift checks (dangerous)')
  .action(async (site: string, opts: { spec: string; force?: boolean }) => {
    const profile = loadProfile(site);
    const spec = JSON.parse(readFileSync(opts.spec, 'utf8')) as ChangeSpec;
    const headSha = await runGit(profile.clonePath, ['rev-parse', 'HEAD']);
    const result = await push(site, spec, {
      headSha,
      force: opts.force,
      onStep: (e) => {
        const duration = e.durationMs !== undefined ? ` (${e.durationMs}ms)` : '';
        const detail = e.detail ? ` — ${e.detail}` : '';
        console.log(`  ${e.step} ${e.status}${duration}${detail}`);
      },
    });
    if (result.status === 'pushed') {
      console.log(`✔ Pushed (txid ${result.txid})`);
      for (const s of result.smoke) {
        console.log(`  smoke: ${s.label} ${s.ok ? 'OK' : 'FAIL'} — ${s.detail}`);
      }
      return;
    }
    if (result.status === 'conflict') {
      console.error(`✖ Conflict (txid ${result.txid})`);
      for (const c of result.conflicts) {
        console.error(`  ${c.key}: expected ${c.expected}, found ${c.found}`);
      }
    } else if (result.status === 'rolled_back') {
      console.error(`✖ Rolled back (txid ${result.txid}): ${result.reason}`);
      for (const s of result.smoke ?? []) {
        console.error(`  smoke: ${s.label} ${s.ok ? 'OK' : 'FAIL'} — ${s.detail}`);
      }
    } else if (result.status === 'error') {
      console.error(`✖ Error (txid ${result.txid}): ${result.detail}`);
    }
    process.exit(1);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
