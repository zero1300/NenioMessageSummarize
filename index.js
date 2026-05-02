// ============================================================
// Auto Memory Capsule（自动记忆胶囊）扩展
// 功能：自动将较旧的对话压缩为记忆胶囊，节省上下文空间
// 通过 generate_interceptor 机制在生成时替换旧消息为胶囊摘要
// ============================================================

// --------------- 常量定义 ---------------

/** 模块名称，用于 storage 和 metadata 的 key */
const MODULE_NAME = "auto_memory_capsule";
/** 拦截器函数名，注册到 globalThis 上 */
const INTERCEPTOR_NAME = "autoMemoryCapsuleInterceptor";
/** 设置面板模板名称 */
const TEMPLATE_NAME = "settings";
/** 控制台日志前缀 */
const LOG_PREFIX = "[AutoMemoryCapsule]";
/** 胶囊消息标记前缀 */
const MARKER_PREFIX = "【记忆胶囊】";

// --------------- 默认配置 ---------------

/**
 * 默认设置，存储在 SillyTavern 的 extensionSettings 中
 * @property {boolean} enabled - 是否启用自动压缩
 * @property {boolean} compactEnabled - 是否在生成时用胶囊替换旧上下文
 * @property {number} threshold - 每次归档的消息阈值
 * @property {number} keepHead - 始终保留最开始的原始楼层数
 * @property {number} keepRecent - 始终保留最近的原始楼层数
 * @property {string} summaryStyle - 总结风格（brief/balanced/detailed/custom）
 * @property {boolean} includePrevious - 总结时是否带上一条胶囊作为上下文
 * @property {string} customPrompt - 自定义总结提示词
 */
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    compactEnabled: true,
    threshold: 12,
    keepHead: 0,
    keepRecent: 6,
    summaryStyle: "balanced",
    includePrevious: true,
    customPrompt: "",
});

/**
 * 三种预设总结风格的提示词
 * brief: 简洁，保留关键事件和关系
 * balanced: 平衡，保留事件、关系、目标、情绪
 * detailed: 详细，保留所有可供续写的长期记忆信息
 */
const STYLE_PROMPTS = Object.freeze({
    brief: "请将下面消息楼层进行总结，按时间或逻辑顺序保留关键信息，省略冗余描述",
    balanced: "请把以下对话压缩成一条适合长期记忆的总结。保留关键事件、人物关系变化、正在推进的目标、情绪变化、线索和承诺。只输出总结正文。",
    detailed: "请详细总结以下对话，并保留可供后续续写使用的长期记忆信息，包括关键事件、人物关系变化、当前目标与障碍、伏笔秘密和承诺、当前场景状态。只输出总结正文。", 
});

// --------------- 全局状态 ---------------

/** 当前设置对象（从 extensionSettings 读取） */
let settings = null;
/** 是否已完成初始化 */
let initialized = false;
/** 是否正在处理胶囊生成（防止并发） */
let processing = false;
/** 防抖刷新定时器 */
let scheduledRefresh = null;
/** LLM 调用深度计数器（防止递归触发） */
let summaryGenerationDepth = 0;

// --------------- 工具函数 ---------------

/** 带前缀的控制台日志输出 */
function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

/** 带前缀的控制台警告输出 */
function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/** 获取 SillyTavern 上下文对象 */
function getContext() {
    if (typeof SillyTavern === "undefined" || typeof SillyTavern.getContext !== "function") {
        throw new Error("SillyTavern context unavailable");
    }
    return SillyTavern.getContext();
}

/**
 * 获取当前扩展的文件夹路径
 * 用于加载 settings.html 模板
 */
function getExtensionFolder() {
    try {
        const path = new URL(import.meta.url).pathname;
        const marker = "/scripts/extensions/";
        const index = path.indexOf(marker);
        if (index >= 0) {
            return path.slice(index + marker.length).replace(/\/index\.js$/, "").replace(/^\/+/, "");
        }
    } catch (e) {}
    return "third-party/NenioMessageSummarize";
}

/** HTML 转义，防止 XSS */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

// --------------- 设置管理 ---------------

/**
 * 获取扩展设置，自动补全缺失的默认值
 * @returns {object} 当前设置对象
 */
