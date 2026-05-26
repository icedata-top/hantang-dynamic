# PostgreSQL 大盘指数、后端与前端计划

## 1. 范围

本文是 V2 以后专门文档。它承接 V1 minute 采集结果，覆盖 PostgreSQL 大盘指数、Java 后端只读 API、React 前端展示和大盘弱修正。

本文不要求 V1 创建 `market_*` 表、物化视图、后端接口或前端页面。

V1 minute 采集闭环不在本文实现，见：

1. `docs/adaptive-minute-collection-plan.md`
2. `docs/plans/dynamic-minute-implementation-plan.md`
3. `docs/plans/adaptive-minute-rollout-plan.md`

V1 边界必须保持简单：

1. V1 复用同一套 worker 调度骨架。
2. V1 复用同一个 `RateLimiter`。
3. V1 不新增 `collection_task_attempt` 表。
4. V1 不新增独立 minute worker。
5. V1 不新增独立 minute rate limit。
6. V1 的错误细节进入应用日志，不把 `last_http_status`、`last_error_code`、`last_error_message` 作为必要状态字段。
7. V1 的统一采集 state 覆盖 daily 和 minute。
8. V1 的采集频率字段保持为 `priority`：正数表示 minute 周期分钟数，`0` 表示每日 daily，`-2` 表示周日 daily，`-1` 表示 daily 也不跑。
9. V1.5 负责把 daily 程序迁到统一 state。
10. V1 新视频入库会立即 upsert state 并进入 bootstrap minute 追踪。

进入本文范围的前置条件：

1. `hantang-dynamic` 已能采集 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 观察池。
2. V1 已有统一 state 表和 queue 表，能够表达候选视频、daily 状态、minute 下一次到期时间、锁定状态和采样间隔。
3. `video_minute` 已有连续追加样本。
4. V1 已从现有 `video_daily` 全量导入 state。
5. V1 已支持新视频 bootstrap minute 追踪。
6. V1.5 daily 程序已经改为读取统一 state。
7. V1.5 已支持零增长视频 `priority = -2` 周日 daily 和 minute burst 提频。
8. V1.6 或 V2 前置阶段已把符合条件的 `processed_videos` 回填到 `video_collection_state`。
9. V1 24h fixed priority 验收通过。
10. 重复样本读取口径已确认。

## 2. V2 到 V5 路线

### V2：PostgreSQL 大盘指数

目标：

1. 基于 `video_minute`、`video_daily` 和 `video_daily_latest` 计算“已观测视频池播放速率指数”。
2. 维护 `event_time_index` 和 `available_time_index` 两套口径。
3. 从 30m 起步 bucket 生成指数点、K 线和 MA。
4. 建立日、周、月增量摘要，用于解释观察池变化和后续调参。
5. 把高成本窗口计算放在 PostgreSQL 定时刷新路径中，不放在 API 请求路径。

边界：

1. 不驱动 minute worker。
2. 不改写采集状态。
3. 不影响普通任务真实 `next_due_at`。
4. 不影响关口任务。
5. 不在 API 请求路径现算大窗口。
6. 不要求 V1 同步创建任何 `market_*` 表。

### V3：Java 后端只读 API

目标：

1. `hantang-web-backend` 增加只读 API。
2. 后端只读取预计算表或物化视图。
3. API 输出指数、K 线、MA、质量字段和 debug 信息。
4. API 明确区分 event time 与 available time 口径。

边界：

1. Java 后端不写 `hantang-dynamic` 的采集状态。
2. Java 后端不触发指数重算。
3. Java 后端不直接驱动 minute 采集。
4. Java 后端不承担 V1 队列管理。

### V4：React 前端展示

目标：

1. `icedata-web-react` 展示观察池指数、趋势、质量字段和调度 factor。
2. 页面文案明确该指标只代表已观测视频池。
3. 页面只读展示，不提供采集控制入口。
4. 页面可以显示 V5 shadow 结果，但不发起写回。

边界：

1. 前端不写队列状态。
2. 前端不触发指数重算。
3. 前端不提供修改关口任务、指数参数或采集策略的入口。

### V5：大盘弱修正

目标：

1. 用大盘热度弱修正普通 minute 任务下一次 `next_due_at`。
2. factor 公式固定为：

```text
factor = clamp(ratio^-0.25, 0.7, 1.4)
```

