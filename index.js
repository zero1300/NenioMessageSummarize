import { generateQuietPrompt } from "../../../../script.js";

const MODULE_NAME = "auto_memory_capsule";
const LOG_PREFIX = "[AutoMemoryCapsule]";
const TEMPLATE_NAME = "settings";

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    compactEnabled: true,
    threshold: 12,
    keepRecent: 6,
    summaryStyle: "balanced",
    includePrevious: true,
    customPrompt: "",
});

const STYLE_PROMPTS = Object.freeze({
    brief: "请把以下对话压缩成一条非常简洁但信息完整的长期记忆。重点保留关键事件、人物关系、未完成目标和重要承诺。只输出总结正文。",
    balanced: "请把以下对话压缩成一条适合长期记忆的总结。保留：关键事件、人物关系变化、正在推进的目标、情绪变化、线索和承诺。避免无关措辞。只输出总结正文。",
    detailed: "请详细总结以下对话，并保留可供后续续写使用的长期记忆信息，包括：1. 关键事件；2. 人物关系与立场变化；3. 当前目标与障碍；4. 伏笔、秘密、承诺；5. 当前场景状态。只输出总结正文。",
});

const MARKER_PREFIX = "【记忆胶囊】";

let settings = null;
let initialized = false;
let processing = false;
let scheduledRefresh = null;

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
        const idx = path.indexOf(marker);
        if (idx >= 0) {
            return path.slice(idx + marker.length).replace(/\/index\.js$/, "").replace(/^\/+/, "");
        }
    } catch (e) {}
    return "third-party/NenioMessageSummarize";
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
            version: 2,
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

async function persistChatMutation() {
    const ctx = getContext();
    for (const name of ["saveChat", "saveCurrentChat", "saveChatConditional", "saveCurrentChatConditional"]) {
        if (typeof ctx[name] === "function") {
            try {
                await ctx[name]();
                return;
            } catch (e) {
                warn(`Failed ${name}:`, e);
            }
        }
    }
}

function isCapsuleMessage(message) {
    return !!message?.extra?.[MODULE_NAME]?.isCapsule;
}

function getCapsuleMeta(message) {
    return message?.extra?.[MODULE_NAME] || null;
}

