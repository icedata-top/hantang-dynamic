# 代码库分析报告 | Codebase Analysis Report

## 📋 目录 | Table of Contents

1. [整体架构 | Overall Architecture](#overall-architecture)
2. [当前功能 | Current Functionality](#current-functionality)
3. [数据流 | Data Flow](#data-flow)
4. [文件结构 | File Structure](#file-structure)
5. [存在的问题与Gap | Gaps and Issues](#gaps-and-issues)
6. [重构需求总结 | Refactoring Requirements](#refactoring-requirements)

---

## 整体架构 | Overall Architecture

### 技术栈 | Tech Stack

- **语言 | Language**: TypeScript + Node.js
- **数据库 | Database**: DuckDB (部分实现), MySQL (可选)
- **构建工具 | Build**: @vercel/ncc
- **包管理器 | Package Manager**: pnpm
- **关键依赖 | Key Dependencies**:
  - `@duck/node-api`: DuckDB接口
  - `axios`: HTTP请求
  - `mysql2`: MySQL连接
  - `@json2csv/plainjs`: CSV导出
  - `nodemailer`: 邮件通知
  - `zod`: 配置验证

### 模块划分 | Module Division

```
src/
├── index.ts           # 入口,启动定时任务
├── core/              # 核心状态管理
│   └── state.ts       # 状态持久化(JSON文件)
├── services/          # 业务服务层
│   └── tracker.ts     # 主追踪服务
├── api/               # Bilibili API封装
│   ├── client.ts      # HTTP客户端 + 拦截器
│   ├── dynamic.ts     # 动态API
│   ├── video.ts       # 视频API
│   ├── relation.ts    # 用户关系API
│   └── signatures/    # 签名算法
├── utils/             # 工具函数
│   ├── dynamic.ts     # 动态处理
│   ├── processCard.ts # 卡片转视频数据
│   ├── filter.ts      # 内容过滤
│   ├── deduplicator/  # 去重逻辑
│   ├── exporter/      # 导出逻辑
│   └── notifier/      # 通知逻辑
├── config/            # 配置管理
└── types/             # TypeScript类型定义
```

---

## 当前功能 | Current Functionality

### 1. **动态抓取 | Dynamic Fetching**

- [✅] 支持获取关注用户的动态 (视频+转发)
- [✅] 分页抓取 ([getNewDynamic](file:///d:/dev/hantang-dynamic/src/api/dynamic.ts#60-65) → [getHistoryDynamic](file:///d:/dev/hantang-dynamic/src/api/dynamic.ts#66-75))
- [✅] 时间窗口过滤 (最近N天内的动态)
- [✅] 动态ID去重
- [⚠️] **问题**: 分页抓取完一页后立即处理所有,而不是按页处理

### 2. **动态处理 | Dynamic Processing**

- [✅] 转发动态的溯源 (type 1 → 获取原动态)
- [✅] 基于BVID的内存去重 ([removeDuplicateDynamics](file:///d:/dev/hantang-dynamic/src/utils/dynamic.ts#89-97))
- [✅] 数据库去重 (仅MySQL, DuckDB未实现)
- [✅] 视频标签获取 (可选)
- [✅] 内容过滤 (type_id白名单, 内容黑/白名单)

### 3. **数据导出 | Data Export**

- [✅] **CSV**: 追加模式,使用tab分隔
- [✅] **DuckDB**: 基础实现 (INSERT, 简单去重)
- [✅] **MySQL**: 完整实现 (INSERT IGNORE, 去重查询)
- [⚠️] **问题**: DuckDB去重未实现, 无法作为有效缓存

### 4. **通知功能 | Notification**

- [✅] Telegram Bot
- [✅] Email (SMTP)
- [✅] HTTP Webhooks (支持模板变量)

### 5. **用户关系管理 | User Relation Management**

- [✅] 批量关注/取关/拉黑
- [✅] CSV导入用户ID
- [✅] 自动检测当前关注列表
- [✅] 自动解除拉黑后重新关注
- [⚠️] **问题**: 与主流程解耦,独立脚本运行

### 6. **状态管理 | State Management**

- [✅] [state.json](file:///d:/dev/hantang-dynamic/state.json) 保存:
  - [lastDynamicId](file:///d:/dev/hantang-dynamic/src/core/state.ts#83-86): 上次抓取的最大动态ID
  - [lastUA](file:///d:/dev/hantang-dynamic/src/core/state.ts#87-90): 用户代理
  - [biliTicket](file:///d:/dev/hantang-dynamic/src/core/state.ts#91-94) + [ticketExpiresAt](file:///d:/dev/hantang-dynamic/src/core/state.ts#95-98): Ticket缓存
  - [imgKey](file:///d:/dev/hantang-dynamic/src/core/state.ts#99-102) + [subKey](file:///d:/dev/hantang-dynamic/src/core/state.ts#103-106) + [wbiKeysExpiresAt](file:///d:/dev/hantang-dynamic/src/core/state.ts#107-110): WBI签名密钥
- [⚠️] **问题**:
  - 无法记录已处理的BVID列表
  - 无法记录转发关系 (forward dynamic → original bvid)
  - 重启后会重新处理重复内容

---

## 数据流 | Data Flow

### 当前流程 | Current Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Tracker.start() - 每15分钟触发                            │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. fetchDynamics() - 全部抓取完再返回                        │
│    - video type (8)                                          │
│    - forward type (1)                                        │
│    ├─ getNewDynamic()                                        │
│    └─ getHistoryDynamic(offset) × N                          │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. onPage() callback - 批量处理                              │
│    └─ filterAndProcessDynamics(dynamics[])                   │
│       ├─ processForwardedDynamics() - 溯源转发               │
│       ├─ removeDuplicateDynamics() - 内存去重 (bvid)         │
│       ├─ filterNewDynamics() - 数据库去重 (仅MySQL)          │
│       ├─ processCard() × N - 获取视频详情+标签               │
│       └─ filterVideo() × N - 内容过滤                        │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. exportData() - 并行导出到所有启用的存储                   │
│    ├─ saveToMysql()                                          │
│    ├─ saveToDuckDB()                                         │
│    └─ saveAsCSV()                                            │
└───────────────┬─────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. notifyNewVideos() - 发送通知                              │
└─────────────────────────────────────────────────────────────┘
```

### 问题分析 | Problem Analysis

1. **非流式处理**:
   [fetchDynamics](file:///d:/dev/hantang-dynamic/src/api/dynamic.ts#81-150)会等待所有分页完成才返回,无法实现"处理一页,抓取一页"
2. **重复处理**: 每次重启后[state.json](file:///d:/dev/hantang-dynamic/state.json)只记录[lastDynamicId](file:///d:/dev/hantang-dynamic/src/core/state.ts#83-86),可能重新处理旧视频
3. **无缓存**: 转发关系(`forward_dynamic_id → bvid`)未缓存,每次都要API查询
4. **无推荐**: 不支持从视频推荐中发现新UP主
5. **无溯源**: 不支持定期回溯历史数据

---

## 文件结构 | File Structure

### 关键文件说明 | Key Files

| 文件                               | 行数 | 主要功能                     |
| ---------------------------------- | ---- | ---------------------------- |
| [src/services/tracker.ts](file:///d:/dev/hantang-dynamic/src/services/tracker.ts)          | 80   | 主调度器,定时触发抓取        |
| [src/api/dynamic.ts](file:///d:/dev/hantang-dynamic/src/api/dynamic.ts)               | 150  | 动态API封装,分页逻辑         |
| [src/api/client.ts](file:///d:/dev/hantang-dynamic/src/api/client.ts)                | 182  | HTTP客户端,错误处理,自动重试 |
| [src/api/relation.ts](file:///d:/dev/hantang-dynamic/src/api/relation.ts)              | 601  | 用户关系API (关注/拉黑)      |
| [src/utils/dynamic.ts](file:///d:/dev/hantang-dynamic/src/utils/dynamic.ts)             | 97   | 动态处理主逻辑               |
| [src/utils/processCard.ts](file:///d:/dev/hantang-dynamic/src/utils/processCard.ts)         | 41   | 视频卡片→VideoData转换       |
| [src/utils/filter.ts](file:///d:/dev/hantang-dynamic/src/utils/filter.ts)              | 58   | 内容过滤                     |
| [src/utils/deduplicator/index.ts](file:///d:/dev/hantang-dynamic/src/utils/deduplicator/index.ts)  | 69   | 去重调度                     |
| [src/utils/deduplicator/mysql.ts](file:///d:/dev/hantang-dynamic/src/utils/deduplicator/mysql.ts)  | 140  | MySQL去重实现                |
| [src/utils/deduplicator/duckdb.ts](file:///d:/dev/hantang-dynamic/src/utils/deduplicator/duckdb.ts) | 29   | DuckDB去重 (未实现)          |
| [src/utils/exporter/duckdb.ts](file:///d:/dev/hantang-dynamic/src/utils/exporter/duckdb.ts)     | 75   | DuckDB导出                   |
| [src/utils/exporter/mysql.ts](file:///d:/dev/hantang-dynamic/src/utils/exporter/mysql.ts)      | 62   | MySQL导出                    |
| [src/utils/exporter/csv.ts](file:///d:/dev/hantang-dynamic/src/utils/exporter/csv.ts)        | 78   | CSV导出                      |
| [src/core/state.ts](file:///d:/dev/hantang-dynamic/src/core/state.ts)                | 163  | 状态管理                     |

### 配置文件 | Config Files

- [config.toml.example](file:///d:/dev/hantang-dynamic/config.toml.example) (145行): 配置模板,包含所有可配置项
- `src/config/`: Zod schema + 配置加载逻辑

---

## 存在的问题与Gap | Gaps and Issues

### 🔴 Critical Issues

#### 1. **缓存不足 | Insufficient Caching**

- ❌ **转发关系未缓存**: 每次重启都要重新查询 `getDynamic(forward_id)`
- ❌ **已处理BVID未记录**:
  `state.json`只记录`lastDynamicId`,无法防止重复处理同一个视频
- ❌ **DuckDB去重未实现**: `filterNewDynamicsDuckDB` 和
  `filterNewVideoDataDuckDB` 是空函数

**影响**:

- 浪费API调用
- 重复处理相同数据
- 无法实现可靠的增量更新

#### 2. **处理流程耦合 | Tightly Coupled Processing**

- ❌ **全量抓取后处理**: `fetchDynamics` 必须等所有分页完成才返回
- ❌ **无法流式处理**: 不能"抓一页→处理一页→存一页"

**影响**:

- 内存占用高 (所有动态都在内存中)
- 处理延迟大 (必须等待全部抓取完成)
- 无法实现真正的pagination

#### 3. **缺少关键功能 | Missing Features**

- ❌ **推荐视频**: 无法从视频推荐中发现新UP主
- ❌ **历史回溯**: 无法定期扫描过去一个月的所有动态
- ❌ **并发控制**: 没有根据Proxy/No-Proxy调整并发数 (20/s vs 1/s)
- ❌ **相关视频**: 无法递归处理推荐的相关视频

### 🟡 Design Issues

#### 4 **模块耦合 | Module Coupling**

- ⚠️ 动态抓取、处理、存储都在一个流程中
- ⚠️ `utils/dynamic.ts` 同时负责转发处理、去重、调用processCard
- ⚠️ 难以单独测试或替换某个环节

#### 5. **配置不够细 | Config Granularity**

- ⚠️ 无DuckDB路径配置
- ⚠️ 无并发控制配置
- ⚠️ 无历史回溯配置

#### 6. **重复代码 | Code Duplication**

- ⚠️ `deduplicator/mysql.ts`, `deduplicator/csv.ts`, `deduplicator/duckdb.ts`
  结构类似但独立
- ⚠️ `exporter/mysql.ts`, `exporter/csv.ts`, `exporter/duckdb.ts` 同样重复

---

## 重构需求总结 | Refactoring Requirements

根据用户需求和代码分析,整理如下:

### 📌 用户明确要求 | User Explicit Requirements

1. **获取一页,处理一页** ✅
   - 当前: 抓完所有页才处理
   - 目标: 流式处理,降低内存占用

2. **更好的缓存** ✅
   - 转发动态 → 原始BVID 映射
   - 已处理的BVID列表
   - 使用DuckDB作为主缓存

3. **定期追溯** ✅
   - 每周日重新扫描过去30天的所有动态
   - 需要缓存支持,避免重复处理

4. **推荐视频 → 新UP主** ✅
   - 从推荐视频中发现未关注的UP主
   - 跟踪视频被推荐的次数

5. **代码解耦** ✅
   - 动态抓取 → 独立模块
   - 视频详情获取 → 独立模块
   - 分析过滤 → 独立模块
   - 存储 → 独立模块

6. **并发控制** ✅
   - 有Proxy: 最多20视频/秒
   - 无Proxy: 最多1视频/秒

7. **简化存储** ✅
   - **仅保留**: DuckDB本地数据库
   - **兼容导出**: MySQL (只导出通过过滤的数据)
   - **取消**: CSV支持 (可选)

### 📊 数据库设计建议 | Database Design

#### DuckDB Schema

```sql
-- 已处理视频表 (所有见过的视频)
CREATE TABLE processed_videos (
    aid BIGINT PRIMARY KEY,
    bvid VARCHAR UNIQUE NOT NULL,
    pubdate TIMESTAMP,
    title VARCHAR,
    description TEXT,
    tag TEXT,
    pic VARCHAR,
    type_id INTEGER,
    user_id BIGINT,
    is_filtered BOOLEAN,          -- 是否通过过滤
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 转发关系表 (缓存)
CREATE TABLE forward_dynamics (
    forward_dynamic_id BIGINT PRIMARY KEY,
    original_bvid VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 推荐视频表
CREATE TABLE recommendations (
    video_bvid VARCHAR,
    recommended_by_bvid VARCHAR,
    recommend_count INTEGER DEFAULT 1,
    recommend_order INTEGER,              -- 推荐位置 (1-N)
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (video_bvid, recommended_by_bvid)
);

-- 发现的用户表
CREATE TABLE discovered_users (
    user_id BIGINT PRIMARY KEY,
    user_name VARCHAR,
    fans INTEGER DEFAULT 0,            -- 粉丝数
    videos_seen INTEGER DEFAULT 0,     -- 见过的视频总数
    videos_filtered INTEGER DEFAULT 0, -- 通过过滤的视频数
    filter_pass_rate REAL DEFAULT 0.0, -- 过滤通过率 (videos_filtered / videos_seen)
    discovered_from VARCHAR,           -- 'following' | 'recommendation'
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_following BOOLEAN DEFAULT FALSE,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 下一步 | Next Steps

1. ✅ **完成代码阅读** (已完成)
2. 🔄 **编写详细的实现计划** (进行中)
3. ⏳ **等待用户审核批准**
4. ⏳ **开始重构实现**