边界：

1. 只影响普通任务下一次 `next_due_at`。
2. 不影响关口任务。
3. 不影响失败重试。
4. 不影响 API 限流。
5. 不影响手动任务和每日兜底。
6. 先 shadow，再小范围写回。
7. 质量字段不达标时 factor 固定为 `1.0`。

## 3. 指标定义

指标名称：

```text
已观测视频池播放速率指数
```

该指标只反映观察池，不代表全站。指数值用于观察趋势和 V5 普通任务弱修正，不能用于对外宣称全站播放走势。

### 3.1 V2 event_time_index

`event_time_index` 是事后回填口径。它把闭合采样区间内的播放增量摊入真实发生时间 bucket。

用途：

1. 历史曲线。
2. K 线。
3. MA。
4. 回放和离线验证。
5. 检查 available time 指数的偏差。

计算口径：

1. 对每个 `aid` 按采样时间排序。
2. 使用相邻样本计算 `view_delta`、`danmaku_delta`、`reply_delta`、`favorite_delta`、`coin_delta`、`share_delta`。
3. 负增量先按 `0` 处理，同时写入质量 flags。
4. 跨 bucket 的区间按时间占比摊入多个 bucket。
5. 样本间隔超过 TTL 时，超出 TTL 的部分不进入有效贡献。

### 3.2 V2 available_time_index

`available_time_index` 是实时可用口径。它只使用当前时点已经可见的样本和有限补齐逻辑。

用途：

1. 当前大盘观察。
2. V5 普通任务弱修正。
3. 前端实时卡片。
4. 后端只读 API 的默认查询口径。

计算口径：

1. 不使用未来样本回填当前 bucket。
2. 对尚未闭合的 bucket 使用当前已知样本。
3. 对 stale 视频使用 freshness 权重或直接剔除。
4. 输出 `projected_share`，表示估算贡献占比。
5. 当 `projected_share` 超阈值时，V5 factor 固定为 `1.0`。

### 3.3 V2 bucket、K 线和 MA

bucket 粒度：

```text
30m, 1h, 2h, 3h, 6h, 12h, 24h
```

`7d` 和 `1mo` 基于 daily 聚合计算，不从 30m 明细长期扫描。

每个 bucket 至少输出：

```text
bucket_start
bucket_end
index_mode
bucket_size
index_value
raw_rate
baseline_rate
sampled_video_count
covered_video_count
quality_flags
computed_at
index_version
```

K 线字段：

```text
open
high
low
close
volume_delta
active_video_count
top10_share
quality_flags
```

MA 字段：

```text
ma_3
ma_6
ma_12
ma_24
ma_48
ma_source_bucket
ma_window_count
```

MA 只基于已通过质量门槛的 bucket。质量不足的 bucket 不参与默认 MA，但可以保留 debug 查询。

## 4. V2 PostgreSQL 设计方向

推荐先以 SQL view 或 materialized view 验证字段和口径，再决定是否加入实体表。

候选表或视图：

```text
market_video_interval
market_bucket_aggregate
market_index_bucket
market_index_candle
market_index_ma
market_daily_aggregate
market_weekly_aggregate
market_monthly_aggregate
market_recompute_queue
market_contributor_debug
market_index_shadow
market_index_writeback_audit
```

约束：

1. V2 可以创建 `market_*` 表或视图，V1 不创建。
2. 不长期保存全量 `(bucket, aid)` contribution 明细。
3. 只保存 top contributors 和短期 debug 样本。
4. 刷新任务沿用现有 PostgreSQL 定时任务管理方式。
5. 刷新节奏和 daily/latest 刷新分开。
6. 需要定义刷新失败时读取旧版本的行为。
7. 所有 aid/bvid 转换遵守数据库函数约定，不在 SQL 旁路实现算法。

### 4.1 V2 `market_video_interval`

用途：把 `video_minute` 相邻样本转换成区间事实。

候选字段：

```text
aid
sample_start
sample_end
dt_seconds
view_delta
danmaku_delta
reply_delta
favorite_delta
coin_delta
share_delta
is_negative_delta
is_stale_interval
source_row_count
computed_at
```

说明：

1. 该层只做样本差分和去重后的区间化。
2. 可以先用 materialized view 实现。
3. 去重规则必须固定为同一 `(aid, time)` 保留一条确定记录，或聚合成一条确定记录。
4. `source_row_count > 1` 时写入质量标记，供 debug 使用。

