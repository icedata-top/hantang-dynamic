# Dynamic Minute Implementation Plan

## 1. 范围

本文是 `hantang-dynamic` 建立统一采集 state、接手 minute 采集、在 V1.5 改造 daily 程序，并在 V1.6 从 `processed_videos` 回填 state 的实施计划。大盘指数、Java 后端、React 前端和弱修正已经移出 V1，见 `docs/plans/postgres-market-index-plan.md`。

事实源为正式仓库 `D:\dev\icedata\hantang-dynamic` latest `a03c19b354d7b5b2dbf0055ad3dcd66fb6159906`。

目标：

1. 建立统一采集 state，覆盖 daily 和 minute 两类采集状态。
2. 从现有 `video_daily` 全量导入已有视频。
3. 新视频入库时，只有规则结果通过才 upsert state，并进入 bootstrap minute 追踪。
4. `hantang-dynamic` 接手 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 观察池中 `priority > 0` 视频的 minute 采集。
5. V1 跑通后，手动关闭 SaaS 对该观察池的 minute 处理。
6. minute 采样追加写入现有 PostgreSQL `video_minute`。
7. 少量重复样本可接受，读取侧和指数侧按 `(aid, time)` 处理。
8. V1 先完成 fixed priority minute 采集闭环。
9. V1.5 改造 daily 程序，让 daily 也读取统一 state。
10. V1.6 从 `processed_videos` 回填 state，作为 V2 指数前置数据准备的一部分。
11. 复用现有 `RateLimiter` 和同一套 worker 调度骨架。

## 2. 正式仓库现状

已有代码事实：

1. `src/database/index.ts` 已提供 `Database` 单例，内部使用 `pg.Pool`。
2. `Database.init()` 使用 `config.database.url` 建立连接池，并用 `config.database.schema` 设置 `search_path`。
3. `Database.init()` 会调用 `initializeSchema()`。
4. `src/config/schemas/database.ts` 已定义 `database.url` 和 `database.schema`。
5. `config.toml.example` 已包含 `[database] url` 和 `schema` 示例。
6. `src/database/schema/video_daily.ts` 已定义 `video_daily`。
7. `src/database/schema/video_minute.ts` 已定义 `video_minute`。
8. `src/database/schema/video_daily_latest.ts` 已定义 `video_daily_latest`。
9. `src/database/schema/index.ts` 已注册 `video_daily`、`video_minute`、`video_daily_latest`。
10. `src/services/tracker.ts`、`src/services/dynamics.service.ts`、`src/services/details.service.ts` 已存在。
11. `src/api/video.ts` 已有 `fetchVideoFullDetail({ aid, bvid })`，endpoint 为 `/view/detail`。
12. `src/utils/rateLimiter.ts` 的 `RateLimiter` 是并发槽位限制器。

V1 缺口：

1. `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 候选 helper。
2. `video_minute` 批量写入 helper。
3. 统一采集 state 和 due queue。
4. stats-only minute handler。
5. 日志脱敏检查。

V1 不新增：

1. `collection_task_attempt` 表。
2. 独立 minute worker 进程。
3. 独立 minute rate limit 系统。
4. 独立 lease reaper 服务。
5. `market_*` 指数表。

## 3. 核心行为

### 3.1 观察池

初始 state 来源为现有 `video_daily` 全量 distinct `aid`。priority 规则：

```sql
daily_delta > 100 or weekly_avg_daily_delta >= 100 => priority > 0
current_view = view_7_days_ago => priority = -2
daily_delta < 100 and weekly_avg_daily_delta < 100 and weekly_view_delta > 0 => priority = 0
manual disabled or retired => priority = -1
```

计算方式：

1. 使用最新两个完整相邻自然日的播放量差值。
2. `video_daily_latest` 只作为池规模和最新播放量快照校验。
3. 计算最近 7 天日均播放量 `weekly_avg_daily_delta`，并用当前端点和 7 天前端点计算 `weekly_view_delta`。`weekly_view_delta = 0` 只要求两端播放量一致；中间缺日不阻止降为 `-2`。缺少任一端点时不做零增长判断。
4. 当前自然日未完成时，不用当天局部数据入池。

新视频 bootstrap：

1. 新 AID 首次进入 `processed_videos` 的正式视频行时，只有规则结果通过才 upsert `video_collection_state`。
2. `D:\dev\icedata\icedata_label` 正式完成前，规则结果通过的临时口径为 `tid_v2 in (2022, 2061)`，对应配置 `bootstrap_tid_v2_allowlist = [2022, 2061]`。
3. 没有 daily delta 的新视频设置 `daily_delta_source = 'bootstrap'`。
4. 初始 `priority` 使用 `bootstrap_priority`，例如 `10`。
5. 立即计算 `next_minute_due_at`，不等第二天 daily 完成。
6. 拥有完整 daily delta 后，按正式规则重算 `priority`。
7. 达到 `bootstrap_ttl_hours` 仍没有完整 daily baseline 时，降级为 `priority = 0`。

### 3.2 priority 策略

参数：

```text
target_delta_per_sample = 100
target_delta_lower = 50
target_delta_upper = 200
min_positive_priority = 1
max_positive_priority = 720
bootstrap_priority = 10
bootstrap_ttl_hours = 24
bootstrap_tid_v2_allowlist = [2022, 2061]
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

