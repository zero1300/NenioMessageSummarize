# AI 快速上手指南 - Auto Memory Capsule

> 本文档旨在帮助 AI 快速理解项目架构，高效进行代码修改和功能开发。

## 项目概述

**Auto Memory Capsule** 是一个 SillyTavern 扩展，实现"滚动记忆压缩"功能。它自动将较旧的对话压缩成"记忆胶囊"，在发送给 LLM 时用胶囊替换旧消息，从而节省上下文空间。

**核心特性**：
- 不修改原始聊天消息，仅在生成时替换上下文
- 基于 `generate_interceptor` 机制实现
- 胶囊记录存储在 `chatMetadata` 中

## 文件结构

```
NenioMessageSummarize/
├── manifest.json      # SillyTavern 扩展清单
├── index.js           # 主逻辑（所有功能实现）
├── settings.html      # 设置面板 UI 模板
├── style.css          # 样式定义
└── README.md          # 用户文档
```

## 架构设计

### 核心流程

```
用户聊天 → 消息达到阈值 → 调用 LLM 生成胶囊 → 存储到 chatMetadata
                                                          ↓
发送消息时 ← interceptor 拦截 ← 用胶囊替换旧消息 ← 读取胶囊记录
```

### 关键机制

1. **generate_interceptor**: 注册到 `globalThis.autoMemoryCapsuleInterceptor`，在每次生成前被 SillyTavern 调用
2. **逻辑楼层映射**: 将真实消息数组映射为逻辑编号，跳过系统消息和已有胶囊
3. **胶囊虚拟消息**: 用标记为 `isPromptCapsule` 的虚拟消息替换原始消息

## 核心数据结构

### chatState（存储在 chatMetadata）

```javascript
{
    version: 3,
    summarizedUntil: 0,  // 已总结到的逻辑楼层号
    records: [           // 胶囊记录数组
        {
            id: "capsule_xxx",
            seqStart: 1,
            seqEnd: 12,
            messageCount: 12,
            summary: "摘要文本...",
            createdAt: Date.now(),
            style: "balanced"
        }
    ]
}
```

### extensionSettings

```javascript
{
    enabled: true,
    compactEnabled: true,
    threshold: 12,        // 每次归档的消息阈值
    keepHead: 0,          // 保留最开始的原始楼层数
    keepRecent: 6,        // 保留最近的原始楼层数
    summaryStyle: "balanced",  // brief/balanced/detailed/custom
    includePrevious: true,     // 总结时是否带上所有胶囊作为上下文
    customPrompt: ""
}
```

## 核心函数索引

| 函数名 | 行号 | 作用 |
|--------|------|------|
| `getChatState()` | 154 | 获取当前聊天的胶囊状态 |
| `buildLogicalMap(chat)` | 227 | 构建逻辑楼层映射 |
| `getPendingRawMessages(chat)` | 252 | 获取待压缩的原始消息 |
| `buildSummaryPrompt(recordInput, allSummaries, style)` | 275 | 构建 LLM 总结提示词 |
| `generateSummary(prompt)` | 302 | 调用 LLM 生成总结 |
| `makeRecord(recordInput, summaryText)` | 325 | 创建胶囊记录对象 |
| `makePromptCapsuleMessage(record)` | 343 | 创建胶囊虚拟消息 |
| `createCapsuleFromChat(chat, force)` | 372 | **核心函数**：生成新胶囊 |
| `buildPromptWithCapsules(chat)` | 806 | 用胶囊替换上下文中的旧消息 |

## 数据流详解

### 胶囊生成流程（createCapsuleFromChat）

```
1. getPendingRawMessages(chat)
   ↓ 返回待压缩消息列表
2. 检查消息数量是否达到阈值
   ↓
3. getChatState() 获取所有胶囊记录
   ↓
4. 将所有胶囊摘要合并为 allSummaries
   ↓
5. buildSummaryPrompt(recordInput, allSummaries, style)
   ↓ 构建包含所有历史摘要的提示词
6. generateSummary(prompt) 调用 LLM
   ↓
7. makeRecord() + state.records.push() 保存新胶囊
   ↓
8. state.summarizedUntil = record.seqEnd
   ↓
9. saveChatMetadata() 持久化
```

### 上下文替换流程（buildPromptWithCapsules）

```
1. 遍历 chat 数组
   ↓
2. 跳过非可压缩消息（系统消息、已有胶囊）
   ↓
3. 逻辑楼层到达胶囊 seqStart 时 → 插入胶囊虚拟消息
   ↓
4. 逻辑楼层在 [seqStart, seqEnd] 范围内 → 跳过原始消息
   ↓
5. 返回被替换后的 chat 数组
```

## 关键常量和标记

| 常量 | 值 | 用途 |
|------|-----|------|
| `MODULE_NAME` | `"auto_memory_capsule"` | storage key 前缀 |
| `INTERCEPTOR_NAME` | `"autoMemoryCapsuleInterceptor"` | 拦截器函数名 |
| `MARKER_PREFIX` | `"【记忆胶囊】"` | 胶囊消息标记 |

## 事件绑定

| 事件 | 处理 |
|------|------|
| `CHAT_CHANGED` | 刷新 UI |
| `MESSAGE_SENT/RECEIVED` | 刷新 UI |
| `MESSAGE_EDITED/DELETED` | 刷新 UI |
| `GENERATION_ENDED` | 刷新 UI + 检查是否需要生成新胶囊 |
| `APP_READY` | 扩展初始化 |

## 修改指南

### 修改总结逻辑

修改 `buildSummaryPrompt()` 函数（275行）：
- 调整提示词内容
- 修改 `STYLE_PROMPTS` 常量（50行）

### 修改归档阈值逻辑

修改 `createCapsuleFromChat()` 函数（372行）：
- 调整 `threshold`、`keepHead`、`keepRecent` 的使用方式

### 修改胶囊显示格式

修改 `makePromptCapsuleMessage()` 函数（343行）：
- 调整虚拟消息的 `mes` 字段格式

### 修改 UI

修改 `settings.html`（100行）和 `style.css`（322行）：
- 添加新的设置项
- 调整样式

## 常见问题

### Q: 为什么使用逻辑楼层而不是实际索引？

A: 实际消息数组中包含系统消息和已有胶囊，这些不应参与编号。逻辑楼层只对可压缩消息编号，确保胶囊覆盖范围正确。

### Q: 如何添加新的总结风格？

A: 在 `STYLE_PROMPTS` 常量（50行）中添加新条目，然后在 `settings.html` 的 `<select>` 中添加选项。

### Q: 如何修改胶囊存储位置？

A: 当前存储在 `chatMetadata["auto_memory_capsule"]` 中。修改 `getChatState()` 函数（154行）即可。

## 测试建议

1. 创建新聊天，发送超过阈值数量的消息
2. 观察控制台日志（`[AutoMemoryCapsule]` 前缀）
3. 验证胶囊生成和上下文替换
4. 测试编辑、重roll、回滚功能
5. 测试聊天切换后状态是否正确加载

## 参考文档

- [SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/)
- [generate_interceptor 文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
