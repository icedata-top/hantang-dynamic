# 自适应 Minute 发布与执行计划

## 1. 目标和范围

本计划覆盖 V1 minute 采集发布、V1.5 daily 程序改造和 V1.6 `processed_videos` 回填 state。V2 以后的大盘指数、Java 后端只读 API、React 前端展示和大盘弱修正统一放在 `docs/plans/postgres-market-index-plan.md`。

首个执行版本目标：

1. 用 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 建立 minute 采集观察池。
2. 从当前 `video_daily` 全量导入已有视频到统一 state。
3. 低活跃但最近 7 天仍有新增播放的视频设为 `priority = 0`；最近 7 天零增长的视频设为 `priority = -2`。
4. 新视频入库时，只有规则结果通过才立即 upsert state，并进入 bootstrap minute 追踪。
5. 为 `priority > 0` 的视频按各自周期分散首次到期时间。
6. 复用现有 worker 调度骨架和同一个 `RateLimiter` 领取并执行到期采样。
7. 将采样结果追加写入现有 `video_minute`。
8. 连续运行 24h 后，判断 V1 fixed priority minute 闭环是否满足进入 V1.5 daily 改造。
9. V1.5 改造 daily 程序，让 daily 从统一 state 读取候选。
10. V1.6 从 `processed_videos` 回填 state，补齐没有 daily 历史但符合条件的视频。

第一版边界：

1. 普通任务和关口任务共享同一队列表、同一 worker 调度骨架和同一个 `RateLimiter`。
2. `priority > 0` 表示每隔多少分钟跑 minute，`priority = 0` 表示每日 daily，`priority = -2` 表示周日 daily，`priority = -1` 表示 daily 也不跑。
3. 不新增 `collection_task_attempt` 表。
4. 不新增独立 minute worker 进程。
5. 不新增独立 minute rate limit 系统。
6. 不接入指数 factor，不做前后端展示。

## 2. 当前实施基线

本计划以正式仓库 `D:\dev\icedata\hantang-dynamic` latest `a03c19b354d7b5b2dbf0055ad3dcd66fb6159906` 为事实源。

已存在的代码和数据库事实：

1. 已有 `src/config` Zod 配置框架和 database 配置。
2. 已有 `src/database/index.ts` 的 `Database` 单例，使用 `pg.Pool`。
3. 已有 `video_daily`、`video_minute`、`video_daily_latest` schema。
4. `video_minute` 当前只有 `(aid, time)` 普通索引，不是唯一约束。
5. `video_minute` 当前没有 `bvid` 字段。V1 不写 `bvid`。
6. 服务层已有 `src/services/tracker.ts`、`src/services/dynamics.service.ts`、`src/services/details.service.ts`。
7. `src/api/video.ts` 的视频详情函数是 `fetchVideoFullDetail`，endpoint 是 `/view/detail`。
8. `DetailsService.processVideoById()` 不用于 minute 采样。
9. `RateLimiter` 是并发槽位，可作为 minute 采样的同一并发控制入口。
10. `config` debug 输出和 API error `response.config` 可能泄露敏感信息，minute 高频路径启用前必须确认脱敏。

V1 缺口：