`target_delta_lower` 和 `target_delta_upper` 接入运行逻辑。执行时先计算 `effective_target_delta_per_sample = clamp(target_delta_per_sample, target_delta_lower, target_delta_upper)`，再用有效 target 计算 `priority`；它们不是入池阈值。

`bootstrap_tid_v2_allowlist = [2022, 2061]` 是 `D:\dev\icedata\icedata_label` 正式完成前的临时规则通过口径。后续 `icedata_label` 提供正式规则结果后，以规则结果通过为准；在此之前，不处理未命中 allowlist 的新 AID。

`daily_delta_source` 固定使用 `daily_delta`、`weekly_avg`、`bootstrap`、`processed_backfill`。缺少数据不是独立来源；缺少最新相邻日增且无法计算 weekly avg 时，不改写现有 source，新行按视频年龄走 bootstrap 或 processed backfill。

公式：

```text
effective_target_delta_per_sample = clamp(
  target_delta_per_sample,
  target_delta_lower,
  target_delta_upper
)

priority = clamp(
  round(effective_target_delta_per_sample * 1440 / daily_delta_per_day),
  min_positive_priority,
  max_positive_priority
)
```

`priority` 字段名保持不变，但含义不是排序优先级：

1. `priority > 0` 表示每隔多少分钟跑一次 minute，并每日参与 daily。
2. `priority = 0` 表示每日参与 daily，不跑 minute。
3. `priority = -2` 表示只在按 `collection_business_timezone` 判断的每周日进入 daily 候选，不跑 minute。
4. `priority = -1` 表示 daily 也不跑。

实现 `priority = -2` 时，state 表 check constraint 需要使用 `priority in (-2, -1, 0) or priority between 1 and max_positive_priority` 这类枚举加正数区间的约束，daily 候选 SQL 需要显式识别 `-2`。`-2` 不是停采。

`priority = -2` 和 `priority = 0` 需要双向调整：`0` 在当前端点和 7 天前端点播放量一致后降为 `-2`；`-2` 只要周日 daily 发现最近窗口新增播放量大于 0，就升回 `0`，后续再按 daily delta 规则决定是否升为正数 minute 周期。

### 3.3 初始 `next_due_at`

```text
offset_minutes = aid % priority
boundary_start = floor(now to priority-minute boundary)
candidate_due_at = boundary_start + offset_minutes minutes

if candidate_due_at < now:
  next_due_at = candidate_due_at + priority minutes
else:
  next_due_at = candidate_due_at
```

该规则只适用于 `priority > 0` 的视频。不得使用固定 5 分钟槽，也不得使用 `aid % 5`。

### 3.4 调度和限流

V1 使用同一套 worker 调度骨架和同一个 `RateLimiter`。minute 是 stats-only handler，不是独立 worker。

默认参数：

