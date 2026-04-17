/**
 * Auto Summary Extension for SillyTavern v1.1
 *
 * 支持手动配置 API 地址 / Key / 模型
 * 兼容 OpenAI / OpenRouter / DeepSeek / Moonshot / 智谱 / Ollama 等兼容接口
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

    // 预设配置
    const PRESETS = {
        openai: {
            url: 'api.openai.com/v1/chat/completions',
            prefix: 'https://',
            model: 'gpt-4o-mini'
        },
        openrouter: {
            url: 'openrouter.ai/api/v1/chat/completions',
            prefix: 'https://',
            model: 'openai/gpt-4o-mini'
        },
        deepseek: {
            url: 'api.deepseek.com/v1/chat/completions',
            prefix: 'https://',
            model: 'deepseek-chat'
        },
        moonshot: {
            url: 'api.moonshot.cn/v1/chat/completions',
            prefix: 'https://',
            model: 'moonshot-v1-8k'
        },
        glm: {
            url: 'open.bigmodel.cn/api/paas/v4/chat/completions',
            prefix: 'https://',
            model: 'glm-4-flash'
        },
        ollama: {
            url: '127.0.0.1:11434/v1/chat/completions',
            prefix: 'http://',
            model: 'qwen2.5:7b'
        },
        custom: {
            url: '',
            prefix: 'https://',
            model: ''
        }
    };

    // ========== 全局状态 ==========
    let config = {};
    let messageCounter = 0;
    let isProcessing = false;
    let eventBound = false;

    // ========== 工具函数 ==========

    function getContext() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
        return {
            extensionSettings: window.extension_settings || {},
            chat: window.chat || [],
            characters: window.characters || [],
            this_chid: window.this_chid,
            eventSource: window.eventSource,
            name1: window.name1 || 'User',
            name2: window.name2 || 'Character',
            chat_metadata: window.chat_metadata || {},
            saveSettingsDebounced: window.saveSettingsDebounced || function () { }
        };
    }

    function log(...args) { console.log(LOG_PREFIX, ...args); }
    function logWarn(...args) { console.warn(LOG_PREFIX, ...args); }

    function setStatus(text, type) {
        const el = document.getElementById('as_status');
        if (el) {
            el.textContent = text;
            el.className = 'as-status' + (type ? ' ' + type : '');
        }
        if (text) log(text);
    }

    function setTestResult(text, type) {
        const el = document.getElementById('as_test_result');
        if (el) {
            el.textContent = text;
            el.className = 'as-test-result as-status' + (type ? ' ' + type : '');
        }
    }

    function updateCounterDisplay() {
        const el = document.getElementById('as_counter');
        if (el) el.textContent = `已计数: ${messageCounter} / ${config.frequency} 轮`;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ========== 配置管理 ==========

    function getDefaultConfig() {
        return {
            enabled: true,
            // API 配置
            apiPreset: 'openai',
            apiPrefix: 'https://',
            apiUrl: 'api.openai.com/v1/chat/completions',
            apiKey: '',
            model: 'gpt-4o-mini',
            // 总结配置
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
        log('配置已加载:', { ...config, apiKey: config.apiKey ? '***' : '(空)' });
    }

    function saveConfig() {
        const ctx = getContext();
        ctx.extensionSettings[EXT_NAME] = { ...config };
        if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
    }

    /** 从 UI 读取当前表单值到 config */
    function readUIConfig() {
        config.enabled = $('#as_enabled').is(':checked');
        config.apiPrefix = $('#as_url_prefix').text().trim();
        config.apiUrl = $('#as_api_url').val().trim();
        config.apiKey = $('#as_api_key').val().trim();
        config.model = $('#as_model').val().trim();
        config.frequency = parseInt($('#as_frequency').val()) || 10;
        config.style = $('#as_style').val();
        config.customPrompt = $('#as_custom_prompt').val();
        config.maxTokens = parseInt($('#as_max_tokens').val()) || 300;
        config.contextMessages = parseInt($('#as_context_messages').val()) || 30;
        config.includePreviousSummary = $('#as_include_prev').is(':checked');
    }

    /** 从 config 写入 UI 表单 */
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

        // 高亮预设芯片
        $('.as-chip').removeClass('active');
        $(`.as-chip[data-preset="${config.apiPreset}"]`).addClass('active');
    }

    // ========== UI 构建 ==========

    function buildUI() {
        const html = `
        <div id="auto_summary_panel" class="auto-summary-panel">
            <h4>
                <span class="panel-toggle" id="as_panel_toggle">▼</span>
                📝 自动总结
            </h4>
            <div class="as-body" id="as_body">
                <div class="as-toggle-row">
                    <label for="as_enabled">启用自动总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_enabled">
                        <span class="slider"></span>
                    </div>
                </div>
                <hr class="as-divider">

                <!-- API 配置 -->
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

                <!-- 总结配置 -->
                <div class="as-section-title">总结配置</div>
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
                        <option value="brief">简短 — 一句话概括</option>
                        <option value="normal" selected>标准 — 段落式总结</option>
                        <option value="detailed">详细 — 完整情节梳理</option>
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
                    <label for="as_include_prev">在上下文中包含之前的总结</label>
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

                <div class="as-buttons">
                    <button id="as_btn_summarize" title="立即总结当前对话">⚡ 立即总结</button>
                    <button id="as_btn_history" title="查看历史总结">📋 历史记录</button>
                    <button id="as_btn_reset" title="重置计数器">🔄 重置计数</button>
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

        // 将 config 写入 UI
        writeUIConfig();
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

        // ===== 预设芯片 =====
        $('#as_presets').on('click', '.as-chip', function () {
            const preset = $(this).data('preset');
            const p = PRESETS[preset];
            if (!p) return;

            config.apiPreset = preset;
            config.apiPrefix = p.prefix;
            config.apiUrl = p.url;
            config.model = p.model;
            // 不覆盖 apiKey

            $('#as_url_prefix').text(p.prefix);
            $('#as_api_url').val(p.url);
            $('#as_model').val(p.model);

            $('.as-chip').removeClass('active');
            $(this).addClass('active');
            saveConfig();
            setTestResult('');
            log('切换预设:', preset);
        });

        // API 输入变化
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

        // URL 前缀切换
        $('#as_url_prefix').on('click', function () {
            const current = $(this).text().trim();
            const next = current === 'https://' ? 'http://' : 'https://';
            $(this).text(next);
            config.apiPrefix = next;
            saveConfig();
        });

        // ===== 测试连接 =====
        $('#as_btn_test').on('click', async function () {
            const btn = $(this);
            btn.prop('disabled', true);
            setTestResult('测试中...');

            try {
                readUIConfig();
                const fullUrl = config.apiPrefix + config.apiUrl;
                const result = await testAPIConnection(fullUrl, config.apiKey, config.model);
                setTestResult('✓ 连接成功！模型: ' + result, 'success');
            } catch (e) {
                setTestResult('✗ ' + (e.message || e), 'error');
            } finally {
                btn.prop('disabled', false);
            }
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

        // 立即总结
        $('#as_btn_summarize').on('click', async function () {
            if (isProcessing) {
                setStatus('正在处理中，请稍候...', 'error');
                return;
            }
            readUIConfig();
            if (!config.apiUrl || !config.apiKey || !config.model) {
                setStatus('请先填写 API 地址、Key 和模型名称', 'error');
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

        // 历史记录
        $('#as_btn_history').on('click', () => showHistoryModal());

        // 重置计数
        $('#as_btn_reset').on('click', function () {
            messageCounter = 0;
            updateCounterDisplay();
            setStatus('计数器已重置');
        });
    }

    // ========== API 测试 ==========

    async function testAPIConnection(url, apiKey, model) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

        const body = {
            model: model,
            messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
            max_tokens: 10,
            temperature: 0
        };

        const resp = await $.ajax({
            url: url,
            type: 'POST',
            contentType: 'application/json',
            headers: headers,
            data: JSON.stringify(body),
            timeout: 15000
        });

        // 解析返回的模型名
        let modelName = model;
        if (resp.model) modelName = resp.model;
        if (resp.choices && resp.choices[0]?.model) modelName = resp.choices[0].model;

        return modelName;
    }

    // ========== 消息计数与事件监听 ==========

    function countExistingMessages() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        let count = 0;
        for (const msg of chat) {
            if (!msg.is_system && (msg.is_user || (!msg.is_user && !msg.is_system))) {
                count++;
            }
        }
        messageCounter = Math.floor(count / 2);
        updateCounterDisplay();
    }

    function checkAndSummarize() {
        if (!config.enabled || isProcessing) return;
        if (!config.apiUrl || !config.apiKey || !config.model) return;
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

    function bindEvents() {
        if (eventBound) return;

        const ctx = getContext();
        const es = ctx.eventSource;

        if (es && typeof es.on === 'function') {
            const messageEvents = ['messageReceived', 'messageSent', 'MESSAGE_RECEIVED', 'MESSAGE_SENT'];
            for (const evtName of messageEvents) {
                try {
                    es.on(evtName, function () {
                        setTimeout(() => {
                            messageCounter++;
                            updateCounterDisplay();
                            log(`事件 ${evtName}，计数: ${messageCounter}`);
                            checkAndSummarize();
                        }, 500);
                    });
                    log(`已绑定: ${evtName}`);
                } catch (e) { /* 事件不存在 */ }
            }

            const chatEvents = ['chatLoaded', 'CHAT_CHANGED', 'chatChanged'];
            for (const evtName of chatEvents) {
                try {
                    es.on(evtName, function () {
                        setTimeout(() => {
                            countExistingMessages();
                            log(`聊天切换: ${evtName}`);
                        }, 1000);
                    });
                    log(`已绑定: ${evtName}`);
                } catch (e) { /* 事件不存在 */ }
            }

            eventBound = true;
        } else {
            logWarn('eventSource 不可用，使用 DOM Observer');
            startDOMObserver();
        }
    }

    function startDOMObserver() {
        const chatEl = document.getElementById('chat') || document.querySelector('.mes');
        if (!chatEl) {
            logWarn('找不到聊天容器');
            return;
        }
        const target = chatEl.parentElement || chatEl;
        const observer = new MutationObserver(function (mutations) {
            let hasNew = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && node.classList && node.classList.contains('mes')) {
                        hasNew = true;
                        break;
                    }
                }
                if (hasNew) break;
            }
            if (hasNew) {
                messageCounter++;
                updateCounterDisplay();
                checkAndSummarize();
            }
        });
        observer.observe(target, { childList: true, subtree: true });
        log('DOM Observer 已启动');
    }

    // ========== 总结生成 ==========

    function getSystemPrompt() {
        if (config.style === 'custom' && config.customPrompt && config.customPrompt.trim()) {
            return config.customPrompt.trim();
        }
        return STYLE_PROMPTS[config.style] || STYLE_PROMPTS.normal;
    }

    function getLastSummary() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata || {}).auto_summaries || [];
        return summaries.length > 0 ? summaries[summaries.length - 1] : null;
    }

    async function saveSummary(text) {
        const ctx = getContext();
        if (!ctx.chat_metadata) ctx.chat_metadata = {};
        if (!ctx.chat_metadata.auto_summaries) ctx.chat_metadata.auto_summaries = [];

        ctx.chat_metadata.auto_summaries.push({
            text: text,
            timestamp: Date.now(),
            messageRange: (ctx.chat || []).length,
            style: config.style,
            model: config.model
        });

        try {
            if (typeof ctx.saveMetadata === 'function') {
                await ctx.saveMetadata();
            } else if (typeof saveMetadata === 'function') {
                await saveMetadata();
            }
            log('总结已保存');
        } catch (e) {
            logWarn('保存元数据失败:', e);
        }
    }

    function buildConversationText() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const name1 = ctx.name1 || 'User';
        const name2 = ctx.name2 || 'Character';

        const startIdx = Math.max(0, chat.length - config.contextMessages);
        const recentMessages = chat.slice(startIdx);

        let text = '';
        for (const msg of recentMessages) {
            const sender = msg.is_user ? name1 : (msg.name || name2);
            text += `${sender}: ${msg.mes || ''}\n\n`;
        }

        if (config.includePreviousSummary) {
            const last = getLastSummary();
            if (last) {
                text = `[之前的对话总结]\n${last.text}\n\n[新的对话内容]\n${text}`;
            }
        }

        return text.trim();
    }

    /**
     * 核心：直接调用用户配置的 API
     */
    async function callLLM(systemPrompt, userContent) {
        const fullUrl = config.apiPrefix + config.apiUrl;

        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) {
            headers['Authorization'] = 'Bearer ' + config.apiKey;
        }

        const body = {
            model: config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            max_tokens: config.maxTokens,
            temperature: 0.3,
            stream: false
        };

        log('请求 URL:', fullUrl);
        log('请求模型:', config.model);
        log('消息长度:', userContent.length, '字符');

        let response;
        try {
            response = await $.ajax({
                url: fullUrl,
                type: 'POST',
                contentType: 'application/json',
                headers: headers,
                data: JSON.stringify(body),
                timeout: 120000
            });
        } catch (xhr) {
            let errMsg = '未知错误';
            if (xhr.responseJSON) {
                const err = xhr.responseJSON.error || xhr.responseJSON;
                errMsg = err.message || err.error || JSON.stringify(err);
            } else if (xhr.statusText) {
                errMsg = xhr.status + ' ' + xhr.statusText;
            }
            throw new Error('API 请求失败: ' + errMsg);
        }

        // 解析响应 — 兼容多种格式
        if (typeof response === 'string') {
            return response.trim();
        }

        // OpenAI 格式: choices[0].message.content
        if (response.choices && response.choices[0]) {
            const choice = response.choices[0];
            let content = choice.message?.content || choice.text || '';
            // 处理数组格式的 content (某些多模态模型)
            if (Array.isArray(content)) {
                content = content.map(c => (typeof c === 'string' ? c : c.text || '')).join('');
            }
            return content.trim();
        }

        // Anthropic 格式: content[0].text
        if (response.content && Array.isArray(response.content)) {
            return response.content.map(c => c.text || '').join('').trim();
        }

        // 简单格式: output / result / response
        for (const key of ['output', 'result', 'response', 'reply', 'answer']) {
            if (response[key] && typeof response[key] === 'string') {
                return response[key].trim();
            }
        }

        throw new Error('无法解析 API 响应格式: ' + JSON.stringify(response).slice(0, 200));
    }

    async function generateSummary() {
        if (isProcessing) throw new Error('正在处理中');

        const ctx = getContext();
        const chat = ctx.chat || [];

        if (chat.length < 2) {
            setStatus('对话太少，跳过总结');
            return;
        }

        if (!config.apiUrl || !config.apiKey || !config.model) {
            throw new Error('请先配置 API 地址、Key 和模型');
        }

        isProcessing = true;
        setStatus('正在生成总结...');
        $('#as_btn_summarize').prop('disabled', true);

        try {
            const systemPrompt = getSystemPrompt();
            const conversationText = buildConversationText();

            if (!conversationText) {
                setStatus('没有可总结的内容');
                return;
            }

            log('开始生成总结...');
            const summary = await callLLM(systemPrompt, conversationText);

            if (summary && summary.trim()) {
                await saveSummary(summary.trim());
                setStatus('总结完成！', 'success');
                log('总结结果:', summary.trim().slice(0, 100) + '...');
                setTimeout(() => {
                    if ($('#as_status').hasClass('success')) setStatus('');
                }, 4000);
            } else {
                setStatus('AI 返回了空内容', 'error');
            }
        } finally {
            isProcessing = false;
            $('#as_btn_summarize').prop('disabled', false);
        }
    }

    // ========== 历史记录弹窗 ==========

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function showHistoryModal() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata || {}).auto_summaries || [];

        $('.as-modal-overlay').remove();

        let entriesHtml = '';
        if (summaries.length === 0) {
            entriesHtml = '<div class="as-modal-empty">暂无总结记录</div>';
        } else {
            for (let i = summaries.length - 1; i >= 0; i--) {
                const s = summaries[i];
                const time = new Date(s.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                });
                const modelTag = s.model ? ` · ${s.model}` : '';
                entriesHtml += `
                <div class="as-summary-entry">
                    <div class="entry-meta">
                        <span>#${i + 1} · ${time}${modelTag}</span>
                        <span>${s.style || 'normal'}</span>
                    </div>
                    <div class="entry-text">${escapeHtml(s.text)}</div>
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
                <div class="as-modal-body">${entriesHtml}</div>
                <div class="as-modal-footer">
                    <button id="as_export_summaries">导出全部</button>
                    <button id="as_clear_summaries" class="danger">清除全部</button>
                </div>
            </div>
        </div>`);

        $('body').append(modal);

        $('#as_modal_close').on('click', () => modal.remove());
        modal.on('click', function (e) { if (e.target === this) $(this).remove(); });

        $('#as_export_summaries').on('click', function () {
            if (summaries.length === 0) { alert('没有可导出的总结'); return; }
            let md = '# 对话总结记录\n\n';
            summaries.forEach((s, i) => {
                md += `## #${i + 1} (${new Date(s.timestamp).toLocaleString('zh-CN')})\n\n${s.text}\n\n---\n\n`;
            });
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `summaries_${Date.now()}.md`;
            a.click();
            URL.revokeObjectURL(url);
        });

        $('#as_clear_summaries').on('click', async function () {
            if (!confirm('确定清除所有总结？')) return;
            if (ctx.chat_metadata) {
                ctx.chat_metadata.auto_summaries = [];
                if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
            }
            modal.remove();
            setStatus('已清除所有总结');
        });
    }

    // ========== 初始化 ==========

    async function init() {
        try {
            if (typeof $ === 'undefined') {
                await sleep(1000);
                return init();
            }

            loadConfig();
            buildUI();

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