1. `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 候选 helper。
2. `video_minute` 批量写入 DAO/helper。
3. 统一采集 state 和 due queue。
4. stats-only minute handler。
5. `video_minute` 追加写入和查询端重复样本处理约定。

## 3. 关键参数

| 参数 | 第一版取值 | 用途 |
|---|---:|---|
| 入池阈值 | `daily_delta > 100 OR weekly_avg_daily_delta >= 100` | 从 `video_daily` 或等价日增来源选出观察池 |
| `target_delta_per_sample` | `100` | 每次采集期望新增播放量目标 |
| `target_delta_lower` | `50` | `target_delta_per_sample` 的运行下限 |
| `target_delta_upper` | `200` | `target_delta_per_sample` 的运行上限 |
| `min_positive_priority` | `1` | 正数 `priority` 最小值，表示最短 minute 周期 |
| `max_positive_priority` | `720` | 正数 `priority` 最大值，表示最长 minute 周期 |
| `bootstrap_priority` | `10` | 新发布且缺少 daily delta 视频的初始 minute 周期 |
| `bootstrap_ttl_hours` | `24` | bootstrap 最长保留小时数，不得超过 24，超时仍无 daily baseline 时降级为 `priority = 0` |
| `bootstrap_label_content_types` | `['vocaloid', 'maybe_vocaloid']` | 正式 label 口径下允许进入 bootstrap minute 的内容类型 |
| `bootstrap_label_origin` | `'rule'` | 正式 label 口径下只接受规则结果 |
| `bootstrap_label_writers` | `['classification_apply', 'classification_trigger']` | 正式 label 口径下允许触发 bootstrap 的规则写入路径 |
| `bootstrap_tid_v2_allowlist` | `[2022, 2061]` | `icedata_label` 正式完成前允许进入 bootstrap minute 的临时 fallback 白名单 |
| `weekly_zero_delta_days` | `7` | 计算零增长降频的完整自然日窗口 |
| `weekly_daily_priority` | `-2` | 只在业务时区周日进入 daily 候选的保留 priority 值 |
| `minute_burst_delta_threshold` | `500` | 相邻两次 minute 样本触发提频的新增播放量 |
| `minute_burst_priority` | `1` | burst 后使用的更高频 minute 周期 |
| `processed_backfill_new_video_age_days` | `7` | processed_videos 回填时判定新视频的年龄阈值 |
| `gate_lead_time` | `30min` | gate 预测窗口在下一次普通采样时间上的提前量 |
| `gate_min_lead_ratio` | `0.10` | 距离关口低于目标值该比例时允许提前插入 gate |
| `gate_max_lead_views` | `500` | gate 近关口兜底的最大提前播放量 |
| `collection_business_timezone` | `Asia/Shanghai` | daily 和周日判断使用的业务时区 |
| `consumer_tick` | `1min` | 检查到期任务频率 |
| `lock_duration` | `30s` | 单次任务锁定时长 |
| `claim_batch_size` | `50` | 默认每轮领取数量 |
| `batch_size` | `50` | 单次 batch stats 请求的 AID 数量 |

`consumer_tick = 1min` 表示每分钟跑一轮调度检查和任务派发，不表示每分钟只能执行一批 HTTP 请求。每轮 claim 到的任务可以继续按 `batch_size` 拆批，实际 HTTP 并发由现有 worker 和 `RateLimiter` 收敛；调度层不需要另建并发预算。吞吐调整先通过现有 `RateLimiter` 和 `claim_batch_size` 完成，不新增 `batch_concurrency`、`max_batches_per_tick`、`max_http_requests_per_tick`。

`target_delta_lower` 和 `target_delta_upper` 接入运行逻辑。执行时先计算 `effective_target_delta_per_sample = clamp(target_delta_per_sample, target_delta_lower, target_delta_upper)`，再用有效 target 计算 `priority`；它们不是入池阈值。

正式 label 口径来自 `D:\dev\icedata\icedata_label\docs\plans\classification-rules-v1-design.md`：`processed_videos.is_deleted = false`、`label_origin = 'rule'`、`labeled_by in ('classification_apply', 'classification_trigger')`，且 `label_content_type in ('vocaloid', 'maybe_vocaloid')` 时，才视为规则结果通过。`hantang-dynamic` 只提供 `video_collection_state` 和 SQL 维护函数，不重新实现分类规则；`icedata_label` 规则 trigger 成功后直接调用该函数或执行等价 upsert，不把 `classification_crawler_handoff_events` 作为正式消费合约。

正式 trigger 必须同时覆盖进入和退出：规则结果通过时 upsert 或激活 state；删除、降为 `not_vocaloid/unknown`、或不再满足 `label_origin/labeled_by` 规则口径时，把已有 state 设为 `priority = -1` 并清空普通 minute due。

`bootstrap_tid_v2_allowlist = [2022, 2061]` 是 `D:\dev\icedata\icedata_label` 正式完成前的临时 fallback 口径。后续 `icedata_label` 提供正式 label 结果后，以完整正式 label 口径为准；在此之前，不处理未命中 allowlist 的新 AID。

`daily_delta_source` 固定使用 `daily_delta`、`weekly_avg`、`bootstrap`、`processed_backfill`。缺少数据不是独立来源；缺少最新相邻日增且无法计算 weekly avg 时，不改写现有 source，新行按视频年龄走 bootstrap 或 processed backfill。

## 4. 初始分散规则

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

offset_minutes = aid % priority
base_time = floor(now to priority-minute boundary)
next_due_at = base_time + offset_minutes minutes

if next_due_at < now:
  next_due_at = next_due_at + priority minutes
```