function getLogicalMessageMap() {
    const chat = getContext().chat || [];
    const map = [];
    let logicalIndex = 0;

    for (let actualIndex = 0; actualIndex < chat.length; actualIndex++) {
        const message = chat[actualIndex];
        if (!message) continue;

        if (isCapsuleMessage(message)) {
            logicalIndex += Number(getCapsuleMeta(message)?.coveredCount || 0);
            continue;
        }

        if (message.is_system) continue;

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

function getPendingRawMessages() {
    const state = getChatState();
    const { map, totalLogicalCount } = getLogicalMessageMap();
    const pending = map.filter(item => item.logicalIndex > state.summarizedUntil);
    return {
        pending,
        totalLogicalCount,
        summarizedUntil: state.summarizedUntil,
    };
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

function buildSummaryPrompt(recordInput, previousSummary, style) {
    const basePrompt = style === "custom" && settings.customPrompt.trim()
        ? settings.customPrompt.trim()
        : STYLE_PROMPTS[style] || STYLE_PROMPTS.balanced;

    let transcript = "";
    for (const item of recordInput) {
        const sender = item.message.is_user ? getPersonaNames().user : (item.message.name || getPersonaNames().character);
        transcript += `#${item.logicalIndex} ${sender}: ${item.message.mes || ""}\n\n`;
    }

    if (settings.includePrevious && previousSummary) {
        transcript = `[上一条长期记忆]\n${previousSummary}\n\n[本次要压缩的新对话]\n${transcript}`;
    }

    return `${basePrompt}\n\n角色：${getCharacterName()}\n请压缩的消息范围：#${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex}\n\n${transcript}`;
}

async function generateSummary(prompt) {
    const result = await generateQuietPrompt({ quietPrompt: prompt });
    return String(result || "").trim();
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
        compacted: settings.compactEnabled,
        style: settings.summaryStyle,
    };
}

function makeCapsuleMessage(record) {
    return {
        name: "Memory Capsule",
        is_user: false,
        is_system: true,
        send_date: Date.now(),
        mes: `${MARKER_PREFIX} #${record.seqEnd}\n覆盖楼层 #${record.seqStart} - #${record.seqEnd}（${record.messageCount} 条）\n${record.summary}`,
        extra: {
            [MODULE_NAME]: {
                isCapsule: true,
                recordId: record.id,
                coveredCount: record.messageCount,
                seqStart: record.seqStart,
                seqEnd: record.seqEnd,
            },
        },
    };
}

async function compactChatRange(record, recordInput) {
    if (!settings.compactEnabled) return;
    const chat = getContext().chat || [];
    const firstActual = recordInput[0].actualIndex;
    const deleteCount = recordInput.length;
    chat.splice(firstActual, deleteCount, makeCapsuleMessage(record));
    await persistChatMutation();
}

async function createCapsuleFromPending(force = false) {
    if (processing) return false;
    if (!settings.enabled) return false;

    const { pending } = getPendingRawMessages();
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
    setStatus(`正在压缩楼层 #${recordInput[0].logicalIndex} - #${recordInput[recordInput.length - 1].logicalIndex} ...`, "info");

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

        await compactChatRange(record, recordInput);
        await saveChatMetadata();
        refreshUi();
        setStatus(`已生成记忆胶囊，覆盖 #${record.seqStart} - #${record.seqEnd}`, "success");
        return true;
    } catch (error) {
        warn("Capsule generation failed:", error);
        setStatus(`压缩失败：${error.message || error}`, "error");
        return false;
    } finally {
        processing = false;
    }
}

function getStats() {
    const state = getChatState();
    const { totalLogicalCount } = getLogicalMessageMap();
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

    $("#amc_keep_recent").on("input", function () {
        settings.keepRecent = Number(this.value) || DEFAULT_SETTINGS.keepRecent;
        $("#amc_keep_recent_value").text(settings.keepRecent);
        saveSettings();
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
        await createCapsuleFromPending(true);
    });

    $("#amc_btn_history").on("click", () => {
        showHistoryModal();
    });

    $("#amc_btn_reset").on("click", async () => {
        if (!confirm("确定重置当前聊天的记忆压缩状态吗？这不会恢复已经被压缩掉的原始消息。")) {
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
        <div class="amc-record">
            <div class="amc-record-meta">
                <span>#${index + 1} · ${time}</span>
                <span>覆盖 #${record.seqStart} - #${record.seqEnd} · ${record.messageCount} 条</span>
            </div>
            <div class="amc-record-summary">${escapeHtml(record.summary)}</div>
        </div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
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

    $("#amc_modal_export").on("click", () => {
        const state = getChatState();
        if (!state.records.length) return;
        let markdown = `# Auto Memory Capsule Export\n\n`;
        for (const record of state.records) {
            markdown += `## #${record.seqStart}-${record.seqEnd}\n\n${record.summary}\n\n---\n\n`;
        }
        const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `memory_capsules_${Date.now()}.md`;
        link.click();
    });
}

function scheduleRefreshAndMaybeSummarize() {
    if (scheduledRefresh) {
        clearTimeout(scheduledRefresh);
    }

    scheduledRefresh = setTimeout(async () => {
        refreshUi();
        await createCapsuleFromPending(false);
    }, 250);
}

async function mountUi() {
    if ($("#amc_root").length) return;

    const ctx = getContext();
    const html = await ctx.renderExtensionTemplateAsync(getExtensionFolder(), TEMPLATE_NAME, {
        title: "Auto Memory Capsule",
    });
    const wrapped = `<div id="amc_root">${html}</div>`;
    $("#extensions_settings2").append(wrapped);
    bindUiEvents();
    refreshUi();
}

function bindEvents() {
    const ctx = getContext();
    const { eventSource, event_types } = ctx;
    if (!eventSource || !event_types) {
        warn("Event system unavailable, using passive UI only");
        return;
    }

    eventSource.on(event_types.CHAT_CHANGED, () => {
        refreshUi();
    });

    for (const type of [
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
    ]) {
        if (!type) continue;
        eventSource.on(type, () => {
            scheduleRefreshAndMaybeSummarize();
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