```text
consumer_tick = 1min
claim_batch_size = 50
batch_size = 50
lock_duration = 30s
max_attempts = 5
```

`consumer_tick = 1min` 表示每分钟跑一轮调度检查和任务派发，不表示每分钟只能执行一批 HTTP 请求。每轮 claim 到的任务可以继续按 `batch_size` 拆批，实际 HTTP 并发由现有 worker 和 `RateLimiter` 收敛；调度层可以不显式读取 limiter 状态，因为请求进入 API 路径后仍会被同一个 limiter 限住。不要新增 `batch_concurrency`、`max_http_requests_per_tick` 或 minute 专用并发配置。需要调整吞吐时，先改现有 `RateLimiter` 并发和 `claim_batch_size`。

### 3.5 关口任务

关口任务保留语义差异，但不新建独立执行系统。

```text
task_type = gate
dedupe_key = gate:{aid}:{gate_value}
```

关口任务和普通任务共享同一队列表、同一 worker 调度骨架和同一个 `RateLimiter`。

关口任务管理：

1. `gate` 任务写入 queue 表，`dedupe_key = gate:{aid}:{gate_value}`。
2. `gate_value` 记录目标关口值。
3. `gate_reason` 记录触发原因，例如 `view_threshold` 或 `manual_gate`。
4. claim 时 `gate` 任务排在普通任务前面，排序由 SQL 的 `task_type` 规则完成，不改变 state 表 `priority` 的周期语义。
5. 关口任务成功后写入 `video_minute`，记录对应 gate 的跨过前后样本，再调用 `ack_video_collection_tasks(task_ids)` 完成当前 gate task。
6. 关口任务失败时只写日志，按 queue 重试策略处理。

关口值规则：

1. 当前播放量小于 `10000` 时，目标关口为下一个整千播放量。
2. 当前播放量大于等于 `10000` 时，目标关口为下一个整万播放量。
3. `gate_value` 记录具体目标值，`dedupe_key = gate:{aid}:{gate_value}`。

自动筛选：

1. PostgreSQL 使用最新 daily/latest/minute 样本取当前 `view`。
2. 计算下一个关口和 `distance_to_gate`。
3. 先检查 `current_view` 是否正好命中未完成关口。命中时立即插入到期 `gate` 任务。
4. 如果有上一条样本，先用 `[previous_view, current_view]` 区间查找未完成关口。V1 每次评估最多插入一个自动 gate；若区间内存在多个未完成关口，选择距离实际跨越点最近的 gate。
5. 自动插入前必须排除轻量 crossing history 中已记录的同一 `(aid, gate_value)`，也要排除 active queue 中已有的同一 dedupe key。
6. 已经跨过关口时立即插入到期 `gate` 任务。
7. 尚未跨过时，用最近 minute 增速或 daily delta 估算。`priority > 0` 时判断是否会在 `next_minute_due_at + gate_lead_time` 之前跨过；`priority = 0/-2` 且没有 `next_minute_due_at` 时，只走正好命中、已跨区间和近关口兜底。
8. 最近增速为正，且距离关口小于 `least(gate_value * gate_min_lead_ratio, gate_max_lead_views)` 时，也可以提前插入 `gate` 任务。
9. gate 筛选不改变普通任务 `priority`。

## 4. 数据库扩展

V1 的数据库工作是在现有 PostgreSQL 层上扩展，不新增第二套数据库基础层。

需要新增或扩展：

1. `src/database/videoDaily.ts` 或等价 helper，提供 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 候选查询。
2. `src/database/videoMinute.ts` 或等价 helper，提供 minute 批量写入。
3. `src/database/collectionState.ts` 或等价 helper，管理 daily/minute 统一 state。
4. `src/database/taskQueue.ts` 或等价 helper，管理 queue。
5. `src/database/schema/collection_state.ts` 或迁移 SQL。
6. `src/database/schema/collection_queue.ts` 或迁移 SQL。

建议 state 表：

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
  constraint chk_video_collection_priority_valid
    check (priority in (-2, -1, 0) or priority between 1 and 720),
  constraint chk_video_collection_daily_delta_source
    check (daily_delta_source in ('daily_delta', 'weekly_avg', 'bootstrap', 'processed_backfill'))
);
```

建议 queue 表：

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
```