该规则只适用于 `priority > 0` 的视频。

## 5. V1 工作包

### 5.1 工作包 A：schema 确认

交付内容：

1. 确认 `video_daily`、`video_daily_latest` 和 `video_minute` 字段。
2. 确认 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 的来源口径。
3. 确认 `video_minute` 只追加写入。
4. 确认 `video_minute` 不写 `bvid`。

### 5.2 工作包 B：state 和 queue

交付内容：

1. 建立统一 state 表，记录 `aid`、`priority`、`next_minute_due_at`、日增来源、daily 已覆盖日期和 minute 成功状态。
2. 建立 queue 表，记录 `aid`、`task_type`、`dedupe_key`、`due_at`、`status`、`locked_until`、`attempt_count`、`gate_value`、`gate_reason`；`task_type` 只允许 `minute`、`gate`，`status` 只允许 `pending`、`leased`、`completed`、`abandoned`。
3. `priority > 0` 生成普通 minute 任务并每日参与 daily，`priority = 0` 每日 daily，`priority = -2` 周日 daily，`priority = -1` 停 daily。
4. 不建立 `collection_task_attempt`。
5. 不保存完整请求、完整响应、HTTP 状态或错误详情，出错查日志。

### 5.3 工作包 C：选池初始化

交付内容：

1. 从现有 `video_daily` 全量提取 distinct `aid`。
2. 从最新相邻日增计算 `daily_delta`。
3. 计算最近 7 天日均播放量 `weekly_avg_daily_delta`。
4. 写入或更新统一 state。
5. `daily_delta > 100` 或 `weekly_avg_daily_delta >= 100` 的视频计算正数 `priority`。
6. 只要当前端点和 7 天前端点播放量一致，就写入 `priority = -2`；中间缺日不影响该判断，缺少任一端点时不做零增长判断。
7. 日增和周内日均都不到 100、但最近 7 天仍有新增播放的视频写入 `priority = 0`。
8. 按各自 `priority` 分散初始化 `next_minute_due_at`。
9. 重复运行不会生成重复 active 普通任务。

### 5.4 工作包 D：新视频 bootstrap

交付内容：

1. 新 AID 在 `processed_videos` 的正式视频行完成规则写入后，只有 `is_deleted = false`、`label_origin = 'rule'`、`labeled_by in ('classification_apply', 'classification_trigger')` 且 `label_content_type in ('vocaloid', 'maybe_vocaloid')`，才 upsert `video_collection_state`。
2. `D:\dev\icedata\icedata_label` 正式完成前，规则结果通过的临时 fallback 口径为 `tid_v2 in (2022, 2061)`，对应配置 `bootstrap_tid_v2_allowlist = [2022, 2061]`。
3. 没有 daily delta 的新视频设置 `daily_delta_source = 'bootstrap'`。
4. 初始 `priority` 使用 `bootstrap_priority`，例如 `10`。
5. 立即计算 `next_minute_due_at`，不等第二天 daily 完成。
6. 拥有完整 daily delta 后，按正式规则重算 `priority`。
7. 达到 `bootstrap_ttl_hours` 仍没有完整 daily baseline 时，降级为 `priority = 0`。
8. `priority = -1` 的视频不因新入库事件自动恢复采集。

细分步骤：

