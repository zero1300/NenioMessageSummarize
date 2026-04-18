# Auto Memory Capsule

一个为 SillyTavern 设计的“滚动记忆压缩”扩展。

它会在对话楼层数达到阈值后，自动把较旧的一段消息总结成一条“记忆胶囊”，并在后续生成时用胶囊替换旧消息块，只把最近若干条原始消息继续原样发送给模型。

这版采用 `generate_interceptor` 工作，不再直接改真实聊天数组，所以：

- 不会在总结时卡住聊天页面
- 不需要刷新页面才能恢复显示
- 旧消息不会被真正删除
- 压缩只作用于“发送给模型的上下文”

## 设计思路

- 真实聊天保留完整原始消息
- 历史总结保存到当前聊天的 `chatMetadata`
- 每次生成前，通过 `generate_interceptor` 把：
  - 开头保留段
  - 胶囊摘要
  - 最近保留段
  组合成更短的 prompt 上下文

## 主要功能

- 自动按阈值生成记忆胶囊
- 手动立即生成一条新胶囊
- 可设置每次归档阈值
- 可设置始终保留最开始原始楼层
- 可设置始终保留最近原始楼层
- 支持简短 / 平衡 / 详细 / 自定义提示词
- 支持查看当前聊天的胶囊历史
- 支持重置当前聊天的扩展状态

## 使用方式

1. 安装到 SillyTavern 的第三方扩展目录
2. 启用扩展
3. 在扩展设置中开启“启用自动记忆压缩”
4. 设置：
   - 每次归档的楼层阈值
   - 始终保留最开始原始楼层
   - 始终保留最近原始楼层
   - 总结风格
5. 正常聊天即可

推荐默认思路：

- 阈值：`12`
- 保留最开始原始楼层：`0`
- 保留最近原始楼层：`6`

这意味着当“中间未归档原始楼层”累积到足够数量时，扩展会生成新的胶囊；后续发给模型的上下文里，会用胶囊替换旧消息块，而最开始保留段和最近保留段都会保持原样。

## 技术实现

- 优先使用 `SillyTavern.getContext()` 访问 `chat`、`chatMetadata`、`extensionSettings`、`eventSource`
- 设置保存在 `extensionSettings`
- 当前聊天的胶囊记录保存在 `chatMetadata`
- 使用 `renderExtensionTemplateAsync()` 渲染设置面板
- 使用 `generate_interceptor` 改写发送给模型的 prompt chat
- 使用 `event_types.APP_READY`、`CHAT_CHANGED`、`MESSAGE_SENT`、`MESSAGE_RECEIVED` 等事件刷新 UI

参考文档：

- https://docs.sillytavern.app/for-contributors/
- https://docs.sillytavern.app/for-contributors/writing-extensions/