要求：

1. 复用 `Database.getInstance().getPool()` 或现有 `Database` 方法模式。
2. 不新增第二套 PostgreSQL client。
3. claim 使用事务和 `FOR UPDATE SKIP LOCKED`。
4. `video_minute` 写入采用追加写。
5. V1 不写 `bvid`。
6. 错误详情只写日志，不写 state 或 queue 表。
7. `priority > 0` 才生成普通 minute 任务，`priority = 0` 每日 daily，`priority = -2` 周日 daily，`priority = -1` 停 daily。
8. V1 初始导入从现有 `video_daily` 全量补齐 state。
9. 新视频入库时只为规则结果通过的 AID 补齐 state，bootstrap 期也生成普通 minute 任务。`icedata_label` 正式完成前，规则通过临时等同于 `tid_v2 in (2022, 2061)`。

## 5. Minute Handler

建议模块：

1. `src/services/minute/poolBuilder.ts`
2. `src/services/minute/priorityPolicy.ts`
3. `src/services/minute/initialDueTime.ts`
4. `src/services/minute/batchSampleVideoStats.ts`
5. `src/services/minute/minuteHandler.ts`

流程：

0. 参考 ../hantang-saas 的 `batchGetVideoInfo(aidList)` 模式，设计适合 minute 批量调用的 stats wrapper，支持批量获取播放、弹幕、评论、收藏、投币、分享、点赞等核心 stats。
1. 每分钟跑一轮 tick，claim 到期任务并派发 batch。tick 是调度轮次，不限制本分钟只能打一批 HTTP 请求。
2. claim 最多 50 条 due task。
3. 将 task 合并为 AID batch。
4. 参考 `hantang-saas` 的 `batchGetVideoInfo(aidList)` 模式批量获取 stats。
5. 第一版主路径不按单个 aid 循环调用详情接口。
6. `fetchVideoFullDetail` 和 `/view/detail` 只作为现有详情能力或小批量 fallback。
7. 从批量响应中提取播放、弹幕、评论、收藏、投币、分享、点赞。
8. 批量写入 `video_minute`。
9. 成功 aid 的 state 更新和对应 queue 行完成由 PostgreSQL 函数或 `video_minute` 写入 trigger 处理，TS 不逐行维护这些字段。
10. 失败 aid 只写日志，queue 行按重试策略回到 pending 或标记放弃。
11. 默认采用proxy。失败多次后fallback到直接请求。

不得复用 `DetailsService.processVideoById()` 作为 minute handler。它会写 `processed_videos`、推荐关系和用户存储，不适合 minute stats 采样。

## 6. 日志脱敏

minute 高频前必须完成：

1. config debug 输出不泄露 Cookie、数据库 URL、password。
2. API error `response.config` 不泄露 Cookie header。
3. 通知和日志不包含完整数据库连接串。
4. Bilibili Cookie、SESSDATA、CSRF、数据库密码会被 redaction。

## 7. PostgreSQL 自动化边界

适合交给 PostgreSQL 自动化的操作：

