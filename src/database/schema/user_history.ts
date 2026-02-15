import type { Pool } from "pg";
import { logger } from "../../utils/logger.js";

export async function initUserHistorySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profile_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_name VARCHAR,
      face VARCHAR,
      fans INTEGER,
      sign VARCHAR,
      level SMALLINT,
      official_role SMALLINT,
      official_title VARCHAR
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_uph_user_time
    ON user_profile_history(user_id, recorded_at DESC)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_user_profile_history()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT'
         OR OLD.user_name      IS DISTINCT FROM NEW.user_name
         OR OLD.face           IS DISTINCT FROM NEW.face
         OR OLD.fans           IS DISTINCT FROM NEW.fans
         OR OLD.sign           IS DISTINCT FROM NEW.sign
         OR OLD.level          IS DISTINCT FROM NEW.level
         OR OLD.official_role  IS DISTINCT FROM NEW.official_role
         OR OLD.official_title IS DISTINCT FROM NEW.official_title
      THEN
        INSERT INTO user_profile_history
          (user_id, recorded_at, user_name, face, fans, sign, level, official_role, official_title)
        VALUES
          (NEW.user_id, NOW(), NEW.user_name, NEW.face, NEW.fans,
           NEW.sign, NEW.level, NEW.official_role, NEW.official_title);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_user_profile_history ON discovered_users
  `);
  await pool.query(`
    CREATE TRIGGER trg_user_profile_history
    AFTER INSERT OR UPDATE ON discovered_users
    FOR EACH ROW EXECUTE FUNCTION fn_user_profile_history()
  `);

  try {
    await pool.query(`
      SELECT create_hypertable(
        'user_profile_history', 'recorded_at',
        if_not_exists => TRUE,
        migrate_data   => TRUE
      )
    `);
    logger.info("user_profile_history: TimescaleDB hypertable enabled");
  } catch {
    logger.debug(
      "user_profile_history: TimescaleDB not available, using plain table",
    );
  }
}
