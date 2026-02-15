import type { Pool } from "pg";

/**
 * PostgreSQL implementations of Bilibili's bvid<->aid conversion.
 *
 * Algorithm is identical to src/utils/bvid.ts — any changes there must be
 * mirrored here. The DB functions are used for all in-database conversions
 * (markVideoDeleted, repairAids, ad-hoc queries) so application code never
 * needs to import the JS helpers.
 *
 * bv2av(text)  → BIGINT
 * av2bv(BIGINT) → TEXT
 */
export async function initFunctionsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION bv2av(bvid TEXT) RETURNS BIGINT
    LANGUAGE plpgsql IMMUTABLE STRICT AS $$
    DECLARE
      tbl       CONSTANT TEXT   := 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
      xor_code  CONSTANT BIGINT := 23442827791579;
      mask_code CONSTANT BIGINT := 2251799813685247;
      chars TEXT;
      tmp   BIGINT := 0;
      i     INT;
    BEGIN
      -- After swapping 0-indexed positions [3]↔[9] and [4]↔[7], then
      -- removing the "BV1" prefix, the 9 payload chars come from the
      -- original bvid at 1-indexed positions: 10,8,6,7,5,9,4,11,12
      chars := SUBSTR(bvid,10,1) || SUBSTR(bvid, 8,1) || SUBSTR(bvid, 6,1)
            || SUBSTR(bvid, 7,1) || SUBSTR(bvid, 5,1) || SUBSTR(bvid, 9,1)
            || SUBSTR(bvid, 4,1) || SUBSTR(bvid,11,1) || SUBSTR(bvid,12,1);
      FOR i IN 1..9 LOOP
        tmp := tmp * 58 + (POSITION(SUBSTR(chars,i,1) IN tbl) - 1);
      END LOOP;
      RETURN (tmp & mask_code) # xor_code;
    END;
    $$
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION av2bv(aid BIGINT) RETURNS TEXT
    LANGUAGE plpgsql IMMUTABLE STRICT AS $$
    DECLARE
      tbl      CONSTANT TEXT   := 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
      xor_code CONSTANT BIGINT := 23442827791579;
      max_aid  CONSTANT BIGINT := 2251799813685248;
      bytes    TEXT[] := ARRAY['B','V','1','0','0','0','0','0','0','0','0','0'];
      idx      INT    := 12;
      tmp      BIGINT;
      swap     TEXT;
    BEGIN
      tmp := (max_aid | aid) # xor_code;
      WHILE tmp > 0 LOOP
        bytes[idx] := SUBSTR(tbl, (tmp % 58)::INT + 1, 1);
        tmp := tmp / 58;
        idx := idx - 1;
      END LOOP;
      -- Swap TypeScript 0-indexed [3]↔[9] → PL/pgSQL 1-indexed [4]↔[10]
      swap := bytes[4];  bytes[4]  := bytes[10]; bytes[10] := swap;
      -- Swap TypeScript 0-indexed [4]↔[7] → PL/pgSQL 1-indexed [5]↔[8]
      swap := bytes[5];  bytes[5]  := bytes[8];  bytes[8]  := swap;
      RETURN ARRAY_TO_STRING(bytes, '');
    END;
    $$
  `);
}