1. 计算最新完整日的 `daily_delta` 和近 7 天均值。
2. 根据 `daily_delta` 和 7 天新增播放量计算 `priority`，其中正数表示 minute 周期，`0` 表示每日 daily，`-2` 表示周日 daily，`-1` 表示停 daily。
3. 从现有 `video_daily` 全量导入或补齐 state。
4. 新视频入库时只为规则通过、缺少 daily delta 的新视频 upsert state 并设置 bootstrap `priority`。`icedata_label` 正式完成前，规则通过临时等同于 `tid_v2 in (2022, 2061)`。
5. bootstrap 期结束或获得完整 daily delta 后，按正式规则重算 `priority`。
6. 按 `priority > 0` 和 `next_minute_due_at` 生成普通 queue 任务。
7. 用 active dedupe 避免重复 pending 或 leased 任务。
8. 根据 latest/daily/minute 样本判断是否需要插入 `gate` 任务。
9. `video_minute` 写入成功后，通过 trigger 或显式 SQL 函数推进 state 的 `last_minute_success_at`、`last_view`、`next_minute_due_at`，但不由 trigger 完成 queue。只有最终 `priority > 0` 时才写下一次普通 minute due；否则清空或保持 `next_minute_due_at` 不参与普通 minute 任务。
10. `video_daily` 写入或 daily/latest 刷新完成后，通过 refresh 函数刷新 state 的 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。优先在 pg_cron 同步 SQL 后调用 refresh，并按本次 distinct AID 分批处理。
11. `video_minute` 写入后按相邻样本计算新增播放量，超过 `minute_burst_delta_threshold` 时只调整 `priority` 和下一次 due。`current_priority > 0` 时用 `least`，`0/-2` 可直接提升为 `minute_burst_priority`，`-1` 不自动恢复。
12. 从 `processed_videos` 批量回填符合条件的 AID 到 state，并按视频年龄分流 bootstrap 和 daily-only。
13. `processed_videos` 新增或更新时，通过 trigger upsert state。TS 仍只写 `processed_videos`，不逐行补 state。
14. queue 领取、租约过期、active dedupe、成功完成、放弃旧任务都放在 SQL 函数里，TS 只调用 claim 和 ack 接口。
15. 清理已完成或已放弃的旧 queue 行。

推荐下放方式：

1. `video_minute` 使用 `AFTER INSERT` statement-level trigger，借助 transition table 批量处理本次插入的 AID，避免 per-row trigger 逐条更新 state。
2. `video_daily` 使用 `AFTER INSERT` statement-level trigger，或在 pg_cron 同步 SQL 后调用同一个 refresh 函数。现有 `sync_video_daily_from_mysql` 和 `update_video_daily_latest` 已经是数据库内定时路径，适合接上 state 刷新。
3. 普通任务完成只走显式 `ack_video_collection_tasks(task_ids)` 函数。`video_minute` trigger 负责根据事实行推进 state；queue 完成由 ack 函数按 task id 和任务状态收敛，避免误完成同 AID 的非本轮任务。部分成功 batch 只 ack 成功 AID 对应的 task id 子集。
4. daily 不区分 attempt 和 success。`video_daily` 有新事实行即代表该 `record_date` 已成功覆盖。失败率用应用日志或 queue `attempt_count` 汇总，不写入 state。
5. `processed_videos` 使用独立 `AFTER INSERT OR UPDATE` trigger 调用 `fn_upsert_collection_state_from_processed_video()`。该 trigger 只维护调度状态，不搬视频详情字段，并忽略 `NEW.aid < 0` 的 repair 中间态。

建议 SQL 函数或 trigger 名称：

```text
fn_refresh_video_collection_state_from_daily(p_aids bigint[] default null)
fn_upsert_collection_state_from_processed_video()
trg_processed_videos_collection_state
fn_apply_video_minute_collection_update()
trg_video_minute_collection_state
fn_enqueue_video_collection_tasks(p_now timestamptz default now())
fn_ack_video_collection_tasks(p_task_ids bigint[])
```

不适合交给 PostgreSQL 的操作：

1. 调用 Bilibili API。
2. proxy/direct fallback。
3. Cookie、SESSDATA、CSRF 等请求认证。
4. 日志脱敏。
5. worker 并发控制。
6. 业务通知。

## 8. 执行顺序

### Phase 0：只读 preflight

交付物：一份 preflight 记录，列出事实源、表字段、索引和本地配置现状。

1. 确认正式仓库 HEAD 和当前分支。
2. 确认 `video_daily`、`video_minute`、`video_daily_latest` 字段。
3. 确认 `video_minute` 的 `(aid, time)` 普通索引。
4. 确认 V1 不写 `bvid`。
5. 确认 `fetchVideoFullDetail` endpoint 为 `/view/detail`。
6. 确认 `RateLimiter` 为同一并发控制入口。
7. 确认 `processed_videos` 是否已有 `tid_v2`，并确认临时 allowlist 为 `[2022, 2061]`。如果字段名不同，先更新参数命名再实现。

