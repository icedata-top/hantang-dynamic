# 自适应 Minute 采集设计计划

## 1. 事实基线

本文只覆盖 `hantang-dynamic` 接手 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 观察池的 V1 minute 采集闭环。大盘指数、Java 后端只读 API、React 前端展示和大盘弱修正不属于 V1，统一放在 `docs/plans/postgres-market-index-plan.md`。

事实源为正式仓库 `D:\dev\icedata\hantang-dynamic` 的 HEAD `a03c19b354d7b5b2dbf0055ad3dcd66fb6159906`。

当前已有能力：

1. `src/database/index.ts` 已有 `Database` 单例，内部使用 `pg.Pool`。
2. `Database.init()` 使用 `config.database.url` 建立连接池，并按 `config.database.schema` 设置 `search_path`。
3. `src/database/schema/video_daily.ts`、`video_minute.ts`、`video_daily_latest.ts` 已有对应表结构。
4. `video_daily` 和 `video_daily_latest` 已有 pg_cron 同步或刷新路径。
5. `video_minute` 已存在，当前只有 `(aid, time)` 普通索引，没有唯一约束，没有 `bvid` 字段。
6. 服务层已有 `src/services/tracker.ts`、`src/services/dynamics.service.ts`、`src/services/details.service.ts`。
7. `src/api/video.ts` 已有 `fetchVideoFullDetail({ aid, bvid })`，endpoint 为 `/view/detail`，已有 proxy/direct fallback。
8. `src/utils/rateLimiter.ts` 的 `RateLimiter` 是并发槽位限制器。

V1 缺口：

