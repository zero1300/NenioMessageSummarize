/**
 * Auto Summary Extension for SillyTavern v1.2
 *
 * - 手动配置 API 地址 / Key / 模型
 * - 楼层统计与已总结范围追踪
 * - 总结前弹窗确认
 * - 世界书自动写入（Summary_角色名_日期_序号）
 */
// ========== 调试：输出世界书信息 ==========
window._asDebugWorldInfo = function () {
    const ctx = getContext();
    console.log('=== 世界书调试信息 ===');
    console.log('context.worldinfo:', ctx.worldinfo);
    console.log('world_info (global):', typeof world_info !== 'undefined' ? world_info : '未定义');
    console.log('world_info_data (global):', typeof world_info_data !== 'undefined' ? world_info_data : '未定义');
    console.log('context.characters[chid]:', ctx.characters?.[ctx.this_chid]);
    console.log('event_types:', typeof event_types !== 'undefined' ? event_types : '未定义');
    console.log('======================');
};

(function () {
    'use strict';

    const EXT_NAME = 'auto-summary';
    const LOG_PREFIX = '[AutoSummary]';

    // ========== 内置提示词 ==========
    const STYLE_PROMPTS = {
        brief: '请用 1-2 句话简明扼要地总结以下对话的核心内容。只输出总结，不要多余的话。',
        normal: '请用一个简短的段落总结以下对话。包括：主要事件、角色行动、情感变化和当前情境。只输出总结。',
        detailed: '请详细总结以下对话。包括：\n1. 主要情节发展\n2. 角色的行动与决定\n3. 角色间的关系变化\n4. 当前场景与氛围\n5. 重要的未解事项\n只输出总结。'
    };

    // ========== API 预设 ==========
    const PRESETS = {
        openai: { url: 'api.openai.com/v1/chat/completions', prefix: 'https://', model: 'gpt-4o-mini' },
        openrouter: { url: 'openrouter.ai/api/v1/chat/completions', prefix: 'https://', model: 'openai/gpt-4o-mini' },
        deepseek: { url: 'api.deepseek.com/v1/chat/completions', prefix: 'https://', model: 'deepseek-chat' },
        moonshot: { url: 'api.moonshot.cn/v1/chat/completions', prefix: 'https://', model: 'moonshot-v1-8k' },
        glm: { url: 'open.bigmodel.cn/api/paas/v4/chat/completions', prefix: 'https://', model: 'glm-4-flash' },
        ollama: { url: '127.0.0.1:11434/v1/chat/completions', prefix: 'http://', model: 'qwen2.5:7b' },
        custom: { url: '', prefix: 'https://', model: '' }
    };

    // ========== 全局状态 ==========
    let config = {};
    let messageCounter = 0;
    let isProcessing = false;
    let isConfirming = false;
    let eventBound = false;
    let autoSummarizePaused = false;

    // ========== 工具 ==========

    let _cachedCtx = null;

    function getContext() {
        if (_cachedCtx) return _cachedCtx;

        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            _cachedCtx = SillyTavern.getContext();
        } else {
            _cachedCtx = {
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

        // 确保关键字段始终存在
        if (!_cachedCtx.chat_metadata) {
            _cachedCtx.chat_metadata = {};
        }
        if (!_cachedCtx.chat_metadata.auto_summaries) {
            _cachedCtx.chat_metadata.auto_summaries = [];
        }

        return _cachedCtx;
    }

    function log(...a) { console.log(LOG_PREFIX, ...a); }
    function logWarn(...a) { console.warn(LOG_PREFIX, ...a); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    function escapeHtml(t) {
        const d = document.createElement('div');
        d.textContent = t;
        return d.innerHTML;
    }

    // ========== 楼层统计 ==========

    /** 获取所有真实消息（非系统消息）的索引 */
    function getRealMessageIndices() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const indices = [];
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i].is_system) indices.push(i);
        }
        return indices;
    }

    /** 获取当前角色名 */
    function getCharacterName() {
        const ctx = getContext();
        if (ctx.characters && ctx.this_chid !== undefined && ctx.characters[ctx.this_chid]) {
            return ctx.characters[ctx.this_chid].name || 'Unknown';
        }
        return ctx.name2 || 'Unknown';
    }

    /** 计算已总结的消息总数 */
    function getSummarizedCount() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata || {}).auto_summaries || [];
        let total = 0;
        for (const s of summaries) {
            total += (s.messageRange || 0);
        }
        return total;
    }

    /** 获取已总结到的最大消息索引 */
    function getLastSummarizedIndex() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata && ctx.chat_metadata.auto_summaries) || [];
        if (summaries.length === 0) return -1;
        const last = summaries[summaries.length - 1];
        return (last.endIndex !== undefined) ? last.endIndex : -1;
    }

    function updateStats() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const summaries = (ctx.chat_metadata && ctx.chat_metadata.auto_summaries) || [];

        const totalMsg = chat.length;
        const realIndices = getRealMessageIndices();
        const totalReal = realIndices.length;

        let summarizedReal = 0;
        for (const s of summaries) {
            summarizedReal += (s.messageRange || 0);
        }
        const unsavedReal = Math.max(0, totalReal - summarizedReal);
        const recordCount = summaries.length;
        const percent = totalReal > 0 ? Math.round((summarizedReal / totalReal) * 100) : 0;

        $('#as_stat_total').text(totalReal);
        $('#as_stat_summarized').text(summarizedReal);
        $('#as_stat_unsaved').text(unsavedReal);
        $('#as_stat_records').text(recordCount);
        $('#as_progress_fill').css('width', percent + '%');
        $('#as_progress_text').text(percent + '% 已总结');

        updateWorldBookInfo();
    }


    function updateWorldBookInfo() {
        try {
            const charName = getCharacterName();
            const ctx = getContext();
            const summaries = (ctx.chat_metadata && ctx.chat_metadata.auto_summaries) || [];
            const nextNum = String(summaries.length + 1).padStart(3, '0');
            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const wbName = `Summary_${charName}_${date}_${nextNum}`;
            $('#as_wb_info').html(`命名格式: <strong>${escapeHtml(wbName)}</strong>`);
        } catch (e) { }
    }


    function updateCounterDisplay() {
        const el = document.getElementById('as_counter');
        if (el) el.textContent = `已计数: ${messageCounter} / ${config.frequency} 轮`;
    }


    // ========== 配置 ==========

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
            worldBookEnabled: true
        };
    }

    function loadConfig() {
        const ctx = getContext();
        if (!ctx.extensionSettings[EXT_NAME]) ctx.extensionSettings[EXT_NAME] = {};
        config = Object.assign(getDefaultConfig(), ctx.extensionSettings[EXT_NAME]);
        log('配置已加载');
    }

    function saveConfig() {
        const ctx = getContext();
        ctx.extensionSettings[EXT_NAME] = { ...config };
        if (ctx.saveSettingsDebounced) ctx.saveSettingsDebounced();
    }

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

    // ========== UI ==========

    function buildUI() {
        const html = `
        <div id="auto_summary_panel" class="auto-summary-panel">
            <h4>
                <span class="panel-toggle" id="as_panel_toggle">▼</span>
                📝 自动总结
            </h4>
            <div class="as-body" id="as_body">

                <!-- 楼层统计 -->
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

                <!-- 启用 -->
                <div class="as-toggle-row">
                    <label for="as_enabled">启用自动总结</label>
                    <div class="as-switch">
                        <input type="checkbox" id="as_enabled">
                        <span class="slider"></span>
                    </div>
                </div>

                <hr class="as-divider">

                <!-- API -->
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
                    <label for="as_frequency">自动触发频率（每 N 轮）</label>
                    <div class="as-slider-row">
                        <input type="range" id="as_frequency" min="1" max="50" value="${config.frequency}" step="1">
                        <span class="as-slider-val" id="as_frequency_val">${config.frequency}</span>
                    </div>
                </div>
                <div class="as-control">
                    <label for="as_style">总结风格</label>
                    <select id="as_style">
                        <option value="brief">简短 — 一句话概括</option>
                        <option value="normal">标准 — 段落式总结</option>
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

                <!-- 世界书 -->
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

                <!-- 操作按钮 -->
                <div class="as-buttons" id="as_action_buttons">
                    <button id="as_btn_summarize" class="as-btn-primary">⚡ 立即总结</button>
                    <button id="as_btn_history">📋 历史记录</button>
                    <button id="as_btn_reset">🔄 重置</button>
                </div>

                <!-- 确认区域 -->
                <div class="as-confirm-section" id="as_confirm_section" style="display:none;">
                    <div class="as-confirm-title">⚡ 确认总结操作</div>
                    <div class="as-confirm-info" id="as_confirm_info"></div>
                    <div class="as-control">
                        <label for="as_confirm_range">从第 N 条消息开始总结</label>
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
        updateStats();
    }

    // ========== UI 事件绑定 ==========

    function bindUIEvents() {
        // 折叠
        $('#as_panel_toggle').on('click', function () {
            $(this).toggleClass('collapsed');
            $('#as_body').toggleClass('collapsed');
        });

        // 启用
        $('#as_enabled').on('change', function () {
            config.enabled = this.checked;
            saveConfig();
            setStatus(config.enabled ? '已启用' : '已禁用');
        });

        // 预设
        $('#as_presets').on('click', '.as-chip', function () {
            const p = PRESETS[$(this).data('preset')];
            if (!p) return;
            config.apiPreset = $(this).data('preset');
            config.apiPrefix = p.prefix;
            config.apiUrl = p.url;
            config.model = p.model;
            $('#as_url_prefix').text(p.prefix);
            $('#as_api_url').val(p.url);
            $('#as_model').val(p.model);
            $('.as-chip').removeClass('active');
            $(this).addClass('active');
            saveConfig();
            setTestResult('');
        });

        // API 输入
        $('#as_api_url').on('input', function () {
            config.apiUrl = this.value.trim();
            config.apiPreset = 'custom';
            $('.as-chip').removeClass('active');
            $('.as-chip[data-preset="custom"]').addClass('active');
            saveConfig();
        });

        $('#as_api_key').on('input', function () { config.apiKey = this.value.trim(); saveConfig(); });
        $('#as_model').on('input', function () { config.model = this.value.trim(); saveConfig(); });

        // URL 前缀
        $('#as_url_prefix').on('click', function () {
            const next = $(this).text().trim() === 'https://' ? 'http://' : 'https://';
            $(this).text(next);
            config.apiPrefix = next;
            saveConfig();
        });

        // 测试
        $('#as_btn_test').on('click', async function () {
            const btn = $(this);
            btn.prop('disabled', true);
            setTestResult('测试中...');
            try {
                readUIConfig();
                const result = await testAPIConnection(config.apiPrefix + config.apiUrl, config.apiKey, config.model);
                setTestResult('✓ 连接成功: ' + result, 'success');
            } catch (e) {
                setTestResult('✗ ' + (e.message || e), 'error');
            } finally {
                btn.prop('disabled', false);
            }
        });

        // 滑块
        $('#as_frequency').on('input', function () {
            config.frequency = parseInt(this.value) || 10;
            $('#as_frequency_val').text(config.frequency);
            saveConfig();
            updateCounterDisplay();
        });
        $('#as_max_tokens').on('input', function () {
            config.maxTokens = parseInt(this.value) || 300;
            $('#as_max_tokens_val').text(config.maxTokens);
            saveConfig();
        });
        $('#as_context_messages').on('input', function () {
            config.contextMessages = parseInt(this.value) || 30;
            $('#as_context_messages_val').text(config.contextMessages);
            saveConfig();
        });

        // 风格
        $('#as_style').on('change', function () {
            config.style = this.value;
            $('#as_custom_prompt_wrap').css('display', config.style === 'custom' ? 'flex' : 'none');
            saveConfig();
        });
        $('#as_custom_prompt').on('input', function () { config.customPrompt = this.value; saveConfig(); });
        $('#as_include_prev').on('change', function () { config.includePreviousSummary = this.checked; saveConfig(); });

        // 世界书
        $('#as_wb_enabled').on('change', function () { config.worldBookEnabled = this.checked; saveConfig(); });

        // ===== 立即总结 → 弹出确认 =====
        $('#as_btn_summarize').on('click', function () {
            if (isProcessing || isConfirming) return;
            readUIConfig();
            if (!config.apiUrl || !config.apiKey || !config.model) {
                setStatus('请先配置 API 地址、Key 和模型', 'error');
                return;
            }
            showConfirm();
        });

        // 确认 - 执行
        $('#as_btn_confirm_yes').on('click', async function () {
            if (isProcessing) return;
            hideConfirm();
            autoSummarizePaused = false;
            try {
                await executeSummary();
                messageCounter = 0;
                updateCounterDisplay();
                updateStats();
            } catch (err) {
                logWarn('总结失败:', err);
                setStatus('总结失败: ' + (err.message || err), 'error');
            }
        });

        // 确认 - 取消
        $('#as_btn_confirm_no').on('click', function () {
            hideConfirm();
            autoSummarizePaused = false;
            setStatus('已取消');
        });

        // 确认 - 范围滑块
        $('#as_confirm_range').on('input', function () {
            updateConfirmRangeLabel();
        });

        // 历史
        $('#as_btn_history').on('click', () => showHistoryModal());

        // 重置
        $('#as_btn_reset').on('click', function () {
            messageCounter = 0;
            updateCounterDisplay();
            setStatus('计数器已重置');
        });
    }

    // ========== 确认弹窗 ==========

    function showConfirm() {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const realIndices = getRealMessageIndices();
        const lastIdx = getLastSummarizedIndex();

        // 计算默认开始位置
        const defaultStart = Math.max(0, realIndices.length - config.contextMessages);
        const minStart = lastIdx >= 0 ? realIndices.findIndex(i => i > lastIdx) : 0;
        const validMin = Math.max(0, minStart);

        // 设置滑块
        const slider = $('#as_confirm_range');
        slider.attr('min', validMin);
        slider.attr('max', realIndices.length);
        slider.val(defaultStart);
        slider.attr('step', 1);

        // 设置风格
        $('#as_confirm_style').val(config.style);

        // 信息文本
        const charName = getCharacterName();
        const newCount = realIndices.length - validMin;
        let infoHtml = `当前对话: <strong>${realIndices.length}</strong> 条消息`;
        if (lastIdx >= 0) {
            infoHtml += `，已总结至消息 #<strong>${lastIdx + 1}</strong>`;
        }
        infoHtml += `<br>角色: <strong>${escapeHtml(charName)}</strong> · 新消息: <strong>${newCount}</strong> 条`;

        $('#as_confirm_info').html(infoHtml);

        updateConfirmRangeLabel();

        // 显示
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
        const startIdx = parseInt($('#as_confirm_range').val()) || 0;
        const realIndices = getRealMessageIndices();
        const total = realIndices.length;
        const count = total - startIdx;
        const startMsg = startIdx < realIndices.length ? `#${realIndices[startIdx] + 1}` : '-';
        const endMsg = total > 0 ? `#${realIndices[total - 1] + 1}` : '-';
        $('#as_confirm_range_val').text(`${startMsg} → ${endMsg} (${count}条)`);
    }

    // ========== API ==========

    async function testAPIConnection(url, apiKey, model) {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

        const resp = await $.ajax({
            url,
            type: 'POST',
            contentType: 'application/json',
            headers,
            data: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Reply with "OK" only.' }],
                max_tokens: 10,
                temperature: 0
            }),
            timeout: 15000
        });

        return resp.model || model;
    }

    async function callLLM(systemPrompt, userContent) {
        const fullUrl = config.apiPrefix + config.apiUrl;
        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['Authorization'] = 'Bearer ' + config.apiKey;

        log('请求:', fullUrl, '| 模型:', config.model);

        let response;
        try {
            response = await $.ajax({
                url: fullUrl,
                type: 'POST',
                contentType: 'application/json',
                headers,
                data: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent }
                    ],
                    max_tokens: config.maxTokens,
                    temperature: 0.3,
                    stream: false
                }),
                timeout: 120000
            });
        } catch (xhr) {
            let errMsg = '未知错误';
            if (xhr.responseJSON) {
                const e = xhr.responseJSON.error || xhr.responseJSON;
                errMsg = e.message || e.error || JSON.stringify(e);
            } else if (xhr.statusText) {
                errMsg = xhr.status + ' ' + xhr.statusText;
            }
            throw new Error('API 请求失败: ' + errMsg);
        }

        if (typeof response === 'string') return response.trim();
        if (response.choices && response.choices[0]) {
            let c = response.choices[0].message?.content || response.choices[0].text || '';
            if (Array.isArray(c)) c = c.map(x => typeof x === 'string' ? x : x.text || '').join('');
            return c.trim();
        }
        if (response.content && Array.isArray(response.content)) {
            return response.content.map(c => c.text || '').join('').trim();
        }
        for (const k of ['output', 'result', 'response', 'reply', 'answer']) {
            if (response[k] && typeof response[k] === 'string') return response[k].trim();
        }
        throw new Error('无法解析响应: ' + JSON.stringify(response).slice(0, 200));
    }

    // ========== 消息内容构建 ==========

    function buildConversationText(startMsgIndex) {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const name1 = ctx.name1 || 'User';
        const name2 = ctx.name2 || 'Character';

        const startIdx = (startMsgIndex !== undefined) ? startMsgIndex : Math.max(0, chat.length - config.contextMessages);
        const messages = chat.slice(startIdx);

        let text = '';
        for (const msg of messages) {
            if (msg.is_system) continue;
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

    function getSystemPrompt() {
        if (config.style === 'custom' && config.customPrompt && config.customPrompt.trim()) {
            return config.customPrompt.trim();
        }
        return STYLE_PROMPTS[config.style] || STYLE_PROMPTS.normal;
    }


    function getLastSummary() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata && ctx.chat_metadata.auto_summaries) || [];
        return summaries.length > 0 ? summaries[summaries.length - 1] : null;
    }

    // ========== 世界书 ==========

    /**
    * 创建世界书条目
    * 命名: Summary_角色名_日期_序号
    *
    * 使用 SillyTavern.getContext().worldinfo 操作世界书
    */
    async function createWorldBookEntry(summaryText, summaryIndex) {
        if (!config.worldBookEnabled) return;

        try {
            const ctx = getContext();
            const charName = getCharacterName();
            const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const seq = String(summaryIndex + 1).padStart(3, '0');
            const entryName = `Summary_${charName}_${date}_${seq}`;

            // 关键词
            const keys = [charName, '总结', 'summary'];
            const nameParts = charName.split(/\s+/).filter(p => p.length > 1);
            for (const p of nameParts) {
                if (!keys.includes(p)) keys.push(p);
            }

            const bookName = `AutoSummary_${charName.replace(/\s+/g, '_')}_${date}`;

            // ========================================
            // 第一步：获取世界书对象
            // ========================================
            let worldInfo = null;

            // 方式 A：从 context.worldinfo 获取
            if (ctx.worldinfo) {
                worldInfo = ctx.worldinfo;
                log('从 context.worldinfo 获取到世界书');
            }

            // 方式 B：尝试获取角色绑定的世界书
            if (!worldInfo) {
                const charData = ctx.characters?.[ctx.this_chid];
                if (charData?.data?.extensions?.world) {
                    const boundBook = charData.data.extensions.world;
                    // 尝试通过 ST API 获取世界书数据
                    try {
                        const resp = await $.ajax({
                            url: '/api/worldinfo',
                            type: 'POST',
                            contentType: 'application/json',
                            data: JSON.stringify({ name: boundBook }),
                            timeout: 10000
                        });
                        if (resp && resp.entries) {
                            worldInfo = resp;
                            log('通过 API 获取世界书:', boundBook);
                        }
                    } catch (e) { }
                }
            }

            // 方式 C：全局对象兜底
            if (!worldInfo && typeof world_info !== 'undefined') {
                // 取第一个可用的世界书
                const names = Object.keys(world_info);
                if (names.length > 0) {
                    worldInfo = world_info[names[0]];
                    log('从全局 world_info 获取:', names[0]);
                }
            }

            if (!worldInfo) {
                logWarn('没有找到可用的世界书');
                setStatus('未找到世界书，请先创建一个世界书（总结已保存）', 'error');
                return;
            }

            // ========================================
            // 第二步：创建条目
            // ========================================
            const entry = {
                uid: Date.now(),
                key: keys.join(','),
                keysecondary: '',
                comment: entryName,
                content: `【对话总结 #${seq}】\n${summaryText}`,
                constant: false,
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
                // 兼容字段
                enabled: true,
                keys: keys
            };

            // ========================================
            // 第三步：添加条目到世界书
            // ========================================
            let entryAdded = false;

            // 确保 entries 存在
            if (!worldInfo.entries) {
                worldInfo.entries = [];
            }

            // entries 可能是数组或对象
            if (Array.isArray(worldInfo.entries)) {
                worldInfo.entries.push(entry);
                entryAdded = true;
                log('以数组方式添加条目');
            } else if (typeof worldInfo.entries === 'object') {
                worldInfo.entries[entry.uid] = entry;
                entryAdded = true;
                log('以对象方式添加条目');
            }

            // ========================================
            // 第四步：触发更新
            // ========================================
            if (entryAdded) {
                // 发出世界书更新事件
                const es = ctx.eventSource;
                if (es && typeof es.emit === 'function') {
                    // 尝试多种事件名
                    const eventNames = [
                        'worldinfoUpdated',
                        'WORLDINFO_UPDATED',
                        'worldInfoUpdated',
                        'world_updated'
                    ];
                    for (const evtName of eventNames) {
                        try {
                            es.emit(evtName);
                            log('触发事件:', evtName);
                            break;
                        } catch (e) { }
                    }
                }

                // 同时尝试调用保存函数
                const saveFns = [
                    'saveWorldInfo',
                    'saveWorldInfoData',
                    'saveSettingsDebounced'
                ];
                for (const fnName of saveFns) {
                    if (typeof window[fnName] === 'function') {
                        try {
                            await window[fnName]();
                            log('调用保存函数:', fnName);
                        } catch (e) { }
                    }
                }

                // 记录到总结元数据
                const ctx2 = getContext();
                const summaries = (ctx2.chat_metadata || {}).auto_summaries || [];
                if (summaries.length > 0) {
                    summaries[summaries.length - 1].worldBookName = entryName;
                    summaries[summaries.length - 1].worldBookFile = bookName;
                    summaries[summaries.length - 1].worldBookSaved = true;
                }

                log('世界书条目已创建:', entryName);
            }

        } catch (e) {
            logWarn('世界书操作异常:', e);
        }
    }



    // ========== 保存总结 ==========

    async function saveSummary(text, startIdx, endIdx) {
        const ctx = getContext();

        // 双重保险初始化
        if (!ctx.chat_metadata) ctx.chat_metadata = {};
        if (!ctx.chat_metadata.auto_summaries) ctx.chat_metadata.auto_summaries = [];

        const realInRange = getRealMessageIndices().filter(i => i >= startIdx && i <= endIdx);

        ctx.chat_metadata.auto_summaries.push({
            text: text,
            timestamp: Date.now(),
            startIndex: startIdx,
            endIndex: endIdx,
            messageRange: realInRange.length,
            style: config.style,
            model: config.model,
            worldBookName: null,
            worldBookFile: null
        });

        try {
            if (typeof ctx.saveMetadata === 'function') {
                await ctx.saveMetadata();
            } else if (typeof saveMetadata === 'function') {
                await saveMetadata();
            }
            log('总结已保存, 范围:', startIdx, '-', endIdx, '(' + realInRange.length + '条)');
        } catch (e) {
            logWarn('保存元数据失败:', e);
        }
    }


    // ========== 执行总结 ==========

    async function executeSummary(startMsgIndex, style) {
        if (isProcessing) throw new Error('正在处理中');

        const ctx = getContext();
        const chat = ctx.chat || [];
        if (chat.length < 2) {
            setStatus('对话太少，跳过总结');
            return;
        }
        if (!config.apiUrl || !config.apiKey || !config.model) {
            throw new Error('请先配置 API');
        }

        // 确定范围
        const realIndices = getRealMessageIndices();
        const lastIdx = getLastSummarizedIndex();
        const validStart = lastIdx >= 0 ? realIndices.findIndex(i => i > lastIdx) : 0;
        const startIdx = (startMsgIndex !== undefined && startMsgIndex >= 0)
            ? startMsgIndex
            : Math.max(validStart, realIndices.length - config.contextMessages);
        const endIdx = chat.length - 1;

        // 临时覆盖风格
        const origStyle = config.style;
        if (style) config.style = style;

        isProcessing = true;
        setStatus('正在生成总结...');
        $('#as_btn_summarize').prop('disabled', true);

        try {
            const systemPrompt = getSystemPrompt();
            const text = buildConversationText(startIdx);

            if (!text) {
                setStatus('没有可总结的内容');
                return;
            }

            log('总结范围: 消息', startIdx, '-', endIdx);
            const summary = await callLLM(systemPrompt, text);

            if (!summary || !summary.trim()) {
                setStatus('AI 返回了空内容', 'error');
                return;
            }

            await saveSummary(summary.trim(), startIdx, endIdx);

            // 写入世界书
            const ctx2 = getContext();
            const summaryIndex = (ctx2.chat_metadata.auto_summaries || []).length - 1;
            await createWorldBookEntry(summary.trim(), summaryIndex);

            setStatus('总结完成！', 'success');
            updateStats();

            setTimeout(() => {
                if ($('#as_status').hasClass('success')) setStatus('');
            }, 4000);
        } finally {
            isProcessing = false;
            config.style = origStyle;
            $('#as_btn_summarize').prop('disabled', false);
        }
    }

    // ========== 事件监听 ==========

    function checkAndSummarize() {
        if (!config.enabled || isProcessing || isConfirming || autoSummarizePaused) return;
        if (!config.apiUrl || !config.apiKey || !config.model) return;
        if (messageCounter >= config.frequency) {
            log(`达到触发条件 (${messageCounter} >= ${config.frequency})`);
            messageCounter = 0;
            updateCounterDisplay();
            // 自动总结也弹确认
            showConfirm();
        }
    }

    function bindEvents() {
        if (eventBound) return;
        const ctx = getContext();
        const es = ctx.eventSource;

        if (es && typeof es.on === 'function') {
            for (const evt of ['messageReceived', 'messageSent', 'MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
                try {
                    es.on(evt, () => {
                        setTimeout(() => {
                            messageCounter++;
                            updateCounterDisplay();
                            updateStats();
                            checkAndSummarize();
                        }, 500);
                    });
                    log('绑定:', evt);
                } catch (e) { }
            }
            for (const evt of ['chatLoaded', 'CHAT_CHANGED', 'chatChanged']) {
                try {
                    es.on(evt, () => {
                        setTimeout(() => {
                            messageCounter = 0;
                            updateCounterDisplay();
                            updateStats();
                            log('聊天切换:', evt);
                        }, 1000);
                    });
                    log('绑定:', evt);
                } catch (e) { }
            }
            eventBound = true;
        } else {
            logWarn('eventSource 不可用，使用 DOM Observer');
            startDOMObserver();
        }
    }

    function startDOMObserver() {
        const el = document.getElementById('chat') || document.querySelector('.mes');
        if (!el) return;
        const target = el.parentElement || el;
        new MutationObserver(function (mutations) {
            let hasNew = false;
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1 && n.classList && n.classList.contains('mes')) {
                        hasNew = true; break;
                    }
                }
                if (hasNew) break;
            }
            if (hasNew) {
                messageCounter++;
                updateCounterDisplay();
                updateStats();
                checkAndSummarize();
            }
        }).observe(target, { childList: true, subtree: true });
        log('DOM Observer 已启动');
    }

    // ========== 历史弹窗 ==========

    function showHistoryModal() {
        const ctx = getContext();
        const summaries = (ctx.chat_metadata || {}).auto_summaries || [];
        $('.as-modal-overlay').remove();

        let entries = '';
        if (summaries.length === 0) {
            entries = '<div class="as-modal-empty">暂无总结记录</div>';
        } else {
            for (let i = summaries.length - 1; i >= 0; i--) {
                const s = summaries[i];
                const time = new Date(s.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                });
                const rangeStr = (s.startIndex !== undefined && s.endIndex !== undefined)
                    ? `消息 #${s.startIndex + 1} - #${s.endIndex + 1} (${s.messageRange || '?'}条)`
                    : `${s.messageRange || '?'}条消息`;
                const modelTag = s.model ? ` · ${s.model}` : '';
                const wbTag = s.worldBookName
                    ? `<div class="entry-wb">📖 ${escapeHtml(s.worldBookName)}</div>`
                    : '';

                entries += `
                <div class="as-summary-entry">
                    <div class="entry-meta">
                        <span>#${i + 1} · ${time}${modelTag}</span>
                        <span class="entry-range">${rangeStr}</span>
                    </div>
                    <div class="entry-text">${escapeHtml(s.text)}</div>
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
        modal.on('click', function (e) { if (e.target === this) $(this).remove(); });

        $('#as_export_summaries').on('click', function () {
            if (summaries.length === 0) { alert('没有可导出的总结'); return; }
            let md = '# 对话总结记录\n\n';
            summaries.forEach((s, i) => {
                const time = new Date(s.timestamp).toLocaleString('zh-CN');
                const range = (s.startIndex !== undefined)
                    ? `消息 #${s.startIndex + 1} - #${s.endIndex + 1}`
                    : '';
                md += `## #${i + 1} (${time}) ${range}\n\n${s.text}\n\n---\n\n`;
            });
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `summaries_${Date.now()}.md`;
            a.click();
        });

        $('#as_clear_summaries').on('click', async function () {
            if (!confirm('确定清除所有总结？此操作不可撤销。')) return;
            const ctx2 = getContext();
            if (ctx2.chat_metadata) {
                ctx2.chat_metadata.auto_summaries = [];
                if (typeof ctx2.saveMetadata === 'function') await ctx2.saveMetadata();
            }
            modal.remove();
            updateStats();
            setStatus('已清除所有总结');
        });
    }

    // ========== 初始化 ==========

    async function init() {
        try {
            if (typeof $ === 'undefined') { await sleep(1000); return init(); }

            loadConfig();
            buildUI();

            await sleep(2000);
            bindEvents();

            // 重新计数
            messageCounter = 0;
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
