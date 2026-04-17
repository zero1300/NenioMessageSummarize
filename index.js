/**
 * Auto Summary Extension for SillyTavern
 *
 * 自动在每 N 轮对话后调用 AI 生成对话总结，
 * 并将总结存储在聊天元数据中，方便后续回顾。
 */
(function () {
    'use strict';

    // ========== 常量 ==========
    const EXT_NAME = 'auto-summary';
    const LOG_PREFIX = '[AutoSummary]';

    // 内置总结风格的提示词
    const STYLE_PROMPTS = {
        brief: '请用 1-2 句话简明扼要地总结以下对话的核心内容。只输出总结，不要多余的话。',
        normal: '请用一个简短的段落总结以下对话。包括：主要事件、角色行动、情感变化和当前情境。只输出总结。',
        detailed: '请详细总结以下对话。包括：\n1. 主要情节发展\n2. 角色的行动与决定\n3. 角色间的关系变化\n4. 当前场景与氛围\n5. 重要的未解事项\n只输出总结。'
    };

    // ========== 全局状态 ==========
    let config = {};
    let messageCounter = 0;      // 用户+助手消息计数
    let isProcessing = false;    // 防止并发
    let eventBound = false;

    // ========== 工具函数 ==========

    /** 获取 SillyTavern 上下文 */
    function getContext() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
        // 兼容旧版
        return {
            extensionSettings: window.extension_settings || {},
            chat: window.chat || [],
            characters: window.characters || [],
            this_chid: window.this_chid,
            eventSource: window.eventSource,
            name1: window.name1 || 'User',
            name2: window.name2 || 'Character',
            saveSettingsDebounced: window.saveSettingsDebounced || function () { }
        };
    }

    /** 日志 */
    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function logWarn(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    /** 显示状态信息 */
    function setStatus(text, type) {
        const el = document.getElementById('as_status');
        if (el) {
            el.textContent = text;
            el.className = 'as-status' + (type ? ' ' + type : '');
        }
        if (text) {
            log(text);
        }
    }

    /** 更新计数器显示 */
    function updateCounterDisplay() {
        const el = document.getElementById('as_counter');
        if (el) {
            el.textContent = `已计数: ${messageCounter} / ${config.frequency} 轮`;
        }
    }

    /** 延迟 */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ========== 配置管理 ==========

    function getDefaultConfig() {
        return {
            enabled: true,
            frequency: 10,
            style: 'normal',
            customPrompt: '',
            maxTokens: 300,
            contextMessages: 30,
            includePreviousSummary: true
        };
    }

    function loadConfig() {
        const ctx = getContext();
        if (!ctx.extensionSettings[EXT_NAME]) {
            ctx.extensionSettings[EXT_NAME] = {};
        }
        config = Object.assign(getDefaultConfig(), ctx.extensionSettings[EXT_NAME]);
        log('配置已加载:', config);
    }

    function saveConfig() {
        const ctx = getContext();
        ctx.extensionSettings[EXT_NAME] = { ...config };
        if (ctx.saveSettingsDebounced) {
            ctx.saveSettingsDebounced();
        }
    }

    // ========== UI 构建 ==========

    function buildUI() {
        // 加载 HTML 模板
        const settingsHtml = `
        <div id="auto_summary_panel" class="auto-summary-panel">
            <h4>
                <span class="panel-toggle" id="as_panel_toggle">▼</span>
                📝 自动总结
            </h4>
            <div class="as-body" id="as_body">
                <div class="as-toggle-row">
                    <label for="as_enabled">启用自动总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_enabled" ${config.enabled ? 'checked' : ''}>
                        <span class="slider"></span>
                    </div>
                </div>
                <hr class="as-divider">
                <div class="as-control">
                    <label for="as_frequency">触发频率（每 N 轮对话后总结）</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_frequency" min="1" max="50" value="${config.frequency}" step="1">
                        <span class="as-slider-val" id="as_frequency_val">${config.frequency}</span>
                    </div>
                </div>
                <div class="as-control">
                    <label for="as_style">总结风格</label>
                    <select id="as_style">
                        <option value="brief" ${config.style === 'brief' ? 'selected' : ''}>简短 — 一句话概括</option>
                        <option value="normal" ${config.style === 'normal' ? 'selected' : ''}>标准 — 段落式总结</option>
                        <option value="detailed" ${config.style === 'detailed' ? 'selected' : ''}>详细 — 完整情节梳理</option>
                        <option value="custom" ${config.style === 'custom' ? 'selected' : ''}>自定义提示词</option>
                    </select>
                </div>
                <div class="as-control">
                    <label for="as_max_tokens">总结最大 Token 数</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_max_tokens" min="50" max="1000" value="${config.maxTokens}" step="50">
                        <span class="as-slider-val" id="as_max_tokens_val">${config.maxTokens}</span>
                    </div>
                </div>
                <div class="as-control">
                    <label for="as_context_messages">发送给 AI 的最近消息数</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_context_messages" min="5" max="100" value="${config.contextMessages}" step="5">
                        <span class="as-slider-val" id="as_context_messages_val">${config.contextMessages}</span>
                    </div>
                </div>
                <div class="as-toggle-row">
                    <label for="as_include_prev">在上下文中包含之前的总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_include_prev" ${config.includePreviousSummary ? 'checked' : ''}>
                        <span class="slider"></span>
                    </div>
                </div>
                <hr class="as-divider">
                <div class="as-control" id="as_custom_prompt_wrap" style="display:${config.style === 'custom' ? 'flex' : 'none'}">
                    <label for="as_custom_prompt">自定义系统提示词</label>
                    <textarea id="as_custom_prompt" rows="3" placeholder="例如：请用中文总结以下对话，重点记录角色的情感变化和关键事件。">${config.customPrompt || ''}</textarea>
                </div>
                <hr class="as-divider">
                <div class="as-buttons">
                    <button id="as_btn_summarize" title="立即总结当前对话">⚡ 立即总结</button>
                    <button id="as_btn_history" title="查看历史总结">📋 历史记录</button>
                    <button id="as_btn_reset" title="重置计数器">🔄 重置计数</button>
                </div>
                <div class="as-counter" id="as_counter">已计数: 0 / ${config.frequency} 轮</div>
                <div class="as-status" id="as_status"></div>
            </div>
        </div>`;

        // 注入到扩展设置区域
        const container = $('#extensions_settings');
        if (container.length && !$('#auto_summary_panel').length) {
            container.append(settingsHtml);
            log('UI 已注入');
        }

        bindUIEvents();
    }

    function bindUIEvents() {
        // 面板折叠
        $('#as_panel_toggle').on('click', function () {
            $(this).toggleClass('collapsed');
            $('#as_body').toggleClass('collapsed');
        });

        // 启用开关
        $('#as_enabled').on('change', function () {
            config.enabled = this.checked;
            saveConfig();
            setStatus(config.enabled ? '已启用' : '已禁用');
            updateCounterDisplay();
        });

        // 频率滑块
        $('#as_frequency').on('input', function () {
            config.frequency = parseInt(this.value) || 10;
            $('#as_frequency_val').text(config.frequency);
            saveConfig();
            updateCounterDisplay();
        });

        // 风格选择
        $('#as_style').on('change', function () {
            config.style = this.value;
            $('#as_custom_prompt_wrap').css('display', config.style === 'custom' ? 'flex' : 'none');
            saveConfig();
        });

        // 自定义提示词
        $('#as_custom_prompt').on('input', function () {
            config.customPrompt = this.value;
            saveConfig();
        });

        // 最大 Token
        $('#as_max_tokens').on('input', function () {
            config.maxTokens = parseInt(this.value) || 300;
            $('#as_max_tokens_val').text(config.maxTokens);
            saveConfig();
        });

        // 上下文消息数
        $('#as_context_messages').on('input', function () {
            config.contextMessages = parseInt(this.value) || 30;
            $('#as_context_messages_val').text(config.contextMessages);
            saveConfig();
        });

        // 包含之前的总结
        $('#as_include_prev').on('change', function () {
            config.includePreviousSummary = this.checked;
            saveConfig();
        });

        // 立即总结按钮
        $('#as_btn_summarize').on('click', async function () {
            if (isProcessing) {
                setStatus('正在处理中，请稍候...', 'error');
                return;
            }
            const btn = $(this);
            btn.prop('disabled', true);
            try {
                await generateSummary();
                messageCounter = 0;
                updateCounterDisplay();
            } catch (err) {
                logWarn('手动总结失败:', err);
                setStatus('总结失败: ' + (err.message || err), 'error');
            } finally {
                btn.prop('disabled', false);
            }
        });

        // 历史记录按钮
        $('#as_btn_history').on('click', function () {
            showHistoryModal();
        });

        // 重置计数按钮
        $('#as_btn_reset').on('click', function () {
            messageCounter = 0;
            updateCounterDisplay();
            setStatus('计数器已重置');
        });
    }

    // ========== 消息计数与事件监听 ==========

    /** 统计当前聊天中的用户+助手消息轮数 */
    function countExistingMessages() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        messageCounter = 0;
        for (const msg of chat) {
            if (msg.is_user || msg.is_system === false && !msg.is_user) {
                // 只计用户和角色消息（排除纯系统消息）
                if (!msg.is_system) {
                    messageCounter++;
                }
            }
        }
        // 按轮计算（每轮 = 用户消息 + 助手消息 = 2条）
        messageCounter = Math.floor(messageCounter / 2);
        updateCounterDisplay();
    }

    /** 检查是否应该触发总结 */
    function checkAndSummarize() {
        if (!config.enabled || isProcessing) return;
        if (messageCounter >= config.frequency) {
            log(`达到触发条件 (${messageCounter} >= ${config.frequency})，开始总结...`);
            messageCounter = 0;
            updateCounterDisplay();
            generateSummary().catch(err => {
                logWarn('自动总结失败:', err);
                setStatus('自动总结失败: ' + (err.message || err), 'error');
            });
        }
    }

    /** 绑定 SillyTavern 事件 */
    function bindEvents() {
        if (eventBound) return;

        const ctx = getContext();
        const es = ctx.eventSource;

        if (es && typeof es.on === 'function') {
            // 消息接收事件 — 新消息到达时增加计数
            if (typeof es.eventNames === 'function') {
                const names = es.eventNames();
                log('可用事件:', names);
            }

            // 尝试绑定消息事件
            const messageEvents = ['messageReceived', 'messageSent', 'MESSAGE_RECEIVED', 'MESSAGE_SENT'];
            for (const evtName of messageEvents) {
                try {
                    es.on(evtName, function () {
                        // 延迟一点确保 chat 数组已更新
                        setTimeout(() => {
                            messageCounter++;
                            updateCounterDisplay();
                            log(`消息事件 ${evtName}，当前计数: ${messageCounter}`);
                            checkAndSummarize();
                        }, 500);
                    });
                    log(`已绑定事件: ${evtName}`);
                } catch (e) {
                    // 事件不存在，忽略
                }
            }

            // 聊天切换事件
            const chatEvents = ['chatLoaded', 'CHAT_CHANGED', 'chatChanged'];
            for (const evtName of chatEvents) {
                try {
                    es.on(evtName, function () {
                        setTimeout(() => {
                            countExistingMessages();
                            log(`聊天切换事件 ${evtName}，重新计数`);
                        }, 1000);
                    });
                    log(`已绑定事件: ${evtName}`);
                } catch (e) {
                    // 事件不存在，忽略
                }
            }

            eventBound = true;
        } else {
            logWarn('eventSource 不可用，尝试 DOM 观察模式');
            startDOMObserver();
        }
    }

    /** 备用方案：通过 MutationObserver 监听新消息 */
    function startDOMObserver() {
        const chatContainer = document.getElementById('chat') || document.querySelector('.mes');
        if (!chatContainer) {
            logWarn('找不到聊天容器，DOM 观察不可用');
            return;
        }

        const targetNode = chatContainer.parentElement || chatContainer;
        const observer = new MutationObserver(function (mutations) {
            let hasNewMessage = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1 && node.classList && node.classList.contains('mes')) {
                            hasNewMessage = true;
                            break;
                        }
                    }
                }
                if (hasNewMessage) break;
            }
            if (hasNewMessage) {
                messageCounter++;
                updateCounterDisplay();
                checkAndSummarize();
            }
        });

        observer.observe(targetNode, { childList: true, subtree: true });
        log('DOM Observer 已启动');
    }

    // ========== 总结生成 ==========

    /** 获取总结系统提示词 */
    function getSystemPrompt() {
        if (config.style === 'custom' && config.customPrompt.trim()) {
            return config.customPrompt.trim();
        }
        return STYLE_PROMPTS[config.style] || STYLE_PROMPTS.normal;
    }

    /** 获取上一条总结 */
    function getLastSummary() {
        const ctx = getContext();
        const chatMeta = ctx.chat_metadata || {};
        const summaries = chatMeta.auto_summaries || [];
        return summaries.length > 0 ? summaries[summaries.length - 1] : null;
    }

    /** 保存总结到聊天元数据 */
    async function saveSummary(summaryText) {
        const ctx = getContext();

        if (!ctx.chat_metadata) {
            ctx.chat_metadata = {};
        }
        if (!ctx.chat_metadata.auto_summaries) {
            ctx.chat_metadata.auto_summaries = [];
        }

        ctx.chat_metadata.auto_summaries.push({
            text: summaryText,
            timestamp: Date.now(),
            messageRange: (ctx.chat || []).length,
            style: config.style
        });

        // 保存聊天元数据
        try {
            if (typeof ctx.saveMetadata === 'function') {
                await ctx.saveMetadata();
            } else if (typeof saveMetadata === 'function') {
                await saveMetadata();
            } else {
                // 回退：通过 API 保存
                await $.ajax({
                    url: '/api/chats/save',
                    type: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({
                        chat_metadata: ctx.chat_metadata,
                        file_name: ctx.chatMetadata?.file_name || ''
                    })
                });
            }
            log('总结已保存');
        } catch (e) {
            logWarn('保存元数据失败:', e);
        }
    }

    /**
     * 调用 LLM API 生成总结
     * 使用 SillyTavern 的后端代理，自动使用用户配置的 API
     */
    async function callLLM(systemPrompt, userContent) {
        // 方案 1：使用 SillyTavern 内置的 /api/summarize 端点
        // （如果用户开启了总结功能）
        try {
            const response = await $.ajax({
                url: '/api/summarize',
                type: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({
                    text: userContent,
                    params: {
                        custom_prompt: systemPrompt,
                        max_tokens: config.maxTokens
                    }
                }),
                timeout: 60000
            });

            if (response && typeof response === 'string' && response.trim()) {
                return response.trim();
            }
            if (response && response.summary) {
                return response.summary.trim();
            }
        } catch (e) {
            log('内置总结端点不可用，尝试直接 API 调用...');
        }

        // 方案 2：通过后端代理直接调用聊天完成 API
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];

        const requestBody = {
            messages: messages,
            max_tokens: config.maxTokens,
            temperature: 0.3
        };

        try {
            const response = await $.ajax({
                url: '/api/backends/chat-completions/generate',
                type: 'POST',
                contentType: 'application/json',
                data: JSON.stringify(requestBody),
                timeout: 60000
            });

            // 解析响应（不同 API 返回格式可能不同）
            if (typeof response === 'string') {
                return response.trim();
            }
            if (response.choices && response.choices[0]) {
                return response.choices[0].message.content.trim();
            }
            if (response.content) {
                return (typeof response.content === 'string'
                    ? response.content
                    : response.content[0]?.text || ''
                ).trim();
            }
            if (response.output) {
                return response.output.trim();
            }

            throw new Error('无法解析 API 响应');
        } catch (e) {
            logWarn('API 调用失败:', e);
            throw new Error('API 调用失败: ' + (e.responseJSON?.error?.message || e.statusText || e.message || '未知错误'));
        }
    }

    /** 构建发送给 AI 的对话内容 */
    function buildConversationText() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const name1 = ctx.name1 || 'User';
        const name2 = ctx.name2 || 'Character';

        // 获取最近 N 条消息
        const startIdx = Math.max(0, chat.length - config.contextMessages);
        const recentMessages = chat.slice(startIdx);

        let text = '';
        for (const msg of recentMessages) {
            const sender = msg.is_user ? name1 : (msg.name || name2);
            const content = msg.mes || '';
            text += `${sender}: ${content}\n\n`;
        }

        // 如果启用，附加之前的总结
        if (config.includePreviousSummary) {
            const lastSummary = getLastSummary();
            if (lastSummary) {
                text = `[之前的对话总结]\n${lastSummary.text}\n\n[新的对话内容]\n${text}`;
            }
        }

        return text.trim();
    }

    /** 生成总结（核心函数） */
    async function generateSummary() {
        if (isProcessing) {
            throw new Error('正在处理中');
        }

        const ctx = getContext();
        const chat = ctx.chat || [];

        if (chat.length < 2) {
            setStatus('对话太少，跳过总结');
            return;
        }

        isProcessing = true;
        setStatus('正在生成总结...');
        $('#as_btn_summarize').prop('disabled', true);

        try {
            const systemPrompt = getSystemPrompt();
            const conversationText = buildConversationText();

            if (!conversationText.trim()) {
                setStatus('没有可总结的内容');
                return;
            }

            log('发送总结请求...');
            const summary = await callLLM(systemPrompt, conversationText);

            if (summary && summary.trim()) {
                await saveSummary(summary.trim());
                setStatus('总结完成！', 'success');
                log('总结结果:', summary.trim());

                // 3 秒后清除成功状态
                setTimeout(() => {
                    if ($('#as_status').hasClass('success')) {
                        setStatus('');
                    }
                }, 3000);
            } else {
                setStatus('AI 返回了空内容', 'error');
            }
        } finally {
            isProcessing = false;
            $('#as_btn_summarize').prop('disabled', false);
        }
    }

    // ========== 历史记录弹窗 ==========

    function showHistoryModal() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata || {}).auto_summaries || [];

        // 移除已有弹窗
        $('.as-modal-overlay').remove();

        let entriesHtml = '';
        if (summaries.length === 0) {
            entriesHtml = '<div class="as-modal-empty">暂无总结记录</div>';
        } else {
            for (let i = summaries.length - 1; i >= 0; i--) {
                const s = summaries[i];
                const time = new Date(s.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                entriesHtml += `
                <div class="as-summary-entry">
                    <div class="entry-meta">
                        <span>#${i + 1} · ${time}</span>
                        <span>风格: ${s.style || 'normal'}</span>
                    </div>
                    <div class="entry-text">${escapeHtml(s.text)}</div>
                </div>`;
            }
        }

        const modalHtml = `
        <div class="as-modal-overlay" id="as_history_modal">
            <div class="as-modal">
                <div class="as-modal-header">
                    <h3>📋 历史总结 (${summaries.length})</h3>
                    <button class="as-modal-close" id="as_modal_close">&times;</button>
                </div>
                <div class="as-modal-body">
                    ${entriesHtml}
                </div>
                <div class="as-modal-footer">
                    <button id="as_export_summaries">导出全部</button>
                    <button id="as_clear_summaries" class="danger">清除全部</button>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        // 绑定事件
        $('#as_modal_close').on('click', () => $('#as_history_modal').remove());
        $('#as_history_modal').on('click', function (e) {
            if (e.target === this) $(this).remove();
        });

        // 导出
        $('#as_export_summaries').on('click', function () {
            if (summaries.length === 0) {
                alert('没有可导出的总结');
                return;
            }
            let exportText = '# 对话总结记录\n\n';
            summaries.forEach((s, i) => {
                const time = new Date(s.timestamp).toLocaleString('zh-CN');
                exportText += `## 总结 #${i + 1} (${time})\n\n${s.text}\n\n---\n\n`;
            });

            const blob = new Blob([exportText], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `summaries_${Date.now()}.md`;
            a.click();
            URL.revokeObjectURL(url);
        });

        // 清除全部
        $('#as_clear_summaries').on('click', async function () {
            if (!confirm('确定要清除所有总结记录吗？此操作不可撤销。')) return;
            if (ctx.chat_metadata) {
                ctx.chat_metadata.auto_summaries = [];
                if (typeof ctx.saveMetadata === 'function') {
                    await ctx.saveMetadata();
                }
            }
            $('#as_history_modal').remove();
            setStatus('已清除所有总结记录');
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== 初始化 ==========

    async function init() {
        try {
            log('初始化中...');

            // 等待 jQuery 和 SillyTavern 就绪
            if (typeof $ === 'undefined') {
                logWarn('jQuery 未加载，等待中...');
                await sleep(1000);
                return init();
            }

            loadConfig();
            buildUI();

            // 等待聊天加载完成后再绑定事件
            await sleep(2000);
            bindEvents();
            countExistingMessages();

            updateCounterDisplay();
            setStatus(config.enabled ? '就绪' : '已禁用');
            log('初始化完成 ✓');
        } catch (err) {
            logWarn('初始化失败:', err);
            setStatus('初始化失败: ' + err.message, 'error');
        }
    }

    // ========== 入口 ==========

    // 等待 DOM 就绪后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
