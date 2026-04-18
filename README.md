# Auto Memory Capsule

一个为 SillyTavern 设计的“滚动记忆压缩”扩展。

它会在对话楼层数达到阈值后，自动把较旧的一段消息总结成一条“记忆胶囊”，并把原始消息块压缩掉，只保留最近若干条原始消息继续展开。这样做的目标是：

- 节省后续生成的上下文 token
- 降低长对话中模型遗忘前文的概率
- 让聊天仍然保留一条可读的长期记忆线

## 设计思路

- 不单纯“生成总结然后放着不用”
- 而是把旧消息块真正压缩成一条系统记忆消息留在聊天里
- 最近若干条消息保持原样，方便模型延续当前场景
- 每次压缩记录都会保存到当前聊天的 `chatMetadata`

## 主要功能

- 自动按阈值归档旧消息
- 手动立即压缩当前可归档消息
- 可设置每次归档阈值
- 可设置始终保留的最近原始楼层数
- 支持简短 / 平衡 / 详细 / 自定义提示词
- 支持查看当前聊天的胶囊历史
- 支持重置当前聊天的扩展状态

## 使用方式

1. 安装到 SillyTavern 的第三方扩展目录
2. 启用扩展
3. 在扩展设置中开启“自动记忆压缩”
4. 设置：
   - 每次归档的楼层阈值
   - 始终保留最近原始楼层
   - 总结风格
5. 正常聊天即可

推荐默认思路：

- 阈值：`12`
- 保留最近原始楼层：`6`

这意味着当“未归档原始楼层”累积到足够数量时，扩展会把最旧的 12 条压成一条胶囊，而最近 6 条保持原样。

## 技术实现

- 优先使用 `SillyTavern.getContext()` 访问 `chat`、`chatMetadata`、`extensionSettings`、`eventSource`
- 设置保存在 `extensionSettings`
- 当前聊天的压缩记录保存在 `chatMetadata`
- 使用 `renderExtensionTemplateAsync()` 渲染设置面板
- 使用 `event_types.APP_READY`、`CHAT_CHANGED`、`MESSAGE_SENT`、`MESSAGE_RECEIVED` 等事件驱动状态更新

参考文档：

- https://docs.sillytavern.app/for-contributors/
- https://docs.sillytavern.app/for-contributors/writing-extensions/