1. `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 候选查询 helper。
2. `video_minute` 批量追加写入 helper。
3. 统一采集 state 表和 queue 表。
4. minute 采样 handler。
5. 日志脱敏检查。

V1 不新增 `collection_task_attempt` 表，不新增独立 minute worker 进程，不新增独立 rate limit 系统，不把指数或前后端内容塞进采集实现。

## 2. V1 目标

1. 建立统一采集 state，覆盖 daily 和 minute 两类采集状态。
2. 从当前 `video_daily` 全量导入已有视频到 state。
3. 低活跃但最近 7 天仍有新增播放的视频设为 `priority = 0`，保留每日 daily，不跑 minute；最近 7 天零增长的视频设为 `priority = -2`，只跑周日 daily。
4. `hantang-dynamic` 接手 `priority > 0` 视频池的 minute 采集。
5. 采样结果追加写入现有 `video_minute`。
6. 读取和指数计算按 `(aid, time)` 处理少量重复样本。
7. 第一版按 fixed priority 运行，并保留后续调参入口。
8. 复用现有数据库层、现有 API client 能力、现有 `RateLimiter` 和同一套 worker 调度骨架。

## 3. 入池规则

state 初始数据来源为当前 `video_daily` 全量视频。第一版 priority 规则：

```text
daily_delta > 100 or weekly_avg_daily_delta >= 100 => priority > 0
current_view = view_7_days_ago => priority = -2
daily_delta < 100 and weekly_avg_daily_delta < 100 and weekly_view_delta > 0 => priority = 0
manual disabled or retired => priority = -1
```

`daily_delta` 使用最新两个完整自然日的相邻播放量差值。`weekly_avg_daily_delta` 使用最近 7 天日均播放量。`weekly_view_delta` 使用当前端点和 7 天前端点的播放量差值。当前自然日未完成时，不用当天局部数据决定正数 minute 入池。`weekly_view_delta = 0` 只要求存在当前端点和 7 天前端点，且两端播放量一致；中间缺日不阻止降为 `-2`。缺少任一端点时，不做零增长判断，先按 `0` 或已有状态处理。

新视频不等待第二天 daily delta。任何新 AID 首次入库时，必须立即 upsert 到统一 state，并进入 bootstrap minute 追踪。

bootstrap 规则：

1. 新 AID 写入 state 时，如果还没有 daily delta，先设置 `daily_delta_source = 'bootstrap'`。
2. 初始 `priority` 使用保守固定值，例如 `bootstrap_priority = 10`，表示每 10 分钟采一次 minute。
3. 初始 `next_minute_due_at` 立即按 bootstrap priority 分散，不能等第二天 daily 完成。
4. bootstrap 状态最长保留到该视频拥有第一个完整 daily delta 或达到 `bootstrap_ttl_hours`。
5. 一旦有完整 daily delta 或 7 天均值，PostgreSQL 自动化逻辑按正式规则重算 `priority`。
6. 如果 bootstrap 期发现视频很快失效或被人工停采，可以把 `priority` 设为 `-1`。

参数：

```text
target_delta_per_sample = 100
target_delta_lower = 50
target_delta_upper = 200
min_positive_priority = 1
max_positive_priority = 720
bootstrap_priority = 10
bootstrap_ttl_hours = 72
weekly_zero_delta_days = 7
weekly_daily_priority = -2
minute_burst_delta_threshold = 500
minute_burst_priority = 1
processed_backfill_new_video_age_days = 7
gate_lead_time = 30min
gate_min_lead_ratio = 0.10
gate_max_lead_views = 500
collection_business_timezone = Asia/Shanghai
```

`50` 到 `200` 是后续调参范围，不是入池阈值。

`daily_delta_source` 固定为以下枚举：

1. `daily_delta`：使用最新两个完整自然日的相邻日增。
2. `weekly_avg`：缺少最新相邻日增时，临时使用近 7 天平均日增。
3. `bootstrap`：新视频缺少 daily delta，正在 bootstrap minute 追踪。
4. `processed_backfill`：从 `processed_videos` 回填的老视频，尚无 daily 历史，先等待 daily 建立基线。

缺少数据不是独立 source。缺少最新相邻日增且无法计算 weekly avg 时，不改写 `daily_delta_source`，新行按视频年龄走 `bootstrap` 或 `processed_backfill`。

`priority` 是 V1 的核心采集等级字段。字段名保持为 `priority`，但含义不是排序优先级：

1. `priority > 0` 表示每隔多少分钟跑一次 minute 级周期采集，并每日参与 daily。
2. `priority = 0` 表示每日参与 daily，不跑 minute。
3. `priority = -2` 表示只在按 `collection_business_timezone` 判断的每周日进入 daily 候选，不跑 minute。
4. `priority = -1` 表示 daily 也不跑。
5. V1 不再用 `priority` 表达 queue 排序优先级。

`priority = -2` 是 V1.5 为零增长视频保留的 daily 降频值。它仍是 active 状态，不能按停采处理。V1 schema 可以先允许该值，但 V1 fixed priority 闭环不依赖 daily 读取 state。真正让 `-2` 影响 daily 候选的是 V1.5 daily 改造。实现时建议把 state 表 check constraint 写成 `priority in (-2, -1, 0) or priority between 1 and max_positive_priority`。

`priority = -2` 和 `priority = 0` 需要双向调整：`priority = 0` 的视频如果当前端点和 7 天前端点播放量一致，就降为 `-2`；`priority = -2` 的视频只要周日 daily 发现最近窗口出现正增长，就升回 `0`，后续再按 daily delta 规则决定是否升为正数 minute 周期。

## 4. Priority 和初始到期

公式：

```text
priority = clamp(
  round(target_delta_per_sample * 1440 / daily_delta_per_day),
  min_positive_priority,
  max_positive_priority
)
```

初始 `next_due_at` 只对 `priority > 0` 的视频计算，并按各自周期分散：

```text
offset_minutes = aid % priority
base_time = floor(now to priority-minute boundary)
next_due_at = base_time + offset_minutes minutes

if next_due_at < now:
  next_due_at = next_due_at + priority minutes
