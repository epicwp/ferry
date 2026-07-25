<?php
namespace Ferry;

/**
 * Lite-pull exclusion rules (§3.1 posture applied to rows): policy is hardcoded
 * here and selected by NAME from the CLI - never SQL over the wire. Row rules
 * become an AND-clause inside the keyset chunk query; schema-only tables export
 * DROP+CREATE with zero rows so plugins that expect them don't fatal. Every
 * targeted table has an integer PK, so the OFFSET fallback is never involved.
 */
final class DbExcludes
{
    const NAMES = ['revisions', 'transients', 'sessions', 'as_logs', 'as_completed'];

    /** @param mixed $raw @return string[] */
    public static function parse($raw)
    {
        return array_values(array_filter(array_map('trim', explode(',', (string) $raw))));
    }

    /** @return string[] names not in NAMES (fail loud beats a silently-bloated clone) */
    public static function unknown(array $skip)
    {
        return array_values(array_diff($skip, self::NAMES));
    }

    /** @return array{schema_only: bool, where: string[]} filter for one table */
    public static function plan($table, $prefix, array $skip)
    {
        $filter = ['schema_only' => false, 'where' => []];
        foreach ($skip as $name) {
            if ($name === 'sessions' && $table === $prefix . 'woocommerce_sessions') {
                $filter['schema_only'] = true;
            }
            if ($name === 'as_logs' && $table === $prefix . 'actionscheduler_logs') {
                $filter['schema_only'] = true;
            }
            if ($name === 'revisions' && $table === $prefix . 'posts') {
                $filter['where'][] = "post_type <> 'revision'";
            }
            if ($name === 'transients' && $table === $prefix . 'options') {
                // \_ = literal underscore in LIKE (default escape char is backslash)
                $filter['where'][] = "option_name NOT LIKE '\\_transient\\_%' AND option_name NOT LIKE '\\_site\\_transient\\_%'";
            }
            if ($name === 'as_completed' && $table === $prefix . 'actionscheduler_actions') {
                $filter['where'][] = "status NOT IN ('complete','failed','canceled')";
            }
        }
        return $filter;
    }
}