1. D1：先在 `hantang-dynamic` 建立 `video_collection_state`、bootstrap 配置校验和 state upsert/停采 SQL 函数。
2. D2：函数入参或内部读取必须覆盖 `aid`、`pubdate`、`ctime`、`tid_v2`、`label_content_type`、`label_origin`、`labeled_by`、`is_deleted`、`is_filtered` 和 daily history。
3. D3：临时阶段允许本仓库按 `tid_v2 in (2022, 2061)` 触发 bootstrap，便于在 `icedata_label` trigger 接入前跑通 minute 闭环。
4. D4：正式阶段要求 `icedata_label` 的规则 trigger 直接调用 D1 的 SQL 函数或执行等价 upsert，不引入 outbox consumer。
5. D5：trigger 必须覆盖 demotion 和删除。已有 state 的 AID 不再满足正式 label 口径时，写成 `priority = -1` 并清空普通 minute due；没有 state 的非正例不创建追踪行。

### 5.5 工作包 E：Minute Handler

交付内容：

1. 每分钟跑一轮 tick，领取到期任务并派发 batch。tick 是调度轮次，不限制本分钟只能打一批 HTTP 请求。
2. 单轮默认领取 50 条。
3. claim 使用事务和 `FOR UPDATE SKIP LOCKED`。
4. 使用同一套 worker 调度骨架和同一个 `RateLimiter`。
5. 合并 AID batch，批量获取 stats。
6. 批量追加写入 `video_minute`。
7. 成功 aid 的 state 推进由 PostgreSQL 函数或 `video_minute` 写入 trigger 处理，queue 完成只走 `ack_video_collection_tasks(task_ids)`。
8. 相邻两次 minute 样本新增播放量超过 `minute_burst_delta_threshold` 时，PostgreSQL 自动调小 `priority` 并重算下一次 due。
9. 失败 aid 只写日志并等待重试。

验收标准：

1. 不调用 `DetailsService.processVideoById()`。
2. 主路径不按单个 aid 循环调用 `/view/detail`。
3. `fetchVideoFullDetail` 只作为现有详情能力或小批量 fallback。
4. 批量响应按 aid 显式匹配。

### 5.6 工作包 F：关口任务管理

交付内容：

1. `gate` 任务写入 queue 表，`dedupe_key = gate:{aid}:{gate_value}`。
2. `gate_value` 记录目标关口值。
3. `gate_reason` 记录触发原因，例如 `view_threshold` 或 `manual_gate`。
4. claim 时 `gate` 任务排在普通任务前面，排序由 SQL 的 `task_type` 规则完成。
5. 关口任务成功后写入 `video_minute`，记录对应 gate 的跨过前后样本，再调用 `ack_video_collection_tasks(task_ids)` 完成当前 gate task。
6. 关口任务失败时只写日志，按 queue 重试策略处理。
7. 播放量小于 `10000` 时，自动 gate 目标为下一个整千播放量。
8. 播放量大于等于 `10000` 时，自动 gate 目标为下一个整万播放量。
9. PostgreSQL 根据最新 daily/latest/minute 样本、上一条样本到当前样本的播放区间、距离下一个关口的播放量差值、最近增速和 `next_minute_due_at + gate_lead_time` 判断是否插入 gate。
10. 已跨过的区间内如果存在多个未完成关口，V1 每次评估最多插入一个自动 gate，并选择距离实际跨越点最近的 gate。
11. 距离关口小于 `least(gate_value * gate_min_lead_ratio, gate_max_lead_views)` 且最近增速为正时，允许提前插入 gate，避免关口附近采样过晚。
12. 自动插入前排除轻量 crossing history 中已记录的同一 `(aid, gate_value)`，也排除 active queue 中已有的同一 dedupe key；completed queue 行可以按普通 TTL 清理。
13. gate 自动筛选只生成 queue 任务，不改变 state `priority`。

### 5.7 工作包 G：PostgreSQL 自动化

交付内容：