通过条件：不改业务代码即可说明当前事实和计划假设是否一致。

### Phase 1：配置、schema 和 SQL 函数

交付物：最小配置、state 表、queue 表、crossing history、claim/ack 函数和 schema 注册路径。

1. 在 config schema 中加入 minute 配置：`target_delta_per_sample`、`target_delta_lower`、`target_delta_upper`、`bootstrap_priority`、`bootstrap_ttl_hours`、`bootstrap_tid_v2_allowlist`、queue 参数和 gate 参数。
2. 校验 `bootstrap_ttl_hours <= 24`，并校验 `target_delta_lower <= target_delta_per_sample <= target_delta_upper` 的运行有效值。
3. 新增 `video_collection_state`，包含 `daily_delta_source`、`priority`、`bootstrap_until`、`next_minute_due_at`、daily/minute 最近成功状态。
4. 新增 `video_collection_queue`，包含 `task_type`、`dedupe_key`、`status`、`locked_until`、`attempt_count`、`gate_value`、`gate_reason`。
5. 新增轻量 crossing history，至少记录 `aid`、`gate_value`、跨过前样本、跨过后样本、`crossed_at` 和来源 task。
6. 实现 `fn_claim_video_collection_tasks()`、`fn_ack_video_collection_tasks()`、`fn_enqueue_video_collection_tasks()` 和放弃过期任务逻辑。
7. 注册 schema 初始化，保留现有 `database.url`、`database.schema`、`search_path` 和 `initializeSchema()` 路径。

通过条件：schema 可重复初始化，active dedupe 有效，claim 使用 `FOR UPDATE SKIP LOCKED`，ack 只按 task id 完成本轮成功任务。

### Phase 2：DAO 和纯 SQL helper

交付物：daily 候选 helper、minute writer、state helper、queue helper。

1. 增加 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 候选 helper。
2. 增加 `effective_target_delta_per_sample` 和 `priority` 计算 helper。
3. 增加 `video_minute` 批量追加 writer。
4. 增加 state 初始化和刷新 helper。
5. 增加 queue claim、ack、fail 或 lease-expire helper。
6. 增加 gate 计算 helper，覆盖整千、整万、已跨区间和近关口提前插入。

通过条件：helper 层不调用 Bilibili API，不处理通知，不保存完整请求或完整响应。

### Phase 3：V1 fixed priority minute 闭环

交付物：可运行的 fixed priority minute 采集闭环。

1. 从现有 `video_daily` 全量导入 state。
2. 读取最新完整日增和近 7 天日均播放量。
3. 使用 `effective_target_delta_per_sample` 计算 `priority`。
4. 分散初始 `next_minute_due_at`。
5. `processed_videos` 新正式视频行触发 bootstrap upsert state；只有规则结果通过的视频进入 bootstrap minute。`icedata_label` 正式完成前，规则通过临时等同于 `tid_v2 in (2022, 2061)`。
6. bootstrap 到期仍无完整 daily baseline 时降级为 `priority = 0`。
7. 每分钟 tick 一轮，claim due task。
8. 合并 AID batch，调用 batch stats wrapper。
9. 批量写 `video_minute`。
10. 成功 aid 通过 PostgreSQL 函数或 trigger 推进 state，queue 完成只由 worker 调用 `ack_video_collection_tasks(task_ids)`。
11. 失败 aid 只写日志并等待重试。
12. 相邻两次 minute 样本新增播放量超过 `minute_burst_delta_threshold` 时，PostgreSQL 自动调小 `priority` 并重算下一次 due。

通过条件：allowlist smoke、10 到 30 分钟运行检查、24h fixed priority 验收通过。

### Phase 4：V1.5 daily 改造

交付物：daily 程序改为从 `video_collection_state` 读取候选。