function getSettings() {
    const ctx = getContext();
    const extensionSettings = ctx.extensionSettings ?? ctx.extension_settings ?? window.extension_settings ?? {};
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    if (!ctx.extensionSettings && !ctx.extension_settings && window.extension_settings) {
        window.extension_settings[MODULE_NAME] = extensionSettings[MODULE_NAME];
    }
    return extensionSettings[MODULE_NAME];
}

/** 保存设置到 SillyTavern */
function saveSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === "function") {
        ctx.saveSettingsDebounced();
    } else if (typeof window.saveSettingsDebounced === "function") {
        window.saveSettingsDebounced();
    }
}

// --------------- 聊天状态管理 ---------------

/**
 * 获取当前聊天的胶囊状态
 * 存储在 chatMetadata["auto_memory_capsule"] 中
 * @returns {object} { version, summarizedUntil, records }
 *   - summarizedUntil: 已总结到的逻辑楼层号（该楼层之前的消息已被胶囊覆盖）
 *   - records: 胶囊记录数组
 */
function getChatState() {
    const ctx = getContext();
    const meta = ctx.chatMetadata ?? window.chat_metadata ?? {};
    if (!meta[MODULE_NAME]) {
        meta[MODULE_NAME] = {
            version: 3,
            summarizedUntil: 0,
            records: [],
        };
    }
    if (!Array.isArray(meta[MODULE_NAME].records)) {
        meta[MODULE_NAME].records = [];
    }
    if (typeof meta[MODULE_NAME].summarizedUntil !== "number") {
        meta[MODULE_NAME].summarizedUntil = 0;
    }
    return meta[MODULE_NAME];
}

/** 保存聊天元数据（胶囊状态） */
async function saveChatMetadata() {
    const ctx = getContext();
    if (typeof ctx.saveMetadata === "function") {
        await ctx.saveMetadata();
    } else if (typeof window.saveMetadata === "function") {
        await window.saveMetadata();
    }
}

// --------------- 消息判断 ---------------

/**
 * 判断消息是否可被压缩
 * 跳过系统消息和已存在的胶囊虚拟消息
 */
function isCompressibleMessage(message) {
    if (!message) return false;
    if (message.is_system) return false;
    if (message.extra?.[MODULE_NAME]?.isPromptCapsule) return false;
    return true;
}

// --------------- 名称获取 ---------------

/** 获取用户和角色名称 */
function getPersonaNames() {
    const ctx = getContext();
    return {
        user: ctx.name1 || window.name1 || "User",
        character: ctx.name2 || window.name2 || "Character",
    };
}

/** 获取当前角色名称 */
function getCharacterName() {
    const ctx = getContext();
    const characterId = ctx.characterId;
    if (characterId !== undefined && characterId !== null && ctx.characters?.[characterId]) {
        return ctx.characters[characterId].name || getPersonaNames().character;
    }
    return getPersonaNames().character;
}

// --------------- 逻辑楼层映射 ---------------

/**
 * 将真实 chat 数组映射为逻辑楼层索引
 * 跳过系统消息和已有胶囊，只对可压缩消息编号
 * @param {Array} chat - SillyTavern 的聊天消息数组
 * @returns {{ map: Array, totalLogicalCount: number }}
 *   map: [{ logicalIndex, actualIndex, message }]
 *   totalLogicalCount: 可压缩消息总数
 */
function buildLogicalMap(chat) {
    const map = [];
    let logicalIndex = 0;

    for (let actualIndex = 0; actualIndex < chat.length; actualIndex++) {
        const message = chat[actualIndex];
        if (!isCompressibleMessage(message)) continue;
        logicalIndex += 1;
        map.push({
            logicalIndex,
            actualIndex,
            message,
        });
    }

    return {
        map,
        totalLogicalCount: logicalIndex,
    };
}

/**
 * 获取待压缩的原始消息
 * 排除已总结的和需要保留头部的消息
 */
function getPendingRawMessages(chat) {
    const state = getChatState();
    const { map, totalLogicalCount } = buildLogicalMap(chat);
    const keepHead = Number(settings.keepHead || 0);
    const pending = map.filter(item => item.logicalIndex > state.summarizedUntil && item.logicalIndex > keepHead);
    log("待合并的消息: ", pending);
    return {
        map,
        pending,
        totalLogicalCount,
        summarizedUntil: state.summarizedUntil,
    };
}

// --------------- 总结提示词构建 ---------------

