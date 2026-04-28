const MODULE_NAME = "auto_memory_capsule";
const INTERCEPTOR_NAME = "autoMemoryCapsuleInterceptor";
const TEMPLATE_NAME = "settings";
const LOG_PREFIX = "[AutoMemoryCapsule]";
const MARKER_PREFIX = "【记忆胶囊】";

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

const STYLE_PROMPTS = Object.freeze({
    brief: "请把以下对话压缩成一条非常简洁但信息完整的长期记忆。重点保留关键事件、人物关系、未完成目标和重要承诺。只输出总结正文。",
    balanced: "请把以下对话压缩成一条适合长期记忆的总结。保留关键事件、人物关系变化、正在推进的目标、情绪变化、线索和承诺。只输出总结正文。",
    detailed: "请详细总结以下对话，并保留可供后续续写使用的长期记忆信息，包括关键事件、人物关系变化、当前目标与障碍、伏笔秘密和承诺、当前场景状态。只输出总结正文。",
});

let settings = null;
let initialized = false;
let processing = false;
let scheduledRefresh = null;
let summaryGenerationDepth = 0;

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

function getContext() {
    if (typeof SillyTavern === "undefined" || typeof SillyTavern.getContext !== "function") {
        throw new Error("SillyTavern context unavailable");
    }
    return SillyTavern.getContext();
}

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

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

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

function saveSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === "function") {
        ctx.saveSettingsDebounced();
    } else if (typeof window.saveSettingsDebounced === "function") {
        window.saveSettingsDebounced();
    }
}

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

async function saveChatMetadata() {
    const ctx = getContext();
    if (typeof ctx.saveMetadata === "function") {
        await ctx.saveMetadata();
    } else if (typeof window.saveMetadata === "function") {
        await window.saveMetadata();
    }
}

function isCompressibleMessage(message) {
    if (!message) return false;
    if (message.is_system) return false;
    if (message.extra?.[MODULE_NAME]?.isPromptCapsule) return false;
    return true;
}

function getPersonaNames() {
    const ctx = getContext();
    return {
        user: ctx.name1 || window.name1 || "User",
        character: ctx.name2 || window.name2 || "Character",
    };
}

function getCharacterName() {
    const ctx = getContext();
    const characterId = ctx.characterId;
    if (characterId !== undefined && characterId !== null && ctx.characters?.[characterId]) {
        return ctx.characters[characterId].name || getPersonaNames().character;
    }
    return getPersonaNames().character;
}

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

function getPendingRawMessages(chat) {
    const state = getChatState();
    const { map, totalLogicalCount } = buildLogicalMap(chat);
    const keepHead = Number(settings.keepHead || 0);
    const pending = map.filter(item => item.logicalIndex > state.summarizedUntil && item.logicalIndex > keepHead);
    return {
        map,
        pending,
        totalLogicalCount,
        summarizedUntil: state.summarizedUntil,
    };
}

function buildSummaryPrompt(recordInput, previousSummary, style) {
    const basePrompt = style === "custom" && settings.customPrompt.trim()
        ? settings.customPrompt.trim()
        : STYLE_PROMPTS[style] || STYLE_PROMPTS.balanced;

    const names = getPersonaNames();
    let transcript = "";
    for (const item of recordInput) {
        const sender = item.message.is_user ? names.user : (item.message.name || names.character);
        transcript += `#${item.logicalIndex} ${sender}: ${item.message.mes || ""}\n\n`;
    }

    if (settings.includePrevious && previousSummary) {
        transcript = `[上一条长期记忆]\n${previousSummary}\n\n[本次要压缩的新对话]\n${transcript}`;
    }

    return `${basePrompt}\n\n角色：${getCharacterName()}\n请压缩的消息范围：#${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex}\n\n${transcript}`;
}

async function generateSummary(prompt) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== "function") {
        throw new Error("generateQuietPrompt unavailable");
    }

    summaryGenerationDepth += 1;
    try {
        const result = await ctx.generateQuietPrompt({ quietPrompt: prompt, skipWIScan: true });
        console.log(LOG_PREFIX, "chat ctx: ", result);
        return String(result || "").trim();
    } finally {
        summaryGenerationDepth = Math.max(0, summaryGenerationDepth - 1);
    }
}

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