```

不得使用固定 5 分钟槽，也不得使用 `aid % 5`。`priority = 1` 时，`offset_minutes = 0`。

## 5. 调度设计

V1 使用同一套 worker 调度骨架和同一个 `RateLimiter`。minute 只是一个新的 stats-only handler，不复用 `DetailsService.processVideoById()`，也不新建独立 worker 进程。

原因：

1. `DetailsService.processVideoById()` 会走已处理缓存、过滤、`processed_videos`、推荐关系和用户存储。
2. minute 采集只需要 stats 快照并写入 `video_minute`。
3. 同一套 `RateLimiter` 能统一控制 API 并发，避免 minute 另起一套节流口径。

默认节奏：

```text
consumer_tick = 1min
claim_batch_size = 50
batch_size = 50
lock_duration = 30s
max_attempts = 5
```

这些是调度容量参数。`consumer_tick = 1min` 表示调度器每分钟跑一轮 claim 和派发，不表示每分钟只能发起一批请求，也不表示每个视频每分钟采一次。每轮 claim 到的任务可以按 batch 派发，实际 HTTP 并发由现有 worker 和 `RateLimiter` 收敛；如果调度层不显式参考 `RateLimiter`，请求进入现有 API 路径后仍会被同一个 limiter 限住。需要加大吞吐时，先调整现有 `RateLimiter` 并发和 `claim_batch_size`，不新增 `batch_concurrency`、`max_http_requests_per_tick` 或独立预算池。

## 6. 数据模型

V1 使用两个表：统一 state 表记录每个视频的 daily/minute 采集策略和最近成功状态，queue 表记录当前要执行的普通任务和关口任务。不要新增详细 attempt 表。

### 6.1 state 表

state 表只保存调度需要长期保留的状态。它不只服务 `video_minute`，也作为 V1.5 daily 程序改造后的采集入口。

```sql
create table video_collection_state (
  aid bigint primary key,
  latest_daily_delta bigint,
  weekly_avg_daily_delta numeric,
  daily_delta_source text not null,
  priority int not null default 0,
  bootstrap_until timestamptz,
  next_minute_due_at timestamptz,
  last_minute_success_at timestamptz,
  last_daily_record_date date,
  last_view bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_video_collection_daily_delta_source
    check (daily_delta_source in ('daily_delta', 'weekly_avg', 'bootstrap', 'processed_backfill')),
  constraint chk_video_collection_priority_valid
    check (priority in (-2, -1, 0) or priority between 1 and 720)
);
```

索引：

```sql
create index idx_video_collection_state_minute_due
on video_collection_state(next_minute_due_at, aid)
where priority > 0;
```

state 规则：

1. `priority > 0` 的视频按 `next_minute_due_at` 生成普通 minute 任务，周期为 `priority` 分钟。
2. `priority = 0` 的视频不生成普通 minute 任务，但仍保留 daily 采集。
3. `priority = -1` 的视频不生成普通 minute 任务，也不进入 daily 采集。
4. `priority = -2` 的视频不生成普通 minute 任务，只在按 `collection_business_timezone` 判断的每周日进入 daily 候选。
5. 成功 minute 采样后，由 PostgreSQL 根据新写入的 `video_minute` 事实行更新 `last_minute_success_at`、`last_view` 和下一次 `next_minute_due_at`。queue 完成只通过 `ack_video_collection_tasks(task_ids)` 处理。
6. daily 不区分 attempt 和 success。`video_daily` 有新事实行即代表该 `record_date` 已成功覆盖，由 PostgreSQL 更新 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。
7. 失败原因只写日志，不写 state 表。

初始导入规则：

1. 从现有 `video_daily` 全量提取 distinct `aid`。
2. 对每个 `aid` 计算最新完整相邻日 `daily_delta`。
3. 同时计算最近 7 天日均播放量 `weekly_avg_daily_delta`。
4. 满足 `daily_delta > 100` 或 `weekly_avg_daily_delta >= 100` 的视频计算正数 `priority`。
5. 初始导入时，只要当前端点和 7 天前端点播放量一致，就写入 `priority = -2`；中间缺日不影响该判断，缺少任一端点时不做零增长判断。
6. 日增和周内日均都不到 100 但最近 7 天仍有新增播放的视频写入 `priority = 0`。
7. 人工停采、后续淘汰、删除或不可用的视频写入 `priority = -1`。

新视频入库规则：

1. V1 自动 bootstrap 触发点是 `processed_videos` 的新正式视频行。daily 写入链路通过 daily refresh 维护 state，不作为另一个新视频 bootstrap trigger，避免重复入口。
2. 若该 AID 是新发布视频、缺少 daily delta，且不在 state 中，写入 `daily_delta_source = 'bootstrap'`、`priority = bootstrap_priority`、`bootstrap_until` 和 `next_minute_due_at`。
3. 若该 AID 已在 state 中且 `priority = -1`，不自动恢复采集，除非业务显式解除停采。
4. 若该 AID 已在 state 中且 `priority != -1`，只合并缺失字段，不覆盖已有 daily/minute 状态。
5. bootstrap 期间生成普通 minute queue 任务，和其他 minute 任务共享同一 worker 与 `RateLimiter`。
6. 老视频或已有 daily 历史的视频按 daily/backfill 规则入 state，不走 bootstrap。
7. `processed_videos` trigger 必须按固定顺序处理：`NEW.aid < 0` 直接跳过；`NEW.is_deleted = true` 时把已有 state 改为 `priority = -1` 并清空 `next_minute_due_at`，但不为没有 state 的删除行创建 minute 追踪；再检查 `is_filtered`、daily 历史、发布时间年龄，决定 bootstrap 或 daily-only。
8. `processed_videos` trigger 只读取 `aid`、`pubdate`、`ctime`、`is_deleted`、`is_filtered` 和 daily history，不复制展示、过滤、推荐、错误、用户或分类字段。

processed_videos 回填规则：

1. 该步骤放在 V1.6 或 V2 大盘前置阶段，不塞进 V1 的 fixed priority 闭环。
2. PostgreSQL 从 `processed_videos` 扫符合条件的视频。默认条件为 `is_filtered = true and is_deleted = false`，若需要追踪未通过过滤的视频，必须另列业务白名单。
3. 有 `video_daily` 历史的 AID 按 daily 规则计算 `priority`。
4. 没有 daily 历史且发布时间在 `processed_backfill_new_video_age_days` 内的 AID，按 bootstrap 新视频处理。
5. 没有 daily 历史且已经是老视频的 AID，写入 `daily_delta_source = 'processed_backfill'`、`priority = 0`，先等半夜 daily 建立基线，不进入 minute。
6. 不覆盖已有 `priority = -1`，不把 `processed_videos` 的详情缓存、过滤结果、推荐关系、`notes` 或 `extras` 搬进 state。

### 6.2 queue 表

queue 表只保存待执行任务和短期执行锁。

```sql
create table video_collection_queue (
  id bigserial primary key,
  aid bigint not null,
  task_type text not null,
  dedupe_key text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  locked_until timestamptz,
  attempt_count int not null default 0,
  max_attempts int not null default 5,
  gate_value bigint,
  gate_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_video_collection_queue_task_type
    check (task_type in ('minute', 'gate')),
  constraint chk_video_collection_queue_status
    check (status in ('pending', 'leased', 'completed', 'abandoned'))
);

