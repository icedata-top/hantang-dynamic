# icedata_label Collection State Contract

This is the handoff point for adaptive minute V1. `hantang-dynamic` now owns the
collection state tables and exposes the SQL function that a future
`icedata_label` trigger should call after rule labels are written.

## Provided Function

`hantang_dynamic.fn_upsert_collection_state_from_processed_video(...)` is
created during `hantang-dynamic` schema initialization.

Inputs:

1. `p_aid bigint`
2. `p_pubdate bigint`
3. `p_ctime bigint`
4. `p_tid_v2 integer`
5. `p_label_content_type text`
6. `p_label_origin text`
7. `p_labeled_by text`
8. `p_is_deleted boolean`
9. `p_is_filtered boolean`
10. `p_now timestamptz`

Expected trigger behavior in `icedata_label`:

1. Skip `aid < 0` repair rows.
2. When a row is deleted, call the function with `p_is_deleted = true`; existing
   state is disabled with `priority = -1` and ordinary minute due cleared.
3. When `is_filtered = false`, call the function with the current row fields;
   existing state is disabled with `priority = -1`, and rows without state are
   ignored. This check takes precedence over formal positive labels.
4. When rule label output passes, call the function with the formal label fields.
5. When a prior positive row is demoted to a non-positive label or no longer has
   `label_origin = 'rule'` and `labeled_by in ('classification_apply',
   'classification_trigger')`, call the function so existing state is disabled.
6. Do not use `classification_crawler_handoff_events` as the formal integration
   contract.
7. Calls with partial formal label fields are treated as label-not-ready and do
   not disable state. Demotion calls must include all three formal label fields.

Formal positive label predicate:

```sql
is_deleted = false
and label_origin = 'rule'
and labeled_by in ('classification_apply', 'classification_trigger')
and label_content_type in ('vocaloid', 'maybe_vocaloid')
```

`is_filtered = false` overrides the formal predicate and disables or ignores the
row for minute collection.

Temporary fallback before formal label fields are available:

```sql
tid_v2 in (2022, 2061)
```

## Activation Contract

The labeler trigger should be installed with cross-repo sync disabled by
default. It should call the schema-qualified function only when this session
setting is enabled:

```sql
current_setting('icedata_label.enable_collection_state_sync', true) = 'on'
```

Enable only after the labeler runtime session uses the same PostgreSQL database
that contains the `hantang_dynamic` schema and function. PostgreSQL cannot call
this function across databases. Grant access to the labeler DB role:

```sql
GRANT USAGE ON SCHEMA hantang_dynamic TO <labeler_role>;
GRANT EXECUTE ON FUNCTION hantang_dynamic.fn_upsert_collection_state_from_processed_video(
  bigint,bigint,bigint,integer,text,text,text,boolean,boolean,timestamptz
) TO <labeler_role>;
```

A deployment can enable the setting at database, role-in-database, or session
level:

```sql
ALTER DATABASE <labeler_database> SET icedata_label.enable_collection_state_sync = 'on';
ALTER ROLE <labeler_role> IN DATABASE <labeler_database>
  SET icedata_label.enable_collection_state_sync = 'on';
```

The trigger should use `AFTER INSERT OR UPDATE`, not `UPDATE OF`, because the
`icedata_label` classification trigger can write `NEW.label_*` fields in a
`BEFORE` trigger while the original application update touched source fields.

## Current Boundary

The `hantang-dynamic` side provides the trigger integration contract. The
`D:\dev\icedata\icedata_label` side should keep the trigger installed but
disabled by default through `icedata_label.enable_collection_state_sync`, then
enable it only after the schema, function, grants, and smoke checks above pass.