### 4.2 V2 `market_bucket_aggregate`

用途：按 bucket 聚合区间事实，形成指数计算输入。

候选字段：

```text
bucket_start
bucket_end
bucket_size
index_mode
total_view_delta
total_interaction_delta
covered_video_count
active_video_count
stale_video_count
projected_delta
projected_share
top1_share
top10_share
computed_at
index_version
quality_flags
```

说明：

1. `event_time_index` 使用区间摊入 bucket 的结果。
2. `available_time_index` 使用当前已知样本和 freshness 规则。
3. `projected_share` 超阈值时，输出仍可展示，但 V5 不使用。

### 4.3 V2 `market_index_bucket`

用途：保存最终指数点。

候选字段：

```text
bucket_start
bucket_end
bucket_size
index_mode
index_value
raw_rate
baseline_rate
ratio_to_baseline
coverage_ratio
quality_flags
computed_at
index_version
```

说明：

1. `index_value` 建议以 `100` 为基准。
2. baseline 可以先取最近 7 到 30 天同粒度中位数。
3. baseline 版本需要进入 `index_version` 或单独字段，便于回放。

### 4.4 V2 `market_index_candle`

用途：保存前端 K 线查询结果。

候选字段：

```text
candle_start
candle_end
bucket_size
index_mode
open
high
low
close
volume_delta
active_video_count
quality_flags
computed_at
```

说明：

1. K 线从 `market_index_bucket` 聚合，不直接扫 `video_minute`。
2. 查询范围较长时，API 默认读 K 线表，不读 bucket 明细。

### 4.5 V2 `market_index_ma`

用途：保存 MA 序列。

候选字段：

```text
bucket_start
bucket_size
index_mode
ma_window
ma_value
source_bucket_count
skipped_bucket_count
quality_flags
computed_at
```

说明：

1. MA 默认跳过质量不达标 bucket。
2. `source_bucket_count` 不足时输出质量 flags。
3. 前端应显示数据不足，不补成连续线。

## 5. V2 日、周、月聚合

日、周、月聚合用于观察大盘背景和调参，不替代 V1 minute 调度。

### 5.1 V2 日聚合

来源：

1. `video_daily` 最近完整日。
2. `video_daily_latest` 最新状态。
3. `video_minute` 当日高频样本摘要。

候选字段：

```text
date
observed_video_count
daily_view_delta
daily_active_video_count
minute_sampled_video_count
minute_write_count
median_daily_delta
p90_daily_delta
p99_daily_delta
quality_flags
computed_at
```

### 5.2 V2 周聚合

用途：

1. 观察池规模变化。
2. 热度分布变化。
3. 分层 `priority` 参数复盘。

候选字段：

```text
week_start
observed_video_count
weekly_view_delta
active_days
new_video_count
expired_video_count
median_daily_delta
p90_daily_delta
p99_daily_delta
quality_flags
computed_at
```

### 5.3 V2 月聚合

用途：

1. 长周期趋势展示。
2. 容量评估。
3. 指数 baseline 校准。

候选字段：

```text
month_start
observed_video_count
monthly_view_delta
active_days
minute_sampled_video_days
median_daily_delta
p90_daily_delta
p99_daily_delta
quality_flags
computed_at
```

## 6. V2 PostgreSQL 自动化边界

适合 PostgreSQL 自动处理的操作：

1. `video_minute` 去重读取 view。
2. 相邻样本差分。
3. bucket 聚合。
4. K 线和 MA 预计算。
5. 日、周、月聚合。
6. `market_recompute_queue` 合并刷新请求。
7. 旧 debug 样本清理。
8. 质量 flags 计算。

不适合 PostgreSQL 自动处理的操作：

1. 发起 Bilibili API 请求。
2. 管理 minute worker 生命周期。
3. 改写 V1 普通任务或关口任务。
4. 发送前端或后端通知。
5. 根据失败日志做复杂重试判断。

刷新策略：

1. 30m 和 1h bucket 可以高频刷新。
2. 2h 到 24h bucket 可以低频刷新。
3. 日聚合在 daily/latest 更新完成后刷新。
4. 周、月聚合每天刷新一次即可。
5. 刷新失败时保留上一版结果，并写入刷新日志。