1. PostgreSQL 负责计算最新完整日 `daily_delta` 和近 7 天均值。
2. PostgreSQL 负责把 `daily_delta` 映射为 `priority`。
3. PostgreSQL 负责从现有 `video_daily` 全量导入或补齐 state。
4. PostgreSQL 负责为新视频 bootstrap 设置初始 `priority` 和 `next_minute_due_at`。
5. PostgreSQL 负责从 `priority > 0` 和 `next_minute_due_at` 生成普通 queue 任务。
6. PostgreSQL 负责 active dedupe。
7. PostgreSQL 可根据 latest/daily/minute 样本插入 `gate` 任务。
8. `video_minute` 写入后由 trigger 或显式 SQL 函数推进 `last_minute_success_at`、`last_view`、`next_minute_due_at`，但不完成 queue。
9. `video_daily` 写入或 daily/latest 刷新后由 trigger 或显式 SQL 函数推进 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。
10. `priority = 0` 的视频只要当前端点和 7 天前端点播放量一致，PostgreSQL 就只把 `priority` 调整为 `-2`。
11. 相邻 minute 样本新增播放量超过阈值时，PostgreSQL 只把 `priority` 调整为更高频正数，并重算下一次 due。
12. `processed_videos` 规则 label 或删除状态变化时，由 `icedata_label` trigger 直接调用 state 维护函数，upsert、停采或忽略。
13. queue 领取、租约过期、active dedupe、成功完成、放弃旧任务都封装为 SQL 函数，TS 只调用 claim 和 ack 接口。
14. worker 仍负责 API 请求、认证、proxy/direct fallback、日志脱敏和并发控制。

实现口径：

1. `video_minute` 使用 `AFTER INSERT` statement-level trigger 批量推进 state。
2. `video_daily` 使用 `AFTER INSERT` statement-level trigger，或在现有 pg_cron 同步 SQL 后调用同一个 refresh 函数。
3. queue 完成只使用显式 `ack_video_collection_tasks(task_ids)`，避免只按 AID 误完成非本轮任务；部分成功 batch 只 ack 成功 AID 对应的 task id 子集。
4. daily 不记录 attempt。失败率来自应用日志或 queue `attempt_count` 汇总。
5. `hantang-dynamic` 提供 `fn_upsert_collection_state_from_processed_video()` 或同等 SQL 函数，供 `icedata_label` 的 `AFTER INSERT OR UPDATE` trigger 直接调用；该函数只维护调度状态，不搬视频详情字段，并忽略 `NEW.aid < 0` 的 repair 中间态。
6. queue 完成只走 `ack_video_collection_tasks(task_ids)`，按 task id 和任务状态校验；失败任务等待 `locked_until` 过期重试或显式回到 `pending`，超过 `max_attempts` 后进入 `abandoned`。

### 5.8 工作包 H：日志脱敏

交付内容：

1. config debug 输出不泄露 Cookie、数据库 URL、password。
2. API error `response.config` 不泄露 Cookie header。
3. 通知和日志不包含完整数据库连接串。
4. Bilibili Cookie、SESSDATA、CSRF、数据库密码会被 redaction。

### 5.9 工作包 I：V1.5 daily 改造

交付内容：

1. daily 程序改为从统一 state 读取候选。
2. `priority > 0` 和 `priority = 0` 的视频继续参与每日 daily。
3. `priority = -2` 的视频只在按 `collection_business_timezone` 判断的每周日进入 daily 候选。
4. `priority = -1` 的视频不进入 daily。
5. `priority = 0` 的视频只要当前端点和 7 天前端点播放量一致，就只调整 `priority` 为 `-2`。
6. `priority = -2` 的视频只要周日 daily 发现最近窗口新增播放量大于 0，就把 `priority` 调回 `0`。
7. daily 成功以 `video_daily` 事实行写入为准，PostgreSQL 自动刷新 `last_daily_record_date`、`latest_daily_delta`、`weekly_avg_daily_delta` 和 `priority`。
8. daily 仍写入现有 `video_daily` 和 `video_daily_latest`。
9. daily 失败详情只写日志，不写 state 表。

### 5.10 工作包 J：processed_videos 回填 state

该工作包属于 V1 范围内的 V1.6，放在 V1.5 minute/daily 改造之后、V2 指数之前。

交付内容：