create unique index uq_video_collection_queue_active_dedupe
on video_collection_queue(dedupe_key)
where status in ('pending', 'leased');

create index idx_video_collection_queue_claim
on video_collection_queue(status, task_type, due_at, locked_until, id);
```

自动 gate 需要保留已完成去重口径，但不要求长期保留完整 completed queue 行。V1 只保留每个跨过 gate 的轻量 crossing history 或等价样本记录，至少包含 `aid`、`gate_value`、跨过前样本、跨过后样本、`crossed_at` 和来源 task。completed queue 行可以按普通 TTL 清理。

claim SQL 负责判断 `locked_until is null or locked_until <= now()`，不要把 `now()` 放进 partial index predicate。

claim 语义：

1. 使用事务和 `FOR UPDATE SKIP LOCKED`。
2. 到期且未锁定或锁过期的行可以被领取。
3. 领取时设置 `locked_until = now() + 30 seconds`，并增加 `attempt_count`。
4. 不生成也不保存 worker 身份 token。
5. 成功后通过 `ack_video_collection_tasks(task_ids)` 按 task id 和 `status = 'leased'` 校验完成 queue 行。必要时可以同时要求 `locked_until` 未过期。
6. 合并 AID batch 后，worker 必须保留 `aid -> task_id` 映射。部分成功时，只把成功 AID 对应的 task id 子集传给 `ack_video_collection_tasks`。
7. 失败后只写日志。任务可以等 `locked_until` 过期后重新被 claim；若实现显式 fail 函数，则只允许把 `leased` 行改回 `pending` 并清空 `locked_until`。
8. 迟到 worker 的重复写入风险由 `video_minute` 事实追加、读取侧重复样本处理、`completed`/`abandoned` 终态防重复完成来收敛。
9. `attempt_count >= max_attempts` 后标记为 `abandoned`，不再进入 claim。

不记录逐项请求正文、完整响应、完整错误对象、代理细节或 per-aid 详细审计。出错时依赖日志排查，表内只保留任务状态和计数。

## 7. 关口任务

关口任务是 queue 表中的 `gate` 任务，不通过 `priority` 表达排序。

```text
task_type = gate
dedupe_key = gate:{aid}:{gate_value}
```

关口任务来源：

1. PostgreSQL 根据最新 daily/latest 或 minute 样本判断视频接近或跨过配置的播放量关口，插入 `gate` 任务。
2. 其他业务模块可以显式插入 `gate` 任务，但必须使用同一张 queue 表和同一个 dedupe 规则。
3. 普通周期采样不会覆盖已有 `gate` 任务。

关口值规则：

1. 当前播放量小于 `10000` 时，目标关口为下一个整千播放量，例如 `1000`、`2000`、`9000`、`10000`。
2. 当前播放量大于等于 `10000` 时，目标关口为下一个整万播放量，例如 `20000`、`30000`、`100000`。
3. V1 每次自动评估最多插入一个关口任务。若采样区间跨过多个未完成关口，选择最接近实际跨越点的 gate。
4. `gate_value` 记录具体目标值，`dedupe_key = gate:{aid}:{gate_value}`。

自动筛选规则：

1. PostgreSQL 从 `video_daily_latest`、最新 `video_daily` 或最新 `video_minute` 取当前 `view`。
2. 先检查 `current_view` 是否正好命中未完成关口。命中时立即插入到期 `gate` 任务。
3. 计算 `next_gate_value`。若不存在下一个目标值，不插入 gate。
4. 计算 `distance_to_gate = next_gate_value - current_view`。
5. 如果有上一条样本，先用 `[previous_view, current_view]` 区间查找未完成关口。V1 每次评估最多插入一个自动 gate；若区间内存在多个未完成关口，选择距离实际跨越点最近的 gate。
6. 自动插入前必须排除轻量 crossing history 中已记录的同一 `(aid, gate_value)`，也要排除 active queue 中已有的同一 dedupe key。
7. 若 `distance_to_gate <= 0`，说明当前样本已经跨过下一个未完成关口，立即插入到期 `gate` 任务，用于补采关口附近样本。
8. 若 `distance_to_gate > 0`，用最近两次 minute 样本或 daily delta 估算播放增速。`priority > 0` 时预测窗口使用 `next_minute_due_at + gate_lead_time`；`priority = 0/-2` 且没有 `next_minute_due_at` 时，只走正好命中、已跨区间和近关口兜底，不做普通 minute due 预测。
9. 如果预计会在预测窗口内跨过关口，插入 `gate` 任务。
10. 如果最近增速为正，且 `distance_to_gate <= least(gate_value * gate_min_lead_ratio, gate_max_lead_views)`，即使增速估算不足，也可以提前插入 `gate` 任务，避免关口附近采样过晚。
11. 预测窗口和提前量只服务是否提前插入 `gate`，不改变普通任务 `priority`。
12. 低增速且距离关口较远的视频不插入 `gate`，等待普通采样或 daily 刷新再次判断。

关口任务管理规则：

1. `gate_value` 记录目标关口值。
2. `gate_reason` 记录短原因，例如 `view_threshold` 或 `manual_gate`。
3. claim 时 `gate` 任务排在普通任务前面，排序由 SQL 的 `task_type` 规则完成，不改变 state 表里的 `priority` 语义。
4. 关口任务仍使用同一 worker 调度骨架和同一个 `RateLimiter`。
5. 关口任务成功后同样写入 `video_minute`，记录对应 gate 的跨过前后样本，再调用 `ack_video_collection_tasks(task_ids)` 完成当前 gate task。
6. 关口任务失败时只写日志，按 queue 重试策略处理。

claim 排序建议：

```sql
order by
  case when task_type = 'gate' then 0 else 1 end,
  due_at asc,
  id asc