`market_recompute_queue` 候选字段：

```text
scope
bucket_size
index_mode
range_start
range_end
reason
requested_at
claimed_at
finished_at
status
```

该队列只服务指数重算，不服务 V1 minute 采集。

## 7. V2 数据来源

V2 可用来源：

1. `video_minute`：minute 级播放和互动增量。
2. `video_daily`：日级趋势对照。
3. `video_daily_latest`：候选池规模、最新播放量和分位统计。
4. `dynamics`、`recommendations`、`processed_videos`：V2 指数计算只读这些表做关联解释，不直接把它们并入指数采集路径。
5. V1 采集 state 表：只读使用 `priority`、`next_minute_due_at`、`last_minute_success_at`、`last_daily_record_date`。
6. V1 采集 queue 表：只读观察 due 分布、locked 数量和普通任务到期压力。

说明：V1.6 或 V2 前置阶段可以把符合条件的 `processed_videos` 回填到 `video_collection_state`。这属于采集 state 准备，不属于 V2 指数 SQL 的计算逻辑。

重复样本处理：

1. `video_minute(aid, time)` 可能存在重复读取场景。
2. 指数 SQL 必须按 `(aid, time)` 去重或聚合。
3. 读取口径需要固定在 V2 文档或 SQL 注释中。
4. 去重后的 source count 进入质量字段，不进入 V1 状态表。

## 8. V2 质量字段

指数输出至少包含：

```text
coverage_ratio
projected_share
covered_video_count
active_video_count
stale_video_count
median_age_minutes
p95_age_minutes
top1_share
top10_share
breadth_index
computed_lag_seconds
duplicate_sample_count
negative_delta_count
quality_flags
```

质量 flags 候选：

```text
LOW_COVERAGE
HIGH_PROJECTED_SHARE
STALE_INPUT
LOW_ACTIVE_VIDEO_COUNT
HIGH_TOP_CONCENTRATION
DUPLICATE_SAMPLE_PRESENT
NEGATIVE_DELTA_PRESENT
COMPUTE_LAG_HIGH
BASELINE_MISSING
```

降级规则：

1. coverage 低时 factor 为 `1.0`。
2. projected share 高时 factor 为 `1.0`。
3. active video count 过低时 factor 为 `1.0`。
4. top contributors 占比过高时 factor 为 `1.0`。
5. 指数计算失败时 factor 为 `1.0`。
6. 结果过旧时 factor 为 `1.0`。
7. 关口任务不读取指数 factor。

## 9. V2 验证门槛

V2 指数上线前需要通过以下验证：

1. `event_time_index` 与 `available_time_index` 字段齐全。
2. 30m bucket 能覆盖最近 24h 的已知样本。
3. 日聚合能对齐最近完整日 `video_daily` 口径。
4. 重复 `(aid, time)` 读取不会放大指数。
5. 负增量不会导致指数反向异常。
6. 单个视频 top1 share 超阈值时写入质量 flags。
7. `projected_share` 超阈值时 V5 factor 固定为 `1.0`。
8. 刷新失败时 API 能读取上一版结果或返回明确降级响应。
9. V2 SQL 不修改 V1 state 表或 queue 表。
10. V2 SQL 不触发 minute worker。

## 10. V3 Java 后端 API

接口应围绕查询场景设计：

1. 市场总览：候选池规模、活跃采集数、minute 覆盖量、最近日增分布。
2. 指数曲线：指定时间范围、bucket、index mode 和 granularity。
3. K 线和 MA：指定范围、bucket、MA window。
4. 视频详情辅助：单个 `aid` 的 minute 曲线、daily 对照和当前 `priority`。
5. 质量诊断：coverage、projected share、stale count、median age、p95 age。
6. debug：top contributors、partition contribution、当前调度 factor。
7. shadow：V5 shadow 结果，只读返回，不发起写回。

后端要求：

1. 只读预计算表。
2. 不在请求路径现算大窗口。
3. 空表、结果过旧、质量 flags 存在时返回可解释响应。
4. 默认限制时间范围和 bucket 粒度，避免大范围误查。
5. 返回 `index_version` 和 `computed_at`。
6. 返回 `degrade_reason`，前端据此展示降级状态。

候选接口：

```text
GET /api/market/overview
GET /api/market/index
GET /api/market/candles
GET /api/market/ma
GET /api/market/videos/{aid}
GET /api/market/quality
GET /api/market/debug/contributors
GET /api/market/shadow
```

