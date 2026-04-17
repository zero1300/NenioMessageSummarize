// NenioMessageSummarize - 极简版消息总结插件
const extensionName = "NenioMessageSummarize";
const extensionVersion = "1.0.0";

let settings = {
    autoSummarize: true,
    removeOriginal: true,        // 是否移除原消息（核心节省 token 功能）
    summarizePrompt: "请用简洁的一到两句话总结下面这条消息，保留核心信息、情感和关键细节：\n\n{{message}}",
    messageLag: 0,               // 延迟多少条消息后再总结（0 = 立即）
    maxSummaryLength: 120        // 总结最大字符数限制（防止过长）
};

let summarizedMessages = new Set(); // 记录已总结的消息 id

// 加载设置
async function loadSettings() {
    const saved = await window.SillyTavern.getExtensionSettings(extensionName);
    if (saved) Object.assign(settings, saved);
}

// 保存设置
async function saveSettings() {
    await window.SillyTavern.saveExtensionSettings(extensionName, settings);
}

// 生成总结
async function summarizeMessage(messageText, isUser) {
    if (!messageText || messageText.trim() === "") return null;

    const prompt = settings.summarizePrompt
        .replace("{{message}}", messageText)
        .replace("{{char}}", window.characters[window.characterId]?.name || "角色")
        .replace("{{user}}", window.user.name || "用户");

    try {
        const response = await window.SillyTavern.generateRaw(prompt, {
            temperature: 0.7,
            max_tokens: 150,
            stop: ["\n\n"]
        });

        let summary = response.trim();
        if (summary.length > settings.maxSummaryLength) {
            summary = summary.substring(0, settings.maxSummaryLength) + "...";
        }
        return summary;
    } catch (err) {
        console.error("[NenioSummarize] 生成总结失败:", err);
        return null;
    }
}

// 处理新消息
async function onMessageReceived(event) {
    if (!settings.autoSummarize) return;

    const chat = window.getContext().chat;
    if (!chat || chat.length === 0) return;

    const lastMsg = chat[chat.length - 1];
    const msgId = lastMsg._id || lastMsg.id;

    if (summarizedMessages.has(msgId)) return; // 已处理过

    // 等待滞后消息数
    if (settings.messageLag > 0 && chat.length <= settings.messageLag) return;

    const summary = await summarizeMessage(lastMsg.mes, lastMsg.is_user);

    if (!summary) return;

    summarizedMessages.add(msgId);

    if (settings.removeOriginal) {
        // 替换原消息为总结（节省 token）
        lastMsg.mes = `[总结] ${summary}`;
        lastMsg.original_mes = lastMsg.mes; // 备份原内容（可选）
        lastMsg.is_system = true;           // 标记为系统/总结消息
        lastMsg.name = "总结";              // 显示为“总结”
    } else {
        // 不移除原消息时，在下方添加总结消息
        chat.push({
            name: "总结",
            mes: summary,
            is_user: false,
            is_system: true,
            send_date: Date.now()
        });
    }

    // 刷新聊天界面
    window.eventSource.emit('chatChanged');
    await saveSettings();
}

// 初始化
async function init() {
    await loadSettings();

    // 监听消息事件
    window.eventSource.on('MESSAGE_RECEIVED', onMessageReceived);
    window.eventSource.on('MESSAGE_SENT', onMessageReceived);

    // 添加 Slash Command
    window.SillyTavern.registerSlashCommand('neniosum', {
        aliases: ['nsum'],
        callback: async () => {
            const chat = window.getContext().chat;
            if (chat.length === 0) return;
            const lastMsg = chat[chat.length - 1];
            const summary = await summarizeMessage(lastMsg.mes, lastMsg.is_user);
            if (summary) {
                if (settings.removeOriginal) {
                    lastMsg.mes = `[总结] ${summary}`;
                } else {
                    chat.push({ name: "总结", mes: summary, is_user: false, is_system: true });
                }
                window.eventSource.emit('chatChanged');
            }
        },
        helpString: "手动对最后一条消息进行总结"
    });

    console.log(`✅ [NenioMessageSummarize v${extensionVersion}] 已加载`);
}

// 导出模块（SillyTavern 扩展必须）
module.exports = {
    init,
    onSettingsChanged: async (newSettings) => {
        Object.assign(settings, newSettings);
        await saveSettings();
    },
    getSettings: () => settings
};