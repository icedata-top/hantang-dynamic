# icedata_label Collection State Contract

This is the handoff point for adaptive minute V1. `hantang-dynamic` now owns the
collection state tables and exposes the SQL function that a future
`icedata_label` trigger should call after rule labels are written.

## Provided Function

`fn_upsert_collection_state_from_processed_video(...)` is created during
`hantang-dynamic` schema initialization.

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
3. When rule label output passes, call the function with the formal label fields.
4. When a prior positive row is demoted to a non-positive label or no longer has
   `label_origin = 'rule'` and `labeled_by in ('classification_apply',
   'classification_trigger')`, call the function so existing state is disabled.
5. Do not use `classification_crawler_handoff_events` as the formal integration
   contract.
6. Calls with partial formal label fields are treated as label-not-ready and do
   not disable state. Demotion calls must include all three formal label fields.

Formal positive label predicate:

```sql
is_deleted = false
and label_origin = 'rule'
and labeled_by in ('classification_apply', 'classification_trigger')
and label_content_type in ('vocaloid', 'maybe_vocaloid')
```

Temporary fallback before formal label fields are available:

```sql
tid_v2 in (2022, 2061)
```

## Current Boundary

The `hantang-dynamic` side is ready for the trigger integration contract. The
next required code change is in `D:\dev\icedata\icedata_label`, where the rule
label trigger must call this function on insert, update, deletion, and demotion.