/**
 * 构建发送给 LLM 的总结提示词
 * @param {Array} recordInput - 待压缩的消息数组
 * @param {string} allSummaries - 所有胶囊的摘要内容（可选）
 * @param {string} style - 总结风格
 * @returns {string} 完整的提示词
 */
function buildSummaryPrompt(recordInput, allSummaries, style) {
    const basePrompt = style === "custom" && settings.customPrompt.trim()
        ? settings.customPrompt.trim()
        : STYLE_PROMPTS[style] || STYLE_PROMPTS.balanced;

    const names = getPersonaNames();
    let transcript = "";
    for (const item of recordInput) {
        const sender = item.message.is_user ? names.user : (item.message.name || names.character);
        transcript += `#${item.logicalIndex} ${sender}: ${item.message.mes || ""}\n\n`;
    }

    if (settings.includePrevious && allSummaries) {
        transcript = `[所有长期记忆]\n${allSummaries}\n\n[本次要压缩的新对话]\n${transcript}`;
    }

    return `${basePrompt}\n\n角色：${getCharacterName()}\n请压缩的消息范围：#${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex}\n\n${transcript}`;
}

// --------------- LLM 调用 ---------------

/**
 * 调用 SillyTavern 的 generateQuietPrompt 生成总结
 * 使用 skipWIScan 跳过世界书扫描
 * @param {string} prompt - 提示词
 * @returns {string} LLM 返回的总结文本
 */
async function generateSummary(prompt) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== "function") {
        throw new Error("generateQuietPrompt unavailable");
    }

    summaryGenerationDepth += 1;
    try {
        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt, skipWIScan: true });
        return String(result || "").trim();
    } finally {
        summaryGenerationDepth = Math.max(0, summaryGenerationDepth - 1);
    }
}

// --------------- 胶囊记录操作 ---------------

/**
 * 创建胶囊记录对象
 * @param {Array} recordInput - 被压缩的消息数组
 * @param {string} summaryText - LLM 生成的总结文本
 * @returns {object} 胶囊记录
 */
function makeRecord(recordInput, summaryText) {
    const first = recordInput[0];
    const last = recordInput[recordInput.length - 1];
    return {
        id: `capsule_${Date.now().toString(36)}`,
        seqStart: first.logicalIndex,
        seqEnd: last.logicalIndex,
        messageCount: recordInput.length,
        summary: summaryText,
        createdAt: Date.now(),
        style: settings.summaryStyle,
    };
}

/**
 * 创建用于替换上下文的胶囊虚拟消息
 * 在 generate_interceptor 中替换原始消息
 */
function makePromptCapsuleMessage(record) {
    return {
        name: "Memory Capsule",
        is_user: false,
        is_system: false,
        mes: `${MARKER_PREFIX}\n覆盖楼层 #${record.seqStart} - #${record.seqEnd}（${record.messageCount} 条）\n${record.summary}`,
        send_date: Date.now(),
        extra: {
            [MODULE_NAME]: {
                isPromptCapsule: true,
                recordId: record.id,
                seqStart: record.seqStart,
                seqEnd: record.seqEnd,
            },
        },
    };
}

// --------------- 胶囊生成核心逻辑 ---------------

/**
 * 核心函数：从聊天中创建记忆胶囊
 * 1. 检查是否有足够的消息需要压缩
 * 2. 调用 LLM 生成总结
 * 3. 保存胶囊记录到 chatState
 * @param {Array} chat - SillyTavern 聊天数组
 * @param {boolean} force - 是否强制生成（忽略阈值）
 * @returns {boolean} 是否成功生成
 */