1. `priority > 0` 和 `priority = 0` 的视频继续参与每日 daily。
2. `priority = -2` 的视频只在按 `collection_business_timezone` 判断的每周日进入 daily 候选。
3. `priority = -1` 的视频不进入 daily。
4. `priority = 0` 的视频只要当前端点和 7 天前端点播放量一致，PostgreSQL 就只把 `priority` 调整为 `-2`。
5. `priority = -2` 的视频只要周日 daily 发现最近窗口新增播放量大于 0，就把 `priority` 调回 `0`。
6. daily 成功以 `video_daily` 事实行写入为准，PostgreSQL 自动刷新 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。
7. daily 仍写入现有 `video_daily` 和 `video_daily_latest`，不改变事实表语义。

通过条件：`-2` 周日候选、非周日排除、`0` 和 `-2` 双向调整都能用小样本验证。

### Phase 5：V1.6 processed_videos 回填 state

交付物：从 `processed_videos` 补齐 state 的一次性或可重复回填入口。

1. 从 `processed_videos` 扫符合条件的视频。
2. 优先使用 `pubdate` 判断视频年龄，其次使用 `ctime`，不要用本地 `created_at` 判断视频年龄。
3. 已有 daily 历史的 AID 按 daily 规则计算 `priority`。
4. 没有 daily 历史的新视频且规则结果通过时按 bootstrap 规则入 state。`icedata_label` 正式完成前，规则通过临时等同于 `tid_v2 in (2022, 2061)`。
5. 没有 daily 历史的老视频写入 `daily_delta_source = 'processed_backfill'`、`priority = 0`，先等半夜 daily 建立基线，不进入 minute。
6. `is_deleted = true` 或不可用视频写入或保持 `priority = -1`。
7. 不把 `processed_videos` 的详情缓存、过滤结果、推荐关系、`notes` 或 `extras` 迁入 state。

通过条件：回填可重复运行，不覆盖已有 `priority = -1`，不把规则未通过的无 daily 新视频拉进 bootstrap minute。

### Phase 6：最终验收和 V2 交接

1. 小 allowlist smoke。
2. 10 到 30 分钟运行检查。
3. 24h fixed priority 验收。
4. V1.5 daily 小样本验收。
5. V1.6 回填幂等验收。
6. 通过后，指数工作按 `docs/plans/postgres-market-index-plan.md` 继续。

## 9. 24h 验收阈值

| 指标 | 阈值 |
|---|---:|
| 采样成功率 | `>= 95%` |
| 成功采样后的写入成功率 | `>= 99.5%` |
| 放弃任务占比 | `< 0.5%` |
| 到期延迟 p95 | `<= 5min` |
| 到期延迟 p99 | `<= 15min` |
| 重复样本占比 | 记录，不阻断 |
| batch duration p95 | `<= 20s` |
| batch duration p99 | `<= 30s` |
| 批量写入部分失败率 | `< 1%` |

指标口径与 `docs/adaptive-minute-collection-plan.md` 的运行验收一致。验收只要求执行 task 数、成功写入 AID 数、放弃 task 数、到期延迟和 batch 写入结果，不从 state 表推断失败原因。

## 10. 涉及文件

已有文件可能修改：

1. `src/index.ts`
2. `src/api/client.ts`
3. `src/config/index.ts`
4. `src/config/schemas/index.ts`
5. `src/database/index.ts`
6. `src/database/schema/index.ts`
7. `src/utils/logger.ts`
8. `config.toml.example`
9. `package.json`

新增文件候选：

1. `src/config/schemas/minute.ts`
2. `src/database/videoDaily.ts`
3. `src/database/videoMinute.ts`
4. `src/database/collectionState.ts`
5. `src/database/taskQueue.ts`
6. `src/database/schema/collection_state.ts`
7. `src/database/schema/collection_queue.ts`
8. `src/services/minute/poolBuilder.ts`
9. `src/services/minute/priorityPolicy.ts`
10. `src/services/minute/initialDueTime.ts`
11. `src/services/minute/batchSampleVideoStats.ts`
12. `src/services/minute/minuteHandler.ts`
13. `src/types/models/minute.ts`

不得作为 V1 新增项列出：

1. `src/database/taskAttempt.ts`
2. `src/database/schema/collection_task_attempt.ts`
3. `src/services/minute/leaseReaper.ts`
4. 独立 minute worker 进程入口
5. `market_*` 指数表
