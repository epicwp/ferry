#!/usr/bin/env node
import { Command } from 'commander';
import { link } from './link.js';
import { pull } from './pull.js';

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
  .action(async (site: string) => {
    const result = await pull(site);
    console.log(`✔ Clone ready: ${result.url}`);
    console.log(`  Admin: ${result.url}/wp-admin/ - ${result.adminUser} / ${result.adminPassword}`);
    console.log('  Media is not cloned - missing uploads fall back to production (302).');
    if (result.skipped.length > 0) {
      console.log(`  Skipped ${result.skipped.length} unreadable file(s): ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', ...' : ''}`);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
