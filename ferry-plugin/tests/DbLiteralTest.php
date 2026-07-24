<?php
use Ferry\Db;
use PHPUnit\Framework\TestCase;

final class DbLiteralTest extends TestCase
{
    public function test_null_is_null(): void
    {
        $this->assertSame('NULL', Db::literal(null, false));
        $this->assertSame('NULL', Db::literal(null, true));
    }

    public function test_numeric_column_values_stay_bare(): void
    {
        $this->assertSame('42', Db::literal('42', true));
        $this->assertSame('-3.5', Db::literal('-3.5', true));
        $this->assertSame('0', Db::literal('0', true));
    }

    public function test_string_values_become_hex(): void
    {
        // h=68 é=c3a9 l=6c l=6c o=6f space=20 rocket=f09f9a80
        $this->assertSame('0x68c3a96c6c6f20f09f9a80', Db::literal("h\xc3\xa9llo \xf0\x9f\x9a\x80", false));
    }

    public function test_leading_zero_varchar_is_not_treated_as_number(): void
    {
        $this->assertSame('0x30313233', Db::literal('0123', false));
    }

    public function test_empty_string(): void
    {
        $this->assertSame("''", Db::literal('', false));
    }

    public function test_unexpected_value_in_numeric_column_falls_back_to_hex(): void
    {
        $this->assertSame('0x6e6f7065', Db::literal('nope', true));
    }

    public function test_numeric_map_from_show_columns(): void
    {
        $rows = [
            ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],
            ['Field' => 'post_content', 'Type' => 'longtext'],
            ['Field' => 'price', 'Type' => 'decimal(10,2)'],
            ['Field' => 'ratio', 'Type' => 'double'],
            ['Field' => 'blob_data', 'Type' => 'varbinary(255)'],
            ['Field' => 'geo', 'Type' => 'point'],
            ['Field' => 'geo_multi', 'Type' => 'multipoint'],
        ];
        $this->assertSame(
            ['ID' => true, 'post_content' => false, 'price' => true, 'ratio' => true, 'blob_data' => false, 'geo' => false, 'geo_multi' => false],
            Db::numeric_map($rows)
        );
    }
}
