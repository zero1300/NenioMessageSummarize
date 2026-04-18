/**
 * Auto Summary Extension for SillyTavern
 *
 * - 每个聊天独立保存总结记录
 * - 支持 OpenAI 兼容接口与 Ollama
 * - 手动总结、自动计数触发、历史导出
 * - 可选写入世界书
 */
(function () {
    'use strict';

    const EXT_NAME = 'auto-summary';
    const LOG_PREFIX = '[AutoSummary]';

    const STYLE_PROMPTS = {
        brief: '请用 1-2 句话简明扼要地总结以下对话的核心内容。只输出总结，不要额外说明。',
        normal: '请用一个简短段落总结以下对话，包括主要事件、角色行动、情感变化和当前情境。只输出总结。',
        detailed: '请详细总结以下对话，包括：1. 主要情节发展；2. 角色的行动与决定；3. 角色关系变化；4. 当前场景与氛围；5. 重要的未解事项。只输出总结。',
    };

    const PRESETS = {
        openai:     { url: 'api.openai.com/v1/chat/completions',            prefix: 'https://', model: 'gpt-4o-mini' },
        openrouter: { url: 'openrouter.ai/api/v1/chat/completions',         prefix: 'https://', model: 'openai/gpt-4o-mini' },
        deepseek:   { url: 'api.deepseek.com/v1/chat/completions',          prefix: 'https://', model: 'deepseek-chat' },
        moonshot:   { url: 'api.moonshot.cn/v1/chat/completions',           prefix: 'https://', model: 'moonshot-v1-8k' },
        glm:        { url: 'open.bigmodel.cn/api/paas/v4/chat/completions', prefix: 'https://', model: 'glm-4-flash' },
        ollama:     { url: '127.0.0.1:11434/v1/chat/completions',           prefix: 'http://',  model: 'qwen2.5:7b' },
        custom:     { url: '', prefix: 'https://', model: '' },
    };

    let config = {};
    let messageCounter = 0;
    let isProcessing = false;
    let isConfirming = false;
    let eventBound = false;
    let autoSummarizePaused = false;
    let pollInterval = null;
    let currentChatId = null;
    let lastObservedMessageCount = 0;
    let domObserver = null;

    function log(...args) { console.log(LOG_PREFIX, ...args); }
    function logWarn(...args) { console.warn(LOG_PREFIX, ...args); }
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    function setStatus(text, type) {
        const el = document.getElementById('as_status');
        if (el) {
            el.textContent = text || '';
            el.className = 'as-status' + (type ? ' ' + type : '');
        }
        if (text) log(text);
    }

    function setTestResult(text, type) {
        const el = document.getElementById('as_test_result');
        if (el) {
            el.textContent = text || '';
            el.className = 'as-test-result as-status' + (type ? ' ' + type : '');
        }
    }

    function getSTContext() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
        } catch (e) {}
        return null;
    }

    function getChat() {
        const ctx = getSTContext();
        if (ctx && Array.isArray(ctx.chat)) return ctx.chat;
        if (Array.isArray(window.chat)) return window.chat;
        return [];
    }

    function getChatMetadata() {
        const ctx = getSTContext();
        if (ctx && ctx.chatMetadata) return ctx.chatMetadata;
        return window.chat_metadata || {};
    }

    function getCharacters() {
        const ctx = getSTContext();
        if (ctx && ctx.characters) return ctx.characters;
        return window.characters;
    }

    function getCharacterId() {
        const ctx = getSTContext();
        if (ctx && ctx.characterId !== undefined && ctx.characterId !== null) return ctx.characterId;
        return window.this_chid;
    }

    function getPersonaNames() {
        const ctx = getSTContext();
        return {
            user: ctx?.name1 || window.name1 || 'User',
            character: ctx?.name2 || window.name2 || 'Character',
        };
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text ?? '');
        return div.innerHTML;
    }

    function getDefaultConfig() {
        return {
            enabled: true,
            apiPreset: 'openai',
            apiPrefix: 'https://',
            apiUrl: 'api.openai.com/v1/chat/completions',
            apiKey: '',
            model: 'gpt-4o-mini',
            frequency: 10,
            style: 'normal',
            customPrompt: '',
            maxTokens: 300,
            contextMessages: 30,
            includePreviousSummary: true,
            worldBookEnabled: true,
        };
    }

    function requiresApiKey() {
        return (config.apiPreset || 'custom') !== 'ollama';
    }

    function hasValidApiConfig() {
        if (!config.apiUrl || !config.model) return false;
        return !requiresApiKey() || !!config.apiKey;
    }

    function loadConfig() {
        if (!window.extension_settings) window.extension_settings = {};
        if (!window.extension_settings[EXT_NAME]) window.extension_settings[EXT_NAME] = {};
        config = Object.assign(getDefaultConfig(), window.extension_settings[EXT_NAME]);
        log('配置已加载');
    }

    function saveConfig() {
        window.extension_settings[EXT_NAME] = { ...config };
        if (typeof saveSettingsDebounced === 'function') {
            saveSettingsDebounced();
        }
    }

    function resolveChatId() {
        const meta = getChatMetadata();
        const charId = getCharacterId();
        const ctx = getSTContext();

        if (meta.file_name && typeof meta.file_name === 'string' && meta.file_name.trim()) {
            return meta.file_name.trim();
        }
        if (ctx?.chatId) {
            return String(ctx.chatId);
        }
        if (charId !== undefined && charId !== null && charId !== '') {
            return 'char_' + String(charId);
        }
        if (!currentChatId) {
            currentChatId = 'chat_' + Date.now().toString(36);
        }
        return currentChatId;
    }

    function getEmptyState() {
        return {
            chatId: null,
            messageCounter: 0,
            summaries: [],
            lastUpdated: Date.now(),
            version: 1,
        };
    }

    function loadStateFromLocal(chatId) {
        try {
            const raw = localStorage.getItem(`${EXT_NAME}_${chatId}`);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return data && data.version === 1 ? data : null;
        } catch (e) {
            logWarn('localStorage 读取失败:', e);
            return null;
        }
    }

    function saveStateToLocal(chatId, state) {
        try {
            state.chatId = chatId;
            state.lastUpdated = Date.now();
            localStorage.setItem(`${EXT_NAME}_${chatId}`, JSON.stringify(state));
        } catch (e) {
            logWarn('localStorage 保存失败:', e);
        }
    }

    function getState() {
        const chatId = resolveChatId();
        let state = loadStateFromLocal(chatId);

        if (!state) {
            const meta = getChatMetadata();
            const summaries = Array.isArray(meta.auto_summaries) ? meta.auto_summaries : [];
            if (summaries.length > 0) {
                state = getEmptyState();
                state.chatId = chatId;
                state.summaries = summaries.slice();
                saveStateToLocal(chatId, state);
            }
        }

        if (!state) {
            state = getEmptyState();
            state.chatId = chatId;
        }

        return state;
    }

    async function saveState(state) {
        const chatId = resolveChatId();
        state.chatId = chatId;
        saveStateToLocal(chatId, state);

        if (!window.chat_metadata) window.chat_metadata = {};
        window.chat_metadata.auto_summaries = state.summaries.slice();

        const ctx = getSTContext();
        if (ctx?.chatMetadata) {
            ctx.chatMetadata.auto_summaries = state.summaries.slice();
        }

        try {
            if (typeof saveMetadata === 'function') {
                await saveMetadata();
            } else if (ctx?.saveMetadata) {
                if (ctx?.saveMetadata) await ctx.saveMetadata();
            }
        } catch (e) {
            logWarn('saveMetadata 失败（localStorage 已保存）:', e);
        }
    }

    function syncState() {
        const nextChatId = resolveChatId();
        if (nextChatId !== currentChatId) {
            currentChatId = nextChatId;
            messageCounter = 0;
            log('聊天切换:', currentChatId);
        }

        if (!window.chat_metadata) window.chat_metadata = {};
        const state = loadStateFromLocal(currentChatId);
        if (state?.summaries?.length) {
            window.chat_metadata.auto_summaries = state.summaries.slice();
            const ctx = getSTContext();
            if (ctx?.chatMetadata) {
                ctx.chatMetadata.auto_summaries = state.summaries.slice();
            }
        }
        lastObservedMessageCount = getRealMessageIndices().length;
    }

    function getRealMessageIndices() {
        const chat = getChat();
        const indices = [];
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i]?.is_system) indices.push(i);
        }
        return indices;
    }

    function getCharacterName() {
        const chars = getCharacters();
        const chid = getCharacterId();
        if (chars && chid !== undefined && chars[chid]) {
            return chars[chid].name || 'Unknown';
        }
        return getPersonaNames().character;
    }

    function getLastSummary() {
        const state = getState();
        return state.summaries.length ? state.summaries[state.summaries.length - 1] : null;
    }

    function getLastSummarizedIndex() {
        const last = getLastSummary();
        return last && last.endIndex !== undefined ? last.endIndex : -1;
    }

    function updateWorldBookInfo() {
        try {
            const charName = getCharacterName();
            const state = getState();
            const nextNum = String(state.summaries.length + 1).padStart(3, '0');
            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            $('#as_wb_info').html(`命名格式: <strong>${escapeHtml(`Summary_${charName}_${date}_${nextNum}`)}</strong>`);
        } catch (e) {
            logWarn('更新世界书提示失败:', e);
        }
    }

    function updateStats() {
        const state = getState();
        const totalReal = getRealMessageIndices().length;
        const summarizedReal = state.summaries.reduce((sum, item) => sum + (item.messageRange || 0), 0);
        const unsavedReal = Math.max(0, totalReal - summarizedReal);
        const percent = totalReal > 0 ? Math.round((summarizedReal / totalReal) * 100) : 0;

        $('#as_stat_total').text(totalReal);
        $('#as_stat_summarized').text(summarizedReal);
        $('#as_stat_unsaved').text(unsavedReal);
        $('#as_stat_records').text(state.summaries.length);
        $('#as_progress_fill').css('width', percent + '%');
        $('#as_progress_text').text(percent + '% 已总结');
        updateWorldBookInfo();
    }

    function updateCounterDisplay() {
        const el = document.getElementById('as_counter');
        if (el) {
            el.textContent = `已计数: ${messageCounter} / ${config.frequency} 轮`;
        }
    }

    function syncMessageCounter(forceReset) {
        const realCount = getRealMessageIndices().length;
        if (forceReset || realCount < lastObservedMessageCount) {
            lastObservedMessageCount = realCount;
            return;
        }

        const delta = realCount - lastObservedMessageCount;
        if (delta > 0) {
            messageCounter += delta;
            lastObservedMessageCount = realCount;
            updateCounterDisplay();
            updateStats();
            checkAndSummarize();
        }
    }

    function readUIConfig() {
        config.enabled = $('#as_enabled').is(':checked');
        config.apiPrefix = $('#as_url_prefix').text().trim();
        config.apiUrl = $('#as_api_url').val().trim();
        config.apiKey = $('#as_api_key').val().trim();
        config.model = $('#as_model').val().trim();
        config.frequency = parseInt($('#as_frequency').val(), 10) || 10;
        config.style = $('#as_style').val();
        config.customPrompt = $('#as_custom_prompt').val();
        config.maxTokens = parseInt($('#as_max_tokens').val(), 10) || 300;
        config.contextMessages = parseInt($('#as_context_messages').val(), 10) || 30;
        config.includePreviousSummary = $('#as_include_prev').is(':checked');
        config.worldBookEnabled = $('#as_wb_enabled').is(':checked');
    }

    function writeUIConfig() {
        $('#as_enabled').prop('checked', config.enabled);
        $('#as_url_prefix').text(config.apiPrefix || 'https://');
        $('#as_api_url').val(config.apiUrl || '');
        $('#as_api_key').val(config.apiKey || '');
        $('#as_model').val(config.model || '');
        $('#as_frequency').val(config.frequency);
        $('#as_frequency_val').text(config.frequency);
        $('#as_style').val(config.style);
        $('#as_custom_prompt_wrap').css('display', config.style === 'custom' ? 'flex' : 'none');
        $('#as_custom_prompt').val(config.customPrompt || '');
        $('#as_max_tokens').val(config.maxTokens);
        $('#as_max_tokens_val').text(config.maxTokens);
        $('#as_context_messages').val(config.contextMessages);
        $('#as_context_messages_val').text(config.contextMessages);
        $('#as_include_prev').prop('checked', config.includePreviousSummary);
        $('#as_wb_enabled').prop('checked', config.worldBookEnabled);
        $('.as-chip').removeClass('active');
        $(`.as-chip[data-preset="${config.apiPreset}"]`).addClass('active');
    }

    function buildUI() {
        const html = `
        <div id="auto_summary_panel" class="auto-summary-panel">
            <h4>
                <span class="panel-toggle" id="as_panel_toggle">▼</span>
                📝 自动总结
            </h4>
            <div class="as-body" id="as_body">
                <div class="as-section-title">楼层统计</div>
                <div class="as-stats">
                    <div class="as-stat-chip total">
                        <span class="as-stat-value" id="as_stat_total">0</span>
                        <span class="as-stat-label">总消息</span>
                    </div>
                    <div class="as-stat-chip summarized">
                        <span class="as-stat-value" id="as_stat_summarized">0</span>
                        <span class="as-stat-label">已总结</span>
                    </div>
                    <div class="as-stat-chip unsaved">
                        <span class="as-stat-value" id="as_stat_unsaved">0</span>
                        <span class="as-stat-label">未总结</span>
                    </div>
                    <div class="as-stat-chip records">
                        <span class="as-stat-value" id="as_stat_records">0</span>
                        <span class="as-stat-label">总结次数</span>
                    </div>
                </div>

                <div class="as-progress-wrap">
                    <div class="as-progress-bar">
                        <div class="as-progress-fill" id="as_progress_fill" style="width:0%"></div>
                    </div>
                    <div class="as-progress-text" id="as_progress_text">0%</div>
                </div>

                <hr class="as-divider">

                <div class="as-toggle-row">
                    <label for="as_enabled">启用自动总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_enabled">
                        <span class="slider"></span>
                    </div>
                </div>

                <hr class="as-divider">

                <div class="as-section-title">API 配置</div>
                <div class="as-control">
                    <label>快速预设</label>
                    <div class="as-presets" id="as_presets">
                        <button class="as-chip" data-preset="openai">OpenAI</button>
                        <button class="as-chip" data-preset="openrouter">OpenRouter</button>
                        <button class="as-chip" data-preset="deepseek">DeepSeek</button>
                        <button class="as-chip" data-preset="moonshot">Moonshot</button>
                        <button class="as-chip" data-preset="glm">智谱 GLM</button>
                        <button class="as-chip" data-preset="ollama">Ollama</button>
                        <button class="as-chip" data-preset="custom">自定义</button>
                    </div>
                </div>

                <div class="as-control">
                    <label for="as_api_url">API 地址</label>
                    <div class="as-api-url-row">
                        <span class="as-api-url-prefix" id="as_url_prefix">https://</span>
                        <input type="text" id="as_api_url" placeholder="api.openai.com/v1/chat/completions" spellcheck="false">
                    </div>
                </div>

                <div class="as-control">
                    <label for="as_api_key">API Key</label>
                    <input type="password" id="as_api_key" placeholder="sk-xxxxxxxx" spellcheck="false" autocomplete="off">
                </div>

                <div class="as-control">
                    <label for="as_model">模型名称</label>
                    <input type="text" id="as_model" placeholder="gpt-4o-mini" spellcheck="false">
                </div>

                <div class="as-test-row">
                    <button id="as_btn_test" style="flex:0 0 auto; padding: 5px 12px;">🔗 测试连接</button>
                    <div class="as-test-result" id="as_test_result"></div>
                </div>

                <hr class="as-divider">

                <div class="as-section-title">总结配置</div>
                <div class="as-control">
                    <label for="as_frequency">自动触发频率（每 N 轮）</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_frequency" min="1" max="50" value="${config.frequency}" step="1">
                        <span class="as-slider-val" id="as_frequency_val">${config.frequency}</span>
                    </div>
                </div>

                <div class="as-control">
                    <label for="as_style">总结风格</label>
                    <select id="as_style">
                        <option value="brief">简短 - 一句话概括</option>
                        <option value="normal">标准 - 段落式总结</option>
                        <option value="detailed">详细 - 完整情节梳理</option>
                        <option value="custom">自定义提示词</option>
                    </select>
                </div>

                <div class="as-control">
                    <label for="as_max_tokens">总结最大 Token 数</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_max_tokens" min="50" max="2000" value="${config.maxTokens}" step="50">
                        <span class="as-slider-val" id="as_max_tokens_val">${config.maxTokens}</span>
                    </div>
                </div>

                <div class="as-control">
                    <label for="as_context_messages">发送给 AI 的最近消息数</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_context_messages" min="5" max="200" value="${config.contextMessages}" step="5">
                        <span class="as-slider-val" id="as_context_messages_val">${config.contextMessages}</span>
                    </div>
                </div>

                <div class="as-toggle-row">
                    <label for="as_include_prev">上下文包含之前的总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_include_prev">
                        <span class="slider"></span>
                    </div>
                </div>

                <div class="as-control" id="as_custom_prompt_wrap" style="display:none;">
                    <label for="as_custom_prompt">自定义系统提示词</label>
                    <textarea id="as_custom_prompt" rows="3" placeholder="例如：请用中文总结以下对话，重点记录角色的情感变化和关键事件。"></textarea>
                </div>

                <hr class="as-divider">

                <div class="as-section-title">世界书设置</div>
                <div class="as-toggle-row">
                    <label for="as_wb_enabled">写入世界书</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_wb_enabled">
                        <span class="slider"></span>
                    </div>
                </div>

                <div class="as-wb-info" id="as_wb_info">命名格式: Summary_角色名_日期_序号</div>

                <hr class="as-divider">

                <div class="as-buttons" id="as_action_buttons">
                    <button id="as_btn_summarize" class="as-btn-primary">⚡ 立即总结</button>
                    <button id="as_btn_history">📋 历史记录</button>
                    <button id="as_btn_reset">🔄 重置</button>
                </div>

                <div class="as-confirm-section" id="as_confirm_section" style="display:none;">
                    <div class="as-confirm-title">⚡ 确认总结操作</div>
                    <div class="as-confirm-info" id="as_confirm_info"></div>
                    <div class="as-control">
                        <label for="as_confirm_range">总结范围（起始消息）</label>
                        <div class="as-slider-row">
                            <input type="range" id="as_confirm_range" min="0" max="100" value="0" step="1">
                            <span class="as-slider-val" id="as_confirm_range_val">-</span>
                        </div>
                    </div>
                    <div class="as-control">
                        <label for="as_confirm_style">本次总结风格</label>
                        <select id="as_confirm_style">
                            <option value="brief">简短</option>
                            <option value="normal">标准</option>
                            <option value="detailed">详细</option>
                            <option value="custom">自定义</option>
                        </select>
                    </div>
                    <div class="as-confirm-buttons">
                        <button id="as_btn_confirm_yes" class="as-btn-confirm-execute">✅ 确认总结</button>
                        <button id="as_btn_confirm_no" class="as-btn-confirm-cancel">✖ 取消</button>
                    </div>
                </div>

                <div class="as-counter" id="as_counter">已计数: 0 / ${config.frequency} 轮</div>
                <div class="as-status" id="as_status"></div>
            </div>
        </div>`;

        const container = $('#extensions_settings');
        if (container.length && !$('#auto_summary_panel').length) {
            container.append(html);
            log('UI 已注入');
        }

        writeUIConfig();
        bindUIEvents();
        updateCounterDisplay();
        updateStats();
    }

    function bindUIEvents() {
        $('#as_panel_toggle').on('click', function () {
            $(this).toggleClass('collapsed');
            $('#as_body').toggleClass('collapsed');
        });

        $('#as_enabled').on('change', function () {
            config.enabled = this.checked;
            saveConfig();
            setStatus(config.enabled ? '已启用' : '已禁用');
        });

        $('#as_presets').on('click', '.as-chip', function () {
            const presetName = $(this).data('preset');
            const preset = PRESETS[presetName];
            if (!preset) return;

            config.apiPreset = presetName;
            config.apiPrefix = preset.prefix;
            config.apiUrl = preset.url;
            config.model = preset.model;
            if (presetName === 'ollama') config.apiKey = '';
            writeUIConfig();
            saveConfig();
            setTestResult('');
        });

        $('#as_api_url').on('input', function () {
            config.apiUrl = this.value.trim();
            config.apiPreset = 'custom';
            $('.as-chip').removeClass('active');
            $('.as-chip[data-preset="custom"]').addClass('active');
            saveConfig();
        });

        $('#as_api_key').on('input', function () {
            config.apiKey = this.value.trim();
            saveConfig();
        });

        $('#as_model').on('input', function () {
            config.model = this.value.trim();
            saveConfig();
        });

        $('#as_url_prefix').on('click', function () {
            const next = $(this).text().trim() === 'https://' ? 'http://' : 'https://';
            $(this).text(next);
            config.apiPrefix = next;
            saveConfig();
        });

        $('#as_btn_test').on('click', async function () {
            const btn = $(this);
            btn.prop('disabled', true);
            setTestResult('测试中...');
            try {
                readUIConfig();
                if (!hasValidApiConfig()) {
                    throw new Error(requiresApiKey() ? '请先配置 API 地址、Key 和模型' : '请先配置 API 地址和模型');
                }
                const result = await testAPIConnection(config.apiPrefix + config.apiUrl, config.apiKey, config.model);
                setTestResult('连接成功: ' + result, 'success');
            } catch (e) {
                setTestResult('连接失败: ' + (e.message || e), 'error');
            } finally {
                btn.prop('disabled', false);
            }
        });

        $('#as_frequency').on('input', function () {
            config.frequency = parseInt(this.value, 10) || 10;
            $('#as_frequency_val').text(config.frequency);
            saveConfig();
            updateCounterDisplay();
        });

        $('#as_max_tokens').on('input', function () {
            config.maxTokens = parseInt(this.value, 10) || 300;
            $('#as_max_tokens_val').text(config.maxTokens);
            saveConfig();
        });

        $('#as_context_messages').on('input', function () {
            config.contextMessages = parseInt(this.value, 10) || 30;
            $('#as_context_messages_val').text(config.contextMessages);
            saveConfig();
        });

        $('#as_style').on('change', function () {
            config.style = this.value;
            $('#as_custom_prompt_wrap').css('display', config.style === 'custom' ? 'flex' : 'none');
            saveConfig();
        });

        $('#as_custom_prompt').on('input', function () {
            config.customPrompt = this.value;
            saveConfig();
        });

        $('#as_include_prev').on('change', function () {
            config.includePreviousSummary = this.checked;
            saveConfig();
        });

        $('#as_wb_enabled').on('change', function () {
            config.worldBookEnabled = this.checked;
            saveConfig();
        });

        $('#as_btn_summarize').on('click', function () {
            if (isProcessing || isConfirming) return;
            readUIConfig();
            if (!hasValidApiConfig()) {
                setStatus(requiresApiKey() ? '请先配置 API 地址、Key 和模型' : '请先配置 API 地址和模型', 'error');
                return;
            }
            showConfirm();
        });

        $('#as_btn_confirm_yes').on('click', async function () {
            if (isProcessing) return;
            const realIndices = getRealMessageIndices();
            const startPos = parseInt($('#as_confirm_range').val(), 10) || 0;
            const startIndex = realIndices[startPos];
            const style = $('#as_confirm_style').val();

            hideConfirm();
            autoSummarizePaused = false;

            try {
                await executeSummary(startIndex, style);
                messageCounter = 0;
                lastObservedMessageCount = getRealMessageIndices().length;
                updateCounterDisplay();
                updateStats();
            } catch (err) {
                logWarn('总结失败:', err);
                setStatus('总结失败: ' + (err.message || err), 'error');
            }
        });

        $('#as_btn_confirm_no').on('click', function () {
            hideConfirm();
            autoSummarizePaused = false;
            setStatus('已取消');
        });

        $('#as_confirm_range').on('input', updateConfirmRangeLabel);
        $('#as_btn_history').on('click', showHistoryModal);

        $('#as_btn_reset').on('click', function () {
            messageCounter = 0;
            lastObservedMessageCount = getRealMessageIndices().length;
            updateCounterDisplay();
            setStatus('计数器已重置');
        });
    }

    function showConfirm() {
        const realIndices = getRealMessageIndices();
        const lastIdx = getLastSummarizedIndex();
        const defaultStartPos = Math.max(0, realIndices.length - config.contextMessages);
        const minPos = lastIdx >= 0 ? Math.max(0, realIndices.findIndex(i => i > lastIdx)) : 0;
        const slider = $('#as_confirm_range');
        const sliderValue = Math.max(minPos, defaultStartPos);

        slider.attr('min', minPos);
        slider.attr('max', Math.max(minPos, realIndices.length > 0 ? realIndices.length - 1 : 0));
        slider.attr('step', 1);
        slider.val(realIndices.length > 0 ? sliderValue : 0);

        $('#as_confirm_style').val(config.style);

        let infoHtml = `当前对话: <strong>${realIndices.length}</strong> 条消息`;
        if (lastIdx >= 0) {
            infoHtml += `，已总结至消息 #<strong>${lastIdx + 1}</strong>`;
        }
        infoHtml += `<br>角色: <strong>${escapeHtml(getCharacterName())}</strong>`;
        $('#as_confirm_info').html(infoHtml);

        updateConfirmRangeLabel();

        isConfirming = true;
        autoSummarizePaused = true;
        $('#as_action_buttons').hide();
        $('#as_confirm_section').show();
        setStatus('等待确认...', 'info');
    }

    function hideConfirm() {
        isConfirming = false;
        $('#as_confirm_section').hide();
        $('#as_action_buttons').show();
    }

    function updateConfirmRangeLabel() {
        const realIndices = getRealMessageIndices();
        if (realIndices.length === 0) {
            $('#as_confirm_range_val').text('-');
            return;
        }

        const startPos = parseInt($('#as_confirm_range').val(), 10) || 0;
        const boundedStart = Math.min(Math.max(0, startPos), realIndices.length - 1);
        const startMsg = `#${realIndices[boundedStart] + 1}`;
        const endMsg = `#${realIndices[realIndices.length - 1] + 1}`;
        const count = realIndices.length - boundedStart;
        $('#as_confirm_range_val').text(`${startMsg} -> ${endMsg} (${count}条)`);
    }

    async function testAPIConnection(url, apiKey, model) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

        const response = await $.ajax({
            url,
            type: 'POST',
            contentType: 'application/json',
            headers,
            data: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
                max_tokens: 10,
                temperature: 0,
            }),
            timeout: 15000,
        });

        return response.model || model;
    }

    async function callLLM(systemPrompt, userContent) {
        const url = config.apiPrefix + config.apiUrl;
        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

        log('请求:', url, '| 模型:', config.model);

        let response;
        try {
            response = await $.ajax({
                url,
                type: 'POST',
                contentType: 'application/json',
                headers,
                data: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent },
                    ],
                    max_tokens: config.maxTokens,
                    temperature: 0.3,
                    stream: false,
                }),
                timeout: 120000,
            });
        } catch (xhr) {
            let errMsg = '未知错误';
            if (xhr.responseJSON) {
                const err = xhr.responseJSON.error || xhr.responseJSON;
                errMsg = err.message || err.error || JSON.stringify(err);
            } else if (xhr.statusText) {
                errMsg = `${xhr.status} ${xhr.statusText}`;
            }
            throw new Error('API 请求失败: ' + errMsg);
        }

        if (typeof response === 'string') return response.trim();
        if (response?.choices?.[0]) {
            let content = response.choices[0].message?.content || response.choices[0].text || '';
            if (Array.isArray(content)) {
                content = content.map(item => typeof item === 'string' ? item : (item.text || '')).join('');
            }
            return String(content).trim();
        }
        if (Array.isArray(response?.content)) {
            return response.content.map(item => item.text || '').join('').trim();
        }
        for (const key of ['output', 'result', 'response', 'reply', 'answer']) {
            if (typeof response?.[key] === 'string') return response[key].trim();
        }
        throw new Error('无法解析响应: ' + JSON.stringify(response).slice(0, 200));
    }

    function getSystemPrompt(style) {
        if (style === 'custom' && config.customPrompt?.trim()) {
            return config.customPrompt.trim();
        }
        return STYLE_PROMPTS[style] || STYLE_PROMPTS.normal;
    }

    function buildConversationText(startMsgIndex) {
        const chat = getChat();
        const names = getPersonaNames();
        const name1 = names.user;
        const name2 = names.character;
        const startIndex = startMsgIndex !== undefined
            ? startMsgIndex
            : Math.max(0, chat.length - config.contextMessages);
        const messages = chat.slice(startIndex);

        let text = '';
        for (const msg of messages) {
            if (msg?.is_system) continue;
            const sender = msg.is_user ? name1 : (msg.name || name2);
            text += `${sender}: ${msg.mes || ''}\n\n`;
        }

        if (config.includePreviousSummary) {
            const last = getLastSummary();
            if (last?.text) {
                text = `[之前的对话总结]\n${last.text}\n\n[新的对话内容]\n${text}`;
            }
        }

        return text.trim();
    }

    async function saveSummary(text, startIdx, endIdx, style) {
        const state = getState();
        const realInRange = getRealMessageIndices().filter(i => i >= startIdx && i <= endIdx);
        state.summaries.push({
            text,
            timestamp: Date.now(),
            startIndex: startIdx,
            endIndex: endIdx,
            messageRange: realInRange.length,
            style,
            model: config.model,
            worldBookName: null,
            worldBookFile: null,
            worldBookSaved: false,
        });
        await saveState(state);
        log('总结已保存:', startIdx, '-', endIdx, `(${realInRange.length}条)`);
    }

    async function createWorldBookEntry(summaryText, summaryIndex) {
        if (!config.worldBookEnabled) return;

        try {
            const charName = getCharacterName();
            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const seq = String(summaryIndex + 1).padStart(3, '0');
            const entryName = `Summary_${charName}_${date}_${seq}`;
            const bookName = `AutoSummary_${charName.replace(/\s+/g, '_')}_${date}`;
            const keys = [charName, '总结', 'summary'];

            const nameParts = charName.split(/\s+/).filter(Boolean);
            for (const part of nameParts) {
                if (!keys.includes(part)) keys.push(part);
            }

            const wiData = typeof world_info !== 'undefined' && world_info
                ? world_info
                : (typeof world_info_data !== 'undefined' ? world_info_data : null);

            if (!wiData) {
                logWarn('无法获取世界书数据');
                return;
            }

            if (!wiData[bookName]) wiData[bookName] = { entries: {} };
            if (typeof world_names !== 'undefined' && Array.isArray(world_names) && !world_names.includes(bookName)) {
                world_names.push(bookName);
            }

            const entryUid = Date.now().toString();
            const newEntry = {
                uid: entryUid,
                keys,
                keysecondary: [],
                content: `【对话总结 #${seq}】\n${summaryText}`,
                comment: entryName,
                constant: false,
                enabled: true,
                selective: true,
                insertion_order: 0,
                disable: false,
                position: 0,
                depth: 4,
                probability: 100,
                useProbability: true,
                excludeRecursion: false,
                preventRecursion: true,
                delayUntilRecursion: false,
                displayIndex: summaryIndex,
                addMemo: true,
                sticky: 0,
                cooldown: 0,
                delay: 0,
            };

            let entryAdded = false;
            const entries = wiData[bookName].entries;
            if (Array.isArray(entries)) {
                entries.push(newEntry);
                entryAdded = true;
            } else if (entries && typeof entries === 'object') {
                entries[entryUid] = newEntry;
                entryAdded = true;
            }

            if (entryAdded) {
                const es = typeof eventSource !== 'undefined' ? eventSource : null;
                if (es?.emit) {
                    for (const evtName of ['worldinfoUpdated', 'worldInfoUpdated', 'WORLDINFO_UPDATED', 'WORLD_INFO_UPDATED']) {
                        try {
                            es.emit(evtName, { name: bookName });
                            break;
                        } catch (e) {}
                    }
                }

                for (const fnName of ['saveWorldInfo', 'saveWorldInfoData', 'saveWorldInfos']) {
                    if (typeof window[fnName] === 'function') {
                        try {
                            await window[fnName](bookName);
                        } catch (e) {}
                    }
                }

                const state = getState();
                if (state.summaries.length > 0) {
                    const last = state.summaries[state.summaries.length - 1];
                    last.worldBookName = entryName;
                    last.worldBookFile = bookName;
                    last.worldBookSaved = true;
                    await saveState(state);
                }

                log('世界书条目已创建:', entryName, '->', bookName);
            }
        } catch (e) {
            logWarn('世界书操作异常:', e);
        }
    }

    async function executeSummary(startMsgIndex, style) {
        if (isProcessing) throw new Error('正在处理中');

        const chat = getChat();
        if (chat.length < 2) {
            setStatus('对话太少，跳过总结');
            return;
        }
        if (!hasValidApiConfig()) {
            throw new Error(requiresApiKey() ? '请先配置 API 地址、Key 和模型' : '请先配置 API 地址和模型');
        }

        const realIndices = getRealMessageIndices();
        if (!realIndices.length) {
            setStatus('没有可总结的内容');
            return;
        }

        const lastIdx = getLastSummarizedIndex();
        const minStart = lastIdx >= 0 ? (realIndices.find(i => i > lastIdx) ?? realIndices[0]) : realIndices[0];
        const computedStart = startMsgIndex !== undefined ? startMsgIndex : Math.max(minStart, realIndices[Math.max(0, realIndices.length - config.contextMessages)]);
        const startIdx = Math.max(minStart, computedStart);
        const endIdx = chat.length - 1;
        const finalStyle = style || config.style;

        isProcessing = true;
        setStatus('正在生成总结...');
        $('#as_btn_summarize').prop('disabled', true);

        try {
            const systemPrompt = getSystemPrompt(finalStyle);
            const text = buildConversationText(startIdx);
            if (!text) {
                setStatus('没有可总结的内容');
                return;
            }

            log('总结范围: 消息', startIdx, '-', endIdx);
            const summary = await callLLM(systemPrompt, text);
            if (!summary?.trim()) {
                setStatus('AI 返回了空内容', 'error');
                return;
            }

            await saveSummary(summary.trim(), startIdx, endIdx, finalStyle);
            const state = getState();
            await createWorldBookEntry(summary.trim(), state.summaries.length - 1);

            lastObservedMessageCount = getRealMessageIndices().length;
            setStatus('总结完成！', 'success');
            updateStats();
            setTimeout(() => {
                if ($('#as_status').hasClass('success')) setStatus('');
            }, 4000);
        } finally {
            isProcessing = false;
            $('#as_btn_summarize').prop('disabled', false);
        }
    }

    function checkAndSummarize() {
        if (!config.enabled || isProcessing || isConfirming || autoSummarizePaused) return;
        if (!hasValidApiConfig()) return;
        if (messageCounter >= config.frequency) {
            log(`达到触发条件 (${messageCounter} >= ${config.frequency})`);
            messageCounter = 0;
            updateCounterDisplay();
            showConfirm();
        }
    }

    function bindEvents() {
        if (eventBound) return;

        const es = typeof eventSource !== 'undefined' ? eventSource : null;
        if (es?.on) {
            for (const evt of ['messageReceived', 'messageSent', 'MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
                try {
                    es.on(evt, () => {
                        setTimeout(() => syncMessageCounter(false), 600);
                    });
                    log('绑定:', evt);
                } catch (e) {}
            }

            for (const evt of ['chatLoaded', 'CHAT_CHANGED', 'chatChanged', 'chat_id_changed']) {
                try {
                    es.on(evt, () => {
                        setTimeout(() => {
                            syncState();
                            messageCounter = 0;
                            updateCounterDisplay();
                            updateStats();
                        }, 1200);
                    });
                    log('绑定:', evt);
                } catch (e) {}
            }

            for (const evt of ['message_swiped', 'MESSAGE_SWIPED', 'message_edited', 'MESSAGE_EDITED']) {
                try {
                    es.on(evt, () => {
                        setTimeout(() => {
                            lastObservedMessageCount = getRealMessageIndices().length;
                            updateStats();
                        }, 500);
                    });
                } catch (e) {}
            }

            eventBound = true;
        } else {
            logWarn('eventSource 不可用');
        }

        if (!pollInterval) {
            pollInterval = setInterval(updateStats, 3000);
            log('轮询已启动 (3s)');
        }

        startDOMObserver();
    }

    function startDOMObserver() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return;
        const target = chatEl.parentElement || chatEl;

        if (domObserver) {
            domObserver.disconnect();
        }

        let debounceTimer = null;
        domObserver = new MutationObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => syncMessageCounter(false), 800);
        });
        domObserver.observe(target, { childList: true, subtree: true });
        log('DOM Observer 已启动');
    }

    function showHistoryModal() {
        const state = getState();
        const summaries = state.summaries;
        $('.as-modal-overlay').remove();

        let entries = '';
        if (!summaries.length) {
            entries = '<div class="as-modal-empty">暂无总结记录</div>';
        } else {
            for (let i = summaries.length - 1; i >= 0; i--) {
                const item = summaries[i];
                const time = new Date(item.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                });
                const range = item.startIndex !== undefined && item.endIndex !== undefined
                    ? `消息 #${item.startIndex + 1} - #${item.endIndex + 1} (${item.messageRange || '?'}条)`
                    : `${item.messageRange || '?'}条消息`;
                const modelTag = item.model ? ` · ${item.model}` : '';
                const wbTag = item.worldBookName ? `<div class="entry-wb">📖 ${escapeHtml(item.worldBookName)}</div>` : '';

                entries += `
                <div class="as-summary-entry">
                    <div class="entry-meta">
                        <span>#${i + 1} · ${time}${modelTag}</span>
                        <span class="entry-range">${range}</span>
                    </div>
                    <div class="entry-text">${escapeHtml(item.text)}</div>
                    ${wbTag}
                </div>`;
            }
        }

        const modal = $(`
        <div class="as-modal-overlay" id="as_history_modal">
            <div class="as-modal">
                <div class="as-modal-header">
                    <h3>📋 历史总结 (${summaries.length})</h3>
                    <button class="as-modal-close" id="as_modal_close">&times;</button>
                </div>
                <div class="as-modal-body">${entries}</div>
                <div class="as-modal-footer">
                    <button id="as_export_summaries">导出全部</button>
                    <button id="as_clear_summaries" class="danger">清除全部</button>
                </div>
            </div>
        </div>`);

        $('body').append(modal);
        $('#as_modal_close').on('click', () => modal.remove());
        modal.on('click', function (e) {
            if (e.target === this) $(this).remove();
        });

        $('#as_export_summaries').on('click', function () {
            if (!summaries.length) {
                alert('没有可导出的总结');
                return;
            }

            let md = '# 对话总结记录\n\n';
            summaries.forEach((item, index) => {
                const time = new Date(item.timestamp).toLocaleString('zh-CN');
                const range = item.startIndex !== undefined ? `消息 #${item.startIndex + 1} - #${item.endIndex + 1}` : '';
                md += `## #${index + 1} (${time}) ${range}\n\n${item.text}\n\n---\n\n`;
            });

            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `summaries_${Date.now()}.md`;
            a.click();
        });

        $('#as_clear_summaries').on('click', async function () {
            if (!confirm('确定清除所有总结？此操作不可撤销。')) return;

            const nextState = getState();
            nextState.summaries = [];
            await saveState(nextState);
            messageCounter = 0;
            lastObservedMessageCount = getRealMessageIndices().length;
            modal.remove();
            updateCounterDisplay();
            updateStats();
            setStatus('已清除所有总结');
        });
    }

    async function init() {
        try {
            if (typeof $ === 'undefined') {
                await sleep(1000);
                return init();
            }

            loadConfig();
            currentChatId = resolveChatId();
            syncState();
            buildUI();

            await sleep(2000);
            bindEvents();

            messageCounter = 0;
            lastObservedMessageCount = getRealMessageIndices().length;
            updateCounterDisplay();
            updateStats();
            setStatus(config.enabled ? '就绪' : '已禁用');
            log('初始化完成 ✓');
        } catch (err) {
            logWarn('初始化失败:', err);
            setStatus('初始化失败: ' + err.message, 'error');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
