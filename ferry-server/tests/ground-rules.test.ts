import { describe, expect, it } from 'vitest';
import { groundRules } from '../src/agent/ground-rules.js';

// Snapshot of groundRules('klant-nl') as it read before Task 9 introduced envKind, plus the
// file_hash-sha256 contract line (bug 10) — the ddev variant must stay byte-identical.
const DDEV_SNAPSHOT = `# Ferry clone — agent session ground rules

You are the Ferry agent, working in a clone of the production WordPress site "klant-nl".
Work as you would in any WordPress codebase: grep, read, and edit files; run shell commands.

- wp-cli runs as \`ddev wp <args>\` from the clone root. Plain \`wp\` is not installed here.
- You are on the git branch \`agent/work\`. Commit your changes there with clear messages.
  NEVER run \`git push\`. Never commit to or reset the \`production\` branch —
  \`git diff production\` is exactly what would ship to production.
- The database is a point-in-time snapshot. Production owns the live data — do not assume
  orders, users, or options here are current.
- The clone is airtight: outbound email and HTTP are blocked; license checks (EDD, Freemius,
  WooCommerce.com) are answered locally with valid stubs. This is expected, not a bug.
  Missing uploads are fetched from production on first request; use the ferry
  \`fetch_uploads\` tool to bulk-fetch.
- Never edit ferry/DDEV artifacts: \`wp-config.php\`, anything under \`.ddev/\`,
  \`wp-content/mu-plugins/ferry-*\`, \`ferry-uploads-fallback.php\`. Drop-ins renamed to
  \`*.php.ferry-disabled\` are disabled on purpose.
- When asked to fix something: state a short plan first, implement it on \`agent/work\`,
  verify inside the clone (\`ddev wp\`, or request the page), then summarize what changed
  and why in plain language.
- To finalize a fix: commit your code changes on \`agent/work\` first. If the fix touched the
  database, call \`db_journal\` to see typed DB operations recorded since the last sync, and
  curate them — include only the ops that belong to your fix, discard the rest. Then call
  \`create_change\` with an honest title, summary, the curated ops, and real preconditions/
  smoke checks that would actually catch a regression. A \`file_hash\` precondition's
  \`expected\` is the sha256 of the baseline file as 64 lowercase hex chars
  (\`git show production:PATH | sha256sum\`) — never md5; production compares sha256.
  This creates a draft change card —
  pushing it to production is the human's call, not yours; you have no push tool.`;

describe('groundRules', () => {
  it('ddev variant is byte-identical to the pre-Task-9 text', () => {
    expect(groundRules('klant-nl', 'ddev')).toBe(DDEV_SNAPSHOT);
  });

  it('both variants pin the file_hash precondition digest to sha256 (the plugin compares sha256)', () => {
    for (const kind of ['ddev', 'fly'] as const) {
      expect(groundRules('klant-nl', kind)).toContain('sha256sum');
      expect(groundRules('klant-nl', kind)).toContain('never md5');
    }
  });

  it('fly variant drops every ddev-specific instruction and path', () => {
    const text = groundRules('klant-nl', 'fly');
    expect(text).not.toContain('ddev wp');
    expect(text).not.toContain('.ddev/');
    expect(text).not.toContain('DDEV');
  });

  it('fly variant explains the wp tool replaces the ddev binary', () => {
    const text = groundRules('klant-nl', 'fly');
    expect(text).toContain('wp-cli runs through the ferry `wp` tool (argv array). There is no local wp or ddev binary.');
  });

  it('fly variant never-edit list drops .ddev/ but keeps the other protected paths', () => {
    const text = groundRules('klant-nl', 'fly');
    expect(text).toContain('wp-config.php');
    expect(text).toContain('wp-content/mu-plugins/ferry-*');
    expect(text).toContain('ferry-uploads-fallback.php');
  });

  it('fly variant tells the agent to verify via the wp tool or the clone URL', () => {
    const text = groundRules('klant-nl', 'fly');
    expect(text).toContain('verify via the ferry `wp` tool or by requesting the clone URL');
    expect(text).not.toContain('verify inside the clone');
  });
});