```

## 8. PostgreSQL 自动化边界

适合交给 PostgreSQL 自动化的操作：

1. 计算最新完整日的 `daily_delta` 和近 7 天均值。
2. 根据 `daily_delta` 和 7 天新增播放量计算 `priority`，需要 minute 的视频设为正数分钟间隔，只跑 daily 的视频设为 `0`，只在周日跑 daily 的视频设为 `-2`，停采视频设为 `-1`。
3. 从现有 `video_daily` 全量导入或补齐 state。
4. 新视频入库时 upsert state，并为缺少 daily delta 的新视频设置 bootstrap `priority`。
5. bootstrap 期结束或获得完整 daily delta 后，按正式规则重算 `priority`。
6. 按 `priority > 0` 和 `next_minute_due_at` 生成普通 minute queue 任务。
7. 用 active dedupe 避免重复 pending 或 leased 任务。
8. 根据 latest/daily/minute 样本判断是否需要插入 `gate` 任务。
9. `video_minute` 写入成功后，通过 trigger 或显式 SQL 函数推进 state 的 `last_minute_success_at`、`last_view`、`next_minute_due_at`，但不由 trigger 完成 queue。只有最终 `priority > 0` 时才写下一次普通 minute due；否则清空或保持 `next_minute_due_at` 不参与普通 minute 任务。
10. `video_daily` 写入或 daily/latest 刷新完成后，通过 refresh 函数刷新 state 的 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。优先在 pg_cron 同步 SQL 后调用 refresh，并按本次 distinct AID 分批处理，不做全表刷新。该 refresh 负责 `priority = 0` 连续零增长降到 `-2`，以及 `priority = -2` 出现增长后回到 `0`。
11. `video_minute` 写入后按同一 AID 的相邻样本计算 `view_delta`。若 `view_delta >= minute_burst_delta_threshold`，`current_priority > 0` 时用 `least(current_priority, minute_burst_priority)`，`priority = 0` 或 `priority = -2` 时可直接提升为 `minute_burst_priority`；`priority = -1` 不自动恢复。
12. 从 `processed_videos` 批量回填符合条件的 AID 到 state，并按视频年龄分流 bootstrap 和 daily-only。
13. `processed_videos` 新增或更新时，通过 trigger upsert state。TS 仍只写 `processed_videos`，不逐行补 state。
14. queue 领取、租约过期、active dedupe、成功完成、放弃旧任务都放在 SQL 函数里，TS 只调用 claim 和 ack 接口。
15. 清理已完成或已放弃的旧 queue 行。

推荐下放方式：

1. `video_minute` 使用 `AFTER INSERT` statement-level trigger，借助 transition table 批量处理本次插入的 AID，避免 per-row trigger 逐条更新 state。
2. `video_daily` 使用 `AFTER INSERT` statement-level trigger，或在 pg_cron 同步 SQL 后调用同一个 refresh 函数。现有 `sync_video_daily_from_mysql` 和 `update_video_daily_latest` 已经是数据库内定时路径，适合接上 state 刷新。
3. 普通任务完成不要求 TS 显式逐行更新 state。TS 插入 `video_minute` 后调用 `ack_video_collection_tasks(task_ids)`。queue 完成只走该函数，并按 task id 和任务状态校验，避免只按 AID 误完成非本轮任务。
4. daily 的 attempt 不进入 state。若将来确实需要观测失败率，使用应用日志或 queue 的 `attempt_count` 汇总，不新增长期 attempt 明细。
5. `processed_videos` 使用独立 `AFTER INSERT OR UPDATE` trigger 调用 `fn_upsert_collection_state_from_processed_video()`。该 trigger 只维护调度状态，不搬视频详情字段。

不适合交给 PostgreSQL 的操作：

1. 调用 Bilibili API。
2. proxy/direct fallback。
3. Cookie、SESSDATA、CSRF 等请求认证。
4. 日志脱敏。
5. worker 并发控制。
6. 业务通知。

## 9. Minute Stats Handler

推荐路径：

1. 每分钟跑一轮 tick，领取 due 任务并派发 batch。tick 是调度轮次，不限制本分钟只能打一批 HTTP 请求。
2. 将任务合并为 AID batch。
3. 参考 `hantang-saas` 的批量 stats 获取方式实现 `batchSampleVideoStats(aids)`。
4. 主路径不按单个 aid 循环调用 `/view/detail`。
5. `fetchVideoFullDetail` 只作为现有详情能力或小批量 fallback。
6. 批量响应按 aid 显式匹配，提取播放、弹幕、评论、收藏、投币、分享、点赞。
7. 批量追加写入 `video_minute`。
8. 成功 aid 的 state 推进由 PostgreSQL 函数或 `video_minute` 写入 trigger 完成，计算口径为 `next_minute_due_at = last_minute_success_at + priority minutes`。queue 完成只由 worker 调用 `ack_video_collection_tasks(task_ids)`。
9. 如果相邻两次 minute 样本的新增播放量超过 `minute_burst_delta_threshold`，PostgreSQL 自动把 `priority` 调小到更高频率，并重算下一次 due。
10. 失败 aid 只写日志并等待重试，禁止把整批统一覆盖为成功或失败。

## 10. 日志脱敏

minute 高频启用前必须确认：

1. config debug 输出不泄露 Cookie、数据库 URL、password。
2. API error `response.config` 不泄露 Cookie header。
3. 通知和日志不包含完整数据库连接串。
4. Bilibili Cookie、SESSDATA、CSRF、数据库密码会被 redaction。

## 11. V1 不做

1. 不新增 `collection_task_attempt` 表。
2. 不保存请求和响应明细。
3. 不新增独立 minute worker 进程。
4. 不新增独立 rate limit 系统。
5. 不新增 `market_*` 表。
6. 不做指数 shadow。
7. 不做 Java 后端 API。
8. 不做 React 前端展示。
9. 不做大盘热度弱修正。
10. 不改变 `video_minute` 唯一约束、压缩策略和历史数据。
11. 不在 state 或 queue 表保存 `last_http_status`、`last_error_code`、`last_error_message`。

指数、后端、前端和弱修正的后续计划见 `docs/plans/postgres-market-index-plan.md`。

## 12. V1.5：daily 程序改造

V1.5 在 V1 state 和 queue 稳定后执行，目标是把 daily 的采集入口也迁到统一 state。

范围：

1. daily 程序从 `video_collection_state` 读取候选。
2. `priority > 0` 和 `priority = 0` 的视频继续参与每日 daily。
3. `priority = -2` 的视频只在按 `collection_business_timezone` 判断的每周日进入 daily 候选。
4. `priority = -1` 的视频不进入 daily。
5. `priority = 0` 的视频只要当前端点和 7 天前端点播放量一致，PostgreSQL 就只把 `priority` 调整为 `-2`，不新增 cadence 字段。
6. `priority = -2` 的视频只要周日 daily 发现最近窗口新增播放量大于 0，就把 `priority` 调回 `0`；后续再按 daily delta 规则决定是否升为正数 minute 周期。
7. daily 成功以 `video_daily` 事实行写入为准。PostgreSQL 自动刷新 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。
8. daily 仍写入现有 `video_daily` 和 `video_daily_latest`，不改变事实表语义。

V1.5 不做：

1. 不改变 `video_daily` 的历史数据。
2. 不把 daily 失败详情写入 state 表。
3. 不让 daily 程序直接调用 minute handler。
4. 不引入独立 rate limit。

## 13. 验收

文档和实现前检查：

1. 确认 `video_daily`、`video_minute`、`video_daily_latest` 字段。
2. 确认 `video_minute` 的 `(aid, time)` 普通索引。
3. 确认 V1 不写 `bvid`。
4. 确认 `RateLimiter` 为并发槽，并作为 minute 采样的同一并发控制入口。
5. 确认无 `collection_task_attempt`、独立 minute worker、独立 minute rate limit 设计。
6. 确认 state 和 queue 分表。
7. 确认 `priority > 0` 表示 minute 采样间隔分钟数并每日参与 daily，`priority = 0` 表示每日 daily，`priority = -2` 表示周日 daily，`priority = -1` 表示 daily 也不跑。
8. 确认错误详情只写日志，不写 state 或 queue 表。
9. 确认 state 初始数据从现有 `video_daily` 全量导入。
10. 确认 V1.5 daily 程序改造范围已经单独列出。
11. 确认新视频入库会立即 upsert state 并进入 bootstrap minute 追踪。
12. 确认 `priority = -2` 只表示周日 daily，不表示停采。
13. 确认 burst 提频只调整 `priority` 和下一次 due，不新增 attempt 或策略明细表。
14. 确认 `processed_videos` 回填 state 是 V1.6 或 V2 前置，不进入 V1 fixed priority 闭环。

运行验收：

| 指标 | 阈值 |
|---|---:|
| 采样成功率 | `>= 95%` |
| 成功采样后的写入成功率 | `>= 99.5%` |
| 放弃任务占比 | `< 0.5%` |
| 到期延迟 p95 | `<= 5min` |
| 到期延迟 p99 | `<= 15min` |
| 重复样本占比 | 记录，不阻断 |
| batch duration p95 | `<= 20s` |
| 批量写入部分失败率 | `< 1%` |

指标口径：

1. 采样成功率 = 成功写入 `video_minute` 的 task 数 / 本窗口内进入执行态的 task 数。
2. 成功采样后的写入成功率 = 成功完成数据库写入的 AID 数 / HTTP 响应中成功返回 stats 的 AID 数。
3. 放弃任务占比 = 新增 `abandoned` task 数 / 本窗口内进入执行态的 task 数。
4. 到期延迟 = 实际领取时间 - `due_at`，只统计普通 `minute` 和 `gate` 到期任务。
5. 重复样本占比只记录趋势，不阻断 V1.5。
6. batch duration = 从领取 batch 到写入完成并 ack 的耗时。
7. 批量写入部分失败率 = batch 写入中出现部分 AID 失败的 batch 数 / 总写入 batch 数。