async function createCapsuleFromChat(chat, force = false) {
    log("尝试创建记忆胶囊，force =", force);
    
    if (processing || !settings.enabled) return false;

    const { pending } = getPendingRawMessages(chat);

    const threshold = Number(settings.threshold);
    const keepRecent = Number(settings.keepRecent);
    const eligibleCount = pending.length - keepRecent;

    // 非强制模式下，消息数不足则跳过
    if (!force && eligibleCount < threshold) {
        return false;
    }

    // 强制模式下，尝试压缩所有可压缩消息
    let targetCount = force ? Math.max(0, eligibleCount) : threshold;
    // 特殊情况：如果可压缩数不足但总消息数达到阈值，强制压缩全部
    if (force && pending.length > 0 && eligibleCount <= 0 && pending.length >= threshold) {
        targetCount = pending.length;
    }

    if (targetCount <= 0) return false;

    const recordInput = pending.slice(0, targetCount);
    // log("recordInput: ", recordInput)
    if (!recordInput.length) return false;

    processing = true;
    setStatus(`正在生成 #${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex} 的记忆胶囊...`, "info");

    try {
        const state = getChatState();
        const allSummaries = state.records.map(r => r.summary).join("\n\n");
        log("所有胶囊摘要: ", allSummaries);
        log("当前总结风格: ", settings.summaryStyle);
        const prompt = buildSummaryPrompt(recordInput, allSummaries, settings.summaryStyle);
        log("发送给 LLM 的提示词: ", prompt);
        const summary = await generateSummary(prompt);
        if (!summary) {
            throw new Error("模型返回了空总结");
        }
        const record = makeRecord(recordInput, summary);
        state.records.push(record);
        state.summarizedUntil = record.seqEnd;
        await saveChatMetadata();
        refreshUi();
        setStatus(`已生成记忆胶囊，覆盖 #${record.seqStart} - #${record.seqEnd}`, "success");
        return true;
    } catch (error) {
        warn("Capsule generation failed:", error);
        setStatus(`生成失败：${error.message || error}`, "error");
        return false;
    } finally {
        processing = false;
    }
}

// --------------- 胶囊回滚与重roll ---------------

/**
 * 回滚指定胶囊记录
 * 删除胶囊并更新 summarizedUntil
 * @param {string} recordId - 胶囊 ID
 * @returns {boolean} 是否成功
 */
function rollbackCapsule(recordId) {
    const state = getChatState();
    const index = state.records.findIndex(r => r.id === recordId);
    if (index === -1) return false;

    state.records.splice(index, 1);

    if (state.records.length > 0) {
        const lastRecord = state.records[state.records.length - 1];
        state.summarizedUntil = lastRecord.seqEnd;
    } else {
        state.summarizedUntil = 0;
    }

    return true;
}

/**
 * 重roll指定胶囊
 * 先回滚删除旧胶囊，再重新调用 LLM 生成新总结
 * @param {string} recordId - 胶囊 ID
 * @returns {boolean} 是否成功
 */
async function rerollCapsule(recordId) {
    const state = getChatState();
    const index = state.records.findIndex(r => r.id === recordId);
    if (index === -1) return false;

    rollbackCapsule(recordId);
    await saveChatMetadata();
    refreshUi();

    await createCapsuleFromChat(getContext().chat || [], true);
    return true;
}

// --------------- 统计信息 ---------------

/**
 * 计算当前聊天的胶囊统计信息
 * @returns {object} { totalLogicalCount, pendingCount, capsuleCount, archivedCount, percent }
 */
function getStats() {
    const chat = getContext().chat || [];
    const state = getChatState();
    const { totalLogicalCount } = buildLogicalMap(chat);
    const pendingCount = Math.max(0, totalLogicalCount - state.summarizedUntil);
    const archivedCount = state.records.reduce((sum, record) => sum + (record.messageCount || 0), 0);
    const percent = totalLogicalCount > 0 ? Math.round((archivedCount / totalLogicalCount) * 100) : 0;
    return {
        totalLogicalCount,
        pendingCount,
        capsuleCount: state.records.length,
        archivedCount,
        percent,
    };
}

// --------------- UI 更新 ---------------

