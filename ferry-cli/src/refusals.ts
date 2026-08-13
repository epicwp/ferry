/**
 * Single source of the content-table refusal policy (Global Constraints: DB content
 * never travels through a change card). ferry-cli's journal classifier and
 * ferry-server's change validation import this; ferry-plugin/src/DbOps.php keeps its
 * own copy (zero-dep native PHP, no build step) — tests/refusals-parity.test.ts
 * asserts the copies stay semantically identical.
 */
export const REFUSED_TABLES = ['posts', 'comments', 'commentmeta', 'users', 'usermeta'];
export const REFUSED_PREFIXES = ['woocommerce_', 'wc_', 'actionscheduler_'];

/** Strip the site's table prefix, lowercasing both sides — MySQL table names are
 *  effectively case-insensitive on the usual collations/filesystems (mirrors
 *  DbOps::table_refused). The returned name is lowercase. */
export function stripTablePrefix(table: string, prefix: string): string {
  const lowerTable = table.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  return lowerTable.startsWith(lowerPrefix) ? lowerTable.slice(lowerPrefix.length) : lowerTable;
}

/** `bare` must already be prefix-stripped (lowercased here defensively). */
export function isRefusedBareTable(bare: string): boolean {
  const lower = bare.toLowerCase();
  return REFUSED_TABLES.includes(lower) || REFUSED_PREFIXES.some((p) => lower.startsWith(p));
}