1. 从 `processed_videos` 扫符合条件的视频，补齐 `video_collection_state`。
2. 优先使用 `pubdate` 判定视频年龄，其次使用 `ctime`，不使用本地 `created_at` 判定视频年龄。
3. 已有 daily 历史的 AID 按 daily 规则计算 `priority`。
4. 没有 daily 历史的新视频按 bootstrap 规则入 state。
5. 没有 daily 历史的老视频写入 `daily_delta_source = 'processed_backfill'`、`priority = 0`，先等半夜 daily 建立基线，不进入 minute。
6. 删除或不可用视频写入或保持 `priority = -1`。
7. 不把 `processed_videos` 的详情缓存、过滤结果、推荐关系、`notes` 或 `extras` 迁入 state。

## 6. 阶段门槛

V1 总范围分阶段推进，每个阶段完成后再进入下一阶段。

| 阶段 | 包含工作包 | 出口条件 |
|---|---|---|
| Phase 0 preflight | A | 表字段、索引、`RateLimiter`、正式 label 口径、`tid_v2` fallback 和 endpoint 假设已确认 |
| Phase 1 schema/SQL | B、D1、G 的 schema 和函数部分 | state、queue、crossing history、state upsert/停采函数、claim/ack 函数可重复初始化，并产出 `icedata_label` trigger 接入契约 |
| Phase 2 helper | C、G 的候选和刷新 helper | 候选、priority、state 初始化、queue 生成 helper 可用 |
| Phase 3 fixed priority minute | D2-D5、E、F、H | allowlist、直接 state hook 语义、10 到 30 分钟检查、24h fixed priority 验收通过 |
| Phase 4 V1.5 daily | I | daily 只按 state 读取候选，`-2` 周日规则通过小样本验证 |
| Phase 5 V1.6 backfill | J | `icedata_label` 直接写 state trigger 已接入；回填可重复运行，不覆盖 `priority = -1`，不误拉规则未通过的新视频进 bootstrap |

Phase 1 结束后、进入 V1.6 前，直接起 agent 到 `D:\dev\icedata\icedata_label` 修改规则 trigger 接入方式，让规则写入成功后直接维护 `video_collection_state`，并覆盖删除和 demotion 停采路径。Phase 3 通过后可以手动关闭 SaaS 对 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 观察池的 minute 处理。Phase 4 和 Phase 5 仍属于 V1 总范围，但不阻塞 fixed priority minute 闭环的 24h 验收。

## 7. 24h 运行验收

运行前检查：

1. 采集状态表和索引已完成。
2. 当前 `video_daily` 已全量导入统一 state。
3. 新视频 bootstrap upsert 已完成。
4. 关口任务路径可通过同一 handler 执行。
5. 消费者配置为每分钟一轮 tick、batch 50、锁定 30 秒，HTTP 并发由现有 worker 和 `RateLimiter` 收敛。
6. batch stats wrapper 已完成 smoke。
7. 批量追加写入和重复样本查询已验证。
8. allowlist 覆盖至少一个完整 batch、一个 bootstrap 新视频、proxy/direct 两条路径、重复样本查询和响应缺失模拟。

通过标准：

1. 普通任务按 `priority` 分钟周期推进。
2. 关口任务通过 `task_type = gate` 和 dedupe 保留语义，claim 排序由 SQL 显式处理。
3. 事实表只有追加写入。
4. 重复采样在读取侧可处理。
5. 失败任务有日志和可解释重试结果。
6. burst 提频只调整 `priority` 和下一次 due，不新增 attempt 明细。
7. 自动 gate 能覆盖 `10000` 以下整千和 `10000` 及以上整万关口。

进入 V1.5 daily 改造前，24h fixed priority 运行必须满足：

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

指标口径与 `docs/adaptive-minute-collection-plan.md` 的运行验收一致。验收报告只需列出执行 task 数、成功写入 AID 数、放弃 task 数、到期延迟和 batch 写入结果，不要求细分过多队列或日志分母。

V1.5 验收补充：