接口边界：

1. 不提供采集控制接口。
2. 不提供指数重算触发接口。
3. 不提供 V1 state 或 queue 写接口。
4. debug 接口需要分页、范围限制和权限控制。

## 11. V4 React 前端展示

页面面向只读观察：

1. 大盘总览，包括候选数量、采集覆盖、minute 写入量和降级状态。
2. 指数曲线，包括 event time 和 available time 口径。
3. K 线和 MA，包括 bucket 切换和 MA window 切换。
4. 视频曲线，包括 minute stats、daily 对照和当前 `priority`。
5. 质量字段，包括 coverage、projected share、stale count。
6. top contributors 和调度 factor debug。
7. V5 shadow 对比，包括 base due、shadow due、factor 和 degrade reason。

展示约束：

1. 页面需要写明该指标只代表已观测视频池。
2. 质量 flags 存在时，不把指数画成正常状态。
3. available time 口径用于默认实时视图。
4. event time 口径用于历史复盘视图。
5. 前端不直接发起 minute 采集。
6. 前端不写队列状态。
7. 前端不提供调参写入口。

## 12. V5 Shadow 和写回

Shadow 记录需要保留：

```text
aid
base_next_due_at
shadow_due_at
index_factor
ratio
quality_flags
degrade_reason
computed_at
index_version
```

Shadow 规则：

1. 只读 V1 普通任务 state。
2. 不修改 `next_due_at`。
3. 不修改 queue 中已经领取或已锁定任务。
4. 不处理 `priority <= 0` 的任务。
5. 不处理关口任务。
6. 只记录可解释的 due 差异。

写回保护：

1. 默认先按小范围 hash 或任务组启用。
2. factor 变化小于 10% 时不写回。
3. 同一作用域 5 到 10 分钟内最多生效一次。
4. 不重排已领取任务。
5. 不修改 dead 或 retry 决策。
6. 回滚时将 factor 固定为 `1.0`。
7. `quality_flags` 非空时不写回，除非该 flag 被明确列入允许清单。
8. `available_time_index` 过旧时不写回。

写回审计候选字段：

```text
aid
old_next_due_at
new_next_due_at
base_priority_minutes
index_factor
index_version
quality_flags
writeback_scope
written_at
rollback_batch_id
```

V5 只写普通任务下一次 due，不写指数表之外的业务数据。

## 13. 回滚与降级

V2 回滚：

1. 停止 `market_*` 刷新任务。
2. 后端继续读取上一版结果。
3. 上一版结果过旧时返回降级响应。
4. 不影响 V1 minute 采集。

V3 回滚：

1. 关闭 Java API 路由或返回降级响应。
2. 不删除 `market_*` 数据。
3. 不触发指数重算。

V4 回滚：

1. 前端隐藏大盘指数页面或显示只读降级状态。
2. 不影响后端和 PostgreSQL 刷新。

V5 回滚：

1. factor 固定为 `1.0`。
2. 停止写回普通任务 due。
3. 保留 shadow 和 writeback audit 供复盘。
4. 不修改关口任务。
5. 不修改失败重试。

降级响应字段：

```text
degraded
degrade_reason
last_good_computed_at
last_good_index_version
quality_flags
```

## 14. 风险与验收

风险：

1. `video_minute` 允许少量重复样本，指数 SQL 必须处理重复。
2. available time 的 `projected_share` 过高时，指数更多依赖估算。
3. 大盘修正过早写回，可能造成普通任务集中到期。
4. Java 后端和 React 前端过早接入，可能遇到字段频繁变化。
5. 指数刷新失败时需要保留旧版本读取路径。
6. 质量 flags 未进入 API 时，前端可能误读指数可信度。

验收检查：

1. 指数文档不要求 V1 新增 `market_*` 表。
2. V1 仍是同一套 worker 和同一个 `RateLimiter`。
3. V1 仍无 `collection_task_attempt` 表。
4. V1 仍无独立 minute worker。
5. V1 仍无独立 minute rate limit。
6. V2 不驱动 minute worker。
7. V2 SQL 不写 V1 state 或 queue。
8. V3/V4 只读接入。
9. V5 只影响普通任务下一次 `next_due_at`。
10. 关口任务全程不读取指数 factor。