/** 设置状态栏文本和样式 */
function setStatus(text, type = "") {
    const el = document.getElementById("amc_status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "amc-status" + (type ? ` ${type}` : "");
}

/** 刷新设置面板的 UI 显示 */
function refreshUi() {
    const stats = getStats();

    $("#amc_stat_total").text(stats.totalLogicalCount);
    $("#amc_stat_pending").text(stats.pendingCount);
    $("#amc_stat_capsules").text(stats.capsuleCount);
    $("#amc_stat_archived").text(stats.archivedCount);
    $("#amc_progress_fill").css("width", `${stats.percent}%`);
    $("#amc_progress_text").text(`${stats.percent}% 已压缩`);

    $("#amc_enabled").prop("checked", settings.enabled);
    $("#amc_compact_enabled").prop("checked", settings.compactEnabled);
    $("#amc_threshold").val(settings.threshold);
    $("#amc_threshold_value").text(settings.threshold);
    $("#amc_keep_head").val(settings.keepHead);
    $("#amc_keep_head_value").text(settings.keepHead);
    $("#amc_keep_recent").val(settings.keepRecent);
    $("#amc_keep_recent_value").text(settings.keepRecent);
    $("#amc_summary_style").val(settings.summaryStyle);
    $("#amc_include_previous").prop("checked", settings.includePrevious);
    $("#amc_custom_prompt").val(settings.customPrompt);
}

// --------------- UI 事件绑定 ---------------

/** 绑定设置面板的所有 UI 控件事件 */
function bindUiEvents() {
    // 启用/禁用自动压缩
    $("#amc_enabled").on("change", function () {
        settings.enabled = this.checked;
        saveSettings();
        refreshUi();
    });

    // 启用/禁用生成时替换上下文
    $("#amc_compact_enabled").on("change", function () {
        settings.compactEnabled = this.checked;
        saveSettings();
        refreshUi();
    });

    // 每次归档的消息阈值
    $("#amc_threshold").on("input", function () {
        settings.threshold = Number(this.value) || DEFAULT_SETTINGS.threshold;
        $("#amc_threshold_value").text(settings.threshold);
        saveSettings();
    });

    // 保留最开始的原始楼层数
    $("#amc_keep_head").on("input", function () {
        settings.keepHead = Number(this.value) || 0;
        $("#amc_keep_head_value").text(settings.keepHead);
        saveSettings();
        refreshUi();
    });

    // 保留最近的原始楼层数
    $("#amc_keep_recent").on("input", function () {
        settings.keepRecent = Number(this.value) || DEFAULT_SETTINGS.keepRecent;
        $("#amc_keep_recent_value").text(settings.keepRecent);
        saveSettings();
        refreshUi();
    });

    // 总结风格选择
    $("#amc_summary_style").on("change", function () {
        settings.summaryStyle = this.value;
        saveSettings();
    });

    // 是否包含上一条胶囊作为上下文
    $("#amc_include_previous").on("change", function () {
        settings.includePrevious = this.checked;
        saveSettings();
    });

    // 自定义总结提示词
    $("#amc_custom_prompt").on("input", function () {
        settings.customPrompt = this.value;
        saveSettings();
    });

    // 立即生成按钮
    $("#amc_btn_run").on("click", async () => {
        await createCapsuleFromChat(getContext().chat || [], true);
    });

    // 查看胶囊历史按钮
    $("#amc_btn_history").on("click", () => {
        showHistoryModal();
    });

    // 重置当前聊天状态按钮
    $("#amc_btn_reset").on("click", async () => {
        if (!confirm("确定重置当前聊天的记忆胶囊状态吗？这不会删除原始聊天消息。")) {
            return;
        }
        const state = getChatState();
        state.records = [];
        state.summarizedUntil = 0;
        await saveChatMetadata();
        refreshUi();
        setStatus("当前聊天状态已重置", "info");
    });
}

// --------------- 胶囊历史弹窗 ---------------

/**
 * 渲染单条胶囊记录的 HTML
 * 包含元信息、摘要内容和操作按钮
 */
function renderRecord(record, index) {
    const time = new Date(record.createdAt).toLocaleString("zh-CN");
    return `
        <div class="amc-record" data-record-id="${record.id}">
            <div class="amc-record-meta">
                <span>#${index + 1} · ${time}</span>
                <span>覆盖 #${record.seqStart} - #${record.seqEnd} · ${record.messageCount} 条</span>
            </div>
            <div class="amc-record-summary">${escapeHtml(record.summary)}</div>
            <div class="amc-record-actions">
                <button class="menu_button amc-btn-edit" data-record-id="${record.id}">编辑</button>
                <button class="menu_button amc-btn-reroll" data-record-id="${record.id}">重roll</button>
                <button class="menu_button amc-btn-rollback" data-record-id="${record.id}">回滚</button>
            </div>
        </div>
    `;
}

/**
 * 显示胶囊历史弹窗
 * 支持查看、编辑、重roll、回滚和导出功能
 */
function showHistoryModal() {
    $(".amc-modal-overlay").remove();
    const records = getChatState().records;

    const body = records.length
        ? records.map((record, index) => renderRecord(record, index)).reverse().join("")
        : `<div class="amc-empty">当前聊天还没有生成任何记忆胶囊。</div>`;

    const modal = $(`
        <div class="amc-modal-overlay">
            <div class="amc-modal">
                <div class="amc-modal-header">
                    <div class="amc-modal-title">记忆胶囊历史</div>
                    <button class="amc-modal-close" id="amc_modal_close">&times;</button>
                </div>
                <div class="amc-modal-body">${body}</div>
                <div class="amc-modal-footer">
                    <button class="menu_button" id="amc_modal_export">导出胶囊</button>
                </div>
            </div>
        </div>
    `);

    $("body").append(modal);

    // 关闭按钮
    $("#amc_modal_close").on("click", () => modal.remove());
    // 点击遮罩层关闭
    modal.on("click", function (event) {
        if (event.target === this) {
            modal.remove();
        }
    });

    // 编辑按钮：将摘要替换为 textarea
    modal.on("click", ".amc-btn-edit", function () {
        const recordId = $(this).data("record-id");
        const $record = $(this).closest(".amc-record");
        const $summary = $record.find(".amc-record-summary");
        const $actions = $record.find(".amc-record-actions");

        const state = getChatState();
        const record = state.records.find(r => r.id === recordId);
        if (!record) return;

        $summary.replaceWith(`<textarea class="amc-record-editor" rows="6">${escapeHtml(record.summary)}</textarea>`);
        $actions.html(`
            <button class="menu_button amc-btn-save" data-record-id="${recordId}">保存</button>
            <button class="menu_button amc-btn-cancel" data-record-id="${recordId}">取消</button>
        `);
    });

    // 取消编辑：恢复原始显示
    modal.on("click", ".amc-btn-cancel", function () {
        const recordId = $(this).data("record-id");
        const $record = $(this).closest(".amc-record");
        const state = getChatState();
        const record = state.records.find(r => r.id === recordId);
        if (!record) return;

        $record.find(".amc-record-editor").replaceWith(`<div class="amc-record-summary">${escapeHtml(record.summary)}</div>`);
        $record.find(".amc-record-actions").html(`
            <button class="menu_button amc-btn-edit" data-record-id="${recordId}">编辑</button>
            <button class="menu_button amc-btn-reroll" data-record-id="${recordId}">重roll</button>
            <button class="menu_button amc-btn-rollback" data-record-id="${recordId}">回滚</button>
        `);
    });

    // 保存编辑：更新胶囊摘要并持久化
    modal.on("click", ".amc-btn-save", async function () {
        const recordId = $(this).data("record-id");
        const $record = $(this).closest(".amc-record");
        const newSummary = $record.find(".amc-record-editor").val().trim();

        if (!newSummary) {
            alert("胶囊内容不能为空。");
            return;
        }

        const state = getChatState();
        const record = state.records.find(r => r.id === recordId);
        if (!record) return;

        record.summary = newSummary;
        await saveChatMetadata();

        $record.find(".amc-record-editor").replaceWith(`<div class="amc-record-summary">${escapeHtml(record.summary)}</div>`);
        $record.find(".amc-record-actions").html(`
            <button class="menu_button amc-btn-edit" data-record-id="${recordId}">编辑</button>
            <button class="menu_button amc-btn-reroll" data-record-id="${recordId}">重roll</button>
            <button class="menu_button amc-btn-rollback" data-record-id="${recordId}">回滚</button>
        `);
    });

    // 回滚按钮：删除胶囊，恢复原始消息到待压缩状态
    modal.on("click", ".amc-btn-rollback", async function () {
        const recordId = $(this).data("record-id");
        const $record = $(this).closest(".amc-record");

        if (!confirm("确定回滚这条记忆胶囊吗？胶囊将被删除，原始消息将恢复到待压缩状态。")) {
            return;
        }

        if (!rollbackCapsule(recordId)) return;
        await saveChatMetadata();
        refreshUi();
        $record.remove();

        if (!getChatState().records.length) {
            modal.find(".amc-modal-body").html(`<div class="amc-empty">当前聊天还没有生成任何记忆胶囊。</div>`);
        }
    });

    // 重roll按钮：删除旧胶囊并重新调用 LLM 生成新总结
    modal.on("click", ".amc-btn-reroll", async function () {
        const recordId = $(this).data("record-id");
        const $record = $(this).closest(".amc-record");

        if (!confirm("确定重新roll这条记忆胶囊吗？将删除当前胶囊并重新生成。")) {
            return;
        }

        $record.find(".amc-record-actions").html(`<span class="amc-reroll-status">正在重新生成...</span>`);
        await rerollCapsule(recordId);
        modal.remove();
        showHistoryModal();
    });

    // 导出按钮：将所有胶囊导出为 Markdown 文件
    $("#amc_modal_export").on("click", () => {
        const recordsToExport = getChatState().records;
        if (!recordsToExport.length) return;
        let markdown = "# Auto Memory Capsule Export\n\n";
        for (const record of recordsToExport) {
            markdown += `## #${record.seqStart}-${record.seqEnd}\n\n${record.summary}\n\n---\n\n`;
        }
        const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `memory_capsules_${Date.now()}.md`;
        link.click();
    });
}

// --------------- 防抖刷新 ---------------

/** 防抖刷新 UI，避免频繁更新 */
function scheduleRefresh() {
    if (scheduledRefresh) {
        clearTimeout(scheduledRefresh);
    }
    scheduledRefresh = setTimeout(() => {
        refreshUi();
    }, 150);
}

// --------------- 上下文替换（拦截器核心） ---------------

/**
 * 在生成时用胶囊消息替换 chat 数组中的旧消息
 * 这是 generate_interceptor 的核心逻辑
 * 直接 splice 修改传入的 chat 数组
 * @param {Array} chat - SillyTavern 传入的聊天数组引用
 */
/**
 * 遍历 chat 消息列表，用胶囊（capsule）虚拟消息替换已被摘要覆盖的消息
 *
 * 工作原理：
 * 1. 从 ChatState 中获取所有摘要记录（records），按起始序号升序排列
 * 2. 遍历 chat 中的每一条可压缩消息（user/assistant 等角色）
 * 3. 为每个可压缩消息分配一个逻辑序号（跳过 system 等不可压缩消息）
 * 4. 当逻辑序号到达某条记录的起始位置（seqStart）时，在消息列表中插入一个胶囊虚拟消息
 * 5. 该胶囊虚拟消息代表从 seqStart 到 seqEnd 区间内所有消息的汇总
 * 6. 跳过被胶囊覆盖的原始消息（seqStart ~ seqEnd 区间），仅保留胶囊消息
 * 7. 未被任何摘要覆盖的消息保持原样保留
 * 8. 最终将所有处理后的消息（保留的原始消息 + 胶囊虚拟消息）写回 chat 数组
 *
 * @param {Array} chat - SillyTavern 的 chat 消息数组，函数会直接修改它
 */
function buildPromptWithCapsules(chat) {
    // 未启用紧凑模式则直接退出，不修改 chat
    if (!settings.compactEnabled) return;

    const state = getChatState();
    // 没有摘要记录时无需处理
    if (!state.records.length) return;

    // 按消息起始序号升序排列，确保按时间顺序处理摘要区间
    const records = [...state.records].sort((a, b) => a.seqStart - b.seqStart);

    /** 最终输出的消息数组，包含保留的原始消息和胶囊虚拟消息 */
    const transformed = [];

    /**
     * logicalIndex - 可压缩消息的逻辑序号（从 1 开始）
     * 只对 isCompressibleMessage 返回 true 的消息递增
     * 例如 system 消息不递增，因为 system 消息不参与压缩
     */
    let logicalIndex = 0;

    /**
     * recordIndex - 当前正在处理的摘要记录在 records 数组中的下标
     * 当处理完一条记录覆盖的消息区间后（到达 seqEnd），切换到下一条记录
     */
    let recordIndex = 0;

    for (const message of chat) {
        // 不可压缩消息（如 system 角色）直接保留，不参与序号计算
        if (!isCompressibleMessage(message)) {
            transformed.push(message);
            continue;
        }

        logicalIndex += 1;
        const currentRecord = records[recordIndex];

        // 当逻辑序号到达当前摘要记录的起始位置时，在输出中插入胶囊虚拟消息
        // 胶囊消息会携带该区间的摘要文本和索引范围，供 LLM 理解上下文
        if (currentRecord && logicalIndex === currentRecord.seqStart) {
            transformed.push(makePromptCapsuleMessage(currentRecord));
        }

        // 如果当前消息落在当前摘要记录的覆盖区间内（seqStart ~ seqEnd），则跳过它
        // 因为这段区间的内容已经被上面的胶囊虚拟消息所代表
        if (currentRecord && logicalIndex >= currentRecord.seqStart && logicalIndex <= currentRecord.seqEnd) {
            // 到达该记录的结束位置，切换到下一条摘要记录
            if (logicalIndex === currentRecord.seqEnd) {
                recordIndex += 1;
            }
            continue;
        }

        // 不在任何摘要区间内的消息，正常保留
        transformed.push(message);
    }

    log("原始 chat 消息数:", chat.length);
    log("处理后的消息数（包含胶囊虚拟消息）:", transformed.length);
    log("当前摘要记录数:", records.length);
    log("当前摘要记录详情:", records);
    log("最终构建的消息列表:", transformed);

    // 原地替换 chat 数组内容，SilLyTavern 后续会使用这个修改后的数组构建 prompt
    chat.splice(0, chat.length, ...transformed);
}

// --------------- 拦截器入口 ---------------

/**
 * SillyTavern 的 generate_interceptor
 * 在每次生成时触发，负责替换上下文中的旧消息为胶囊
 * 注意：胶囊生成（LLM 调用）已移到 onGenerationEnded 中
 */
globalThis[INTERCEPTOR_NAME] = async function autoMemoryCapsuleInterceptor(chat, contextSize, abort, type) {
    try {
        settings = getSettings();

        if (!settings.enabled) return;
        if (summaryGenerationDepth > 0) return;
        if (type === "quiet") return;

        buildPromptWithCapsules(chat);
    } catch (error) {
        warn("Interceptor failed:", error);
    }
};

// --------------- 生成完成后回调 ---------------

/**
 * 在回复完成后检查是否需要生成新胶囊
 * 通过 GENERATION_ENDED 事件触发
 * 避免在生成过程中调用 LLM 导致递归
 */
async function onGenerationEnded() {
    try {
        settings = getSettings();
        if (!settings.enabled) return;
        if (summaryGenerationDepth > 0) return;

        await createCapsuleFromChat(getContext().chat || [], false);
    } catch (error) {
        warn("Post-generation capsule check failed:", error);
    }
}

// --------------- UI 挂载 ---------------

/** 挂载设置面板到 SillyTavern 界面 */
async function mountUi() {
    if ($("#amc_root").length) return;
    const ctx = getContext();
    const html = await ctx.renderExtensionTemplateAsync(getExtensionFolder(), TEMPLATE_NAME, {
        title: "Auto Memory Capsule",
    });
    $("#extensions_settings2").append(`<div id="amc_root">${html}</div>`);
    bindUiEvents();
    refreshUi();
}

// --------------- 事件绑定 ---------------

/**
 * 绑定 SillyTavern 事件监听
 * 监听聊天变化、消息编辑/删除等事件来刷新 UI
 * 监听 GENERATION_ENDED 事件来触发胶囊生成
 */
function bindEvents() {
    const ctx = getContext();
    const { eventSource, event_types } = ctx;
    if (!eventSource || !event_types) return;

    // 刷新 UI 的事件
    for (const type of [
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPED,
    ]) {
        if (!type) continue;
        eventSource.on(type, () => {
            scheduleRefresh();
        });
    }

    // 生成完成后：刷新 UI + 检查是否需要生成胶囊
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            scheduleRefresh();
            onGenerationEnded();
        });
    }
}

// --------------- 初始化 ---------------

/** 扩展初始化：加载设置、挂载 UI、绑定事件 */
async function bootstrap() {
    if (initialized) return;
    settings = getSettings();
    await mountUi();
    bindEvents();
    refreshUi();
    initialized = true;
    log("Initialized");
}

/**
 * 注册生命周期钩子
 * 优先监听 APP_READY 事件，降级使用 setTimeout
 */
function registerLifecycle() {
    try {
        const ctx = getContext();
        if (ctx.eventSource && ctx.event_types?.APP_READY) {
            ctx.eventSource.on(ctx.event_types.APP_READY, async () => {
                await bootstrap();
            });
            return;
        }
    } catch (e) {}

    setTimeout(() => {
        bootstrap().catch(error => {
            warn("Bootstrap failed:", error);
        });
    }, 0);
}

// 启动扩展
registerLifecycle();