async function createCapsuleFromChat(chat, force = false) {
    if (processing || !settings.enabled) return false;

    const { pending } = getPendingRawMessages(chat);
    const threshold = Number(settings.threshold);
    const keepRecent = Number(settings.keepRecent);
    const eligibleCount = pending.length - keepRecent;

    if (!force && eligibleCount < threshold) {
        return false;
    }

    let targetCount = force ? Math.max(0, eligibleCount) : threshold;
    if (force && pending.length > 0 && eligibleCount <= 0 && pending.length >= threshold) {
        targetCount = pending.length;
    }

    if (targetCount <= 0) return false;

    const recordInput = pending.slice(0, targetCount);
    if (!recordInput.length) return false;

    processing = true;
    setStatus(`正在生成 #${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex} 的记忆胶囊...`, "info");

    try {
        const state = getChatState();
        const previousSummary = state.records.length ? state.records[state.records.length - 1].summary : "";
        const prompt = buildSummaryPrompt(recordInput, previousSummary, settings.summaryStyle);
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

function setStatus(text, type = "") {
    const el = document.getElementById("amc_status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "amc-status" + (type ? ` ${type}` : "");
}

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

function bindUiEvents() {
    $("#amc_enabled").on("change", function () {
        settings.enabled = this.checked;
        saveSettings();
        refreshUi();
    });

    $("#amc_compact_enabled").on("change", function () {
        settings.compactEnabled = this.checked;
        saveSettings();
        refreshUi();
    });

    $("#amc_threshold").on("input", function () {
        settings.threshold = Number(this.value) || DEFAULT_SETTINGS.threshold;
        $("#amc_threshold_value").text(settings.threshold);
        saveSettings();
    });

    $("#amc_keep_head").on("input", function () {
        settings.keepHead = Number(this.value) || 0;
        $("#amc_keep_head_value").text(settings.keepHead);
        saveSettings();
        refreshUi();
    });

    $("#amc_keep_recent").on("input", function () {
        settings.keepRecent = Number(this.value) || DEFAULT_SETTINGS.keepRecent;
        $("#amc_keep_recent_value").text(settings.keepRecent);
        saveSettings();
        refreshUi();
    });

    $("#amc_summary_style").on("change", function () {
        settings.summaryStyle = this.value;
        saveSettings();
    });

    $("#amc_include_previous").on("change", function () {
        settings.includePrevious = this.checked;
        saveSettings();
    });

    $("#amc_custom_prompt").on("input", function () {
        settings.customPrompt = this.value;
        saveSettings();
    });

    $("#amc_btn_run").on("click", async () => {
        await createCapsuleFromChat(getContext().chat || [], true);
    });

    $("#amc_btn_history").on("click", () => {
        showHistoryModal();
    });

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

    $("#amc_modal_close").on("click", () => modal.remove());
    modal.on("click", function (event) {
        if (event.target === this) {
            modal.remove();
        }
    });

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

function scheduleRefresh() {
    if (scheduledRefresh) {
        clearTimeout(scheduledRefresh);
    }
    scheduledRefresh = setTimeout(() => {
        refreshUi();
    }, 150);
}

function buildPromptWithCapsules(chat) {
    if (!settings.compactEnabled) return;

    const state = getChatState();
    if (!state.records.length) return;

    const records = [...state.records].sort((a, b) => a.seqStart - b.seqStart);
    const transformed = [];
    let logicalIndex = 0;
    let recordIndex = 0;

    for (const message of chat) {
        if (!isCompressibleMessage(message)) {
            transformed.push(message);
            continue;
        }

        logicalIndex += 1;
        const currentRecord = records[recordIndex];

        if (currentRecord && logicalIndex === currentRecord.seqStart) {
            transformed.push(makePromptCapsuleMessage(currentRecord));
        }

        if (currentRecord && logicalIndex >= currentRecord.seqStart && logicalIndex <= currentRecord.seqEnd) {
            if (logicalIndex === currentRecord.seqEnd) {
                recordIndex += 1;
            }
            continue;
        }

        transformed.push(message);
    }

    chat.splice(0, chat.length, ...transformed);
}

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

function bindEvents() {
    const ctx = getContext();
    const { eventSource, event_types } = ctx;
    if (!eventSource || !event_types) return;

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

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            scheduleRefresh();
            onGenerationEnded();
        });
    }
}

async function bootstrap() {
    if (initialized) return;
    settings = getSettings();
    await mountUi();
    bindEvents();
    refreshUi();
    initialized = true;
    log("Initialized");
}

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

registerLifecycle();