1. `priority = -2` 的视频在业务时区非周日不进入 daily 候选。
2. `priority = -2` 的视频在业务时区周日进入 daily 候选。
3. `priority = 0` 在当前端点和 7 天前端点播放量一致后降为 `-2`。
4. `priority = -2` 在周日 daily 发现最近窗口新增播放量大于 0 后升回 `0`。
5. 相邻 minute 样本新增播放量超过 `minute_burst_delta_threshold` 后，`priority` 被调小到更高频正数；`0/-2` 可提升为 `minute_burst_priority`，`-1` 不自动恢复。
6. `priority = -1` 的视频不会被 burst 或 processed_videos hook 自动恢复。
7. `processed_videos` 老视频回填后不会第一天误进 minute。

## 8. 回滚和降级

降级开关：

1. 关闭 minute 采集入口。
2. 暂停普通任务生成。
3. 保留已写入的 `video_minute` 事实行。
4. API 风控升高时支持 proxy only、direct only、暂停 direct fallback、降低 batch size 或按错误码暂停采样。
5. 降低现有 `RateLimiter` 并发。
6. 把未领取普通任务批量后移。

数据处理：

1. 事实表只追加，不删除。
2. 错误样本通过质量标记或后续读取口径排除。
3. 正在执行的 batch 只 ack 成功 aid。
4. 失败或未返回 aid 记录摘要并回到重试路径。

## 9. Fixed Priority 阶段不做

1. V1 跑通后，手动关闭 SaaS 对 `daily_delta > 100 OR weekly_avg_daily_delta >= 100` 观察池的 minute 处理。
2. 不新增 `collection_task_attempt`。
3. 不保存全量执行明细。
4. 不新增独立 minute worker 进程。
5. 不新增独立 minute rate limit 系统。
6. 不做指数 shadow。
7. 不做 Java 后端 API。
8. 不做 React 前端展示。
9. 不让指数影响关口任务。
10. 不改变每日兜底任务语义。

Phase 3 fixed priority minute 阶段不改 daily 程序；daily 入口迁移属于 V1.5。

## 10. 默认决策和实施前检查

### 10.1 `daily_delta` 来源

默认决策：

1. 第一版 `daily_delta` 使用 `video_daily` 最新两个完整自然日的相邻播放量差值。
2. `video_daily_latest` 只用于确认最新池规模和播放量快照。
3. 若缺少最新相邻日增，则回退到近 7 天平均日增，并记录 `daily_delta_source = 'weekly_avg'`。
4. 当前自然日未完成时，不用当天局部数据入池。

### 10.2 采样事实表

默认决策：

1. 第一版优先复用现有 `video_minute`。
2. 第一版不补唯一约束，不要求 upsert。
3. `video_minute` 当前没有 `bvid` 字段。V1 不写 `bvid`。
4. 错误信息写日志，不写入采集状态表，不新增 attempt 明细表。
5. 事实表只追加，不删除旧记录。

### 10.3 普通任务和关口任务

默认决策：

1. 第一版使用同一 worker 调度骨架。
2. 普通任务来自 `priority > 0` 的 state 行。
3. 关口任务写入 queue 表，`task_type = gate`。
4. 两类任务共享同一个 `RateLimiter`。

### 10.4 V1.5 daily 程序

默认决策：

1. daily 程序读取统一 state。
2. `priority > 0` 和 `priority = 0` 每日进入 daily 候选。
3. `priority = -2` 只在按 `collection_business_timezone` 判断的周日进入 daily 候选。
4. `priority = -1` 不跑 daily。
5. daily 成功以 `video_daily` 事实行写入为准，由 PostgreSQL 刷新 state 的 daily 字段和 `priority`。

### 10.5 processed_videos 回填

默认决策：

1. 回填属于 V1 范围内的 V1.6，不属于 V1 fixed priority minute 闭环。
2. 历史 backfill 和新增写入 hook 分开做。
3. 新增写入 hook 放在 PostgreSQL trigger，TS 不在 `DetailsService` 里逐行维护 state。
4. 新旧视频按 `pubdate` 或 `ctime` 分流，新视频可 bootstrap，老视频默认 daily-only。
