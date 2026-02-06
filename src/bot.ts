import { Telegraf, Context } from 'telegraf';
import { DatabaseService } from './supabase';
import { GeminiService } from './gemini';
import { Env } from './types';

export function createBot(env: Env, db: DatabaseService, gemini: GeminiService, whitelistCache: Map<number, any>) {
    const bot = new Telegraf(env.TG_TOKEN);

    // 向量缓存：存储最近 30 条处理过的向量（所有消息）
    type CachedVector = { embedding: number[] | null; timestamp: number };
    const recentVectors: CachedVector[] = [];
    const MAX_CACHE_SIZE = 30;

    /**
     * 计算两个向量的余弦相似度
     */
    const cosineSimilarity = (a: number[], b: number[]): number => {
        if (a.length !== b.length) return 0;
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            magnitudeA += a[i] * a[i];
            magnitudeB += b[i] * b[i];
        }

        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);

        if (magnitudeA === 0 || magnitudeB === 0) return 0;
        return dotProduct / (magnitudeA * magnitudeB);
    };

    /**
     * 在缓存中找到最相似的向量
     * @returns { bestIndex, bestSimilarity }
     */
    const findBestCacheSimilarity = (embedding: number[]): { bestIndex: number; bestSimilarity: number } => {
        let bestIndex = -1;
        let bestSimilarity = 0;

        for (let i = 0; i < recentVectors.length; i++) {
            const cached = recentVectors[i];
            if (!cached.embedding) continue;

            const similarity = cosineSimilarity(embedding, cached.embedding);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestIndex = i;
            }
        }

        return { bestIndex, bestSimilarity };
    };

    /**
     * 获取向量（仅从 Gemini API，不涉及缓存查询）
     */
    const getEmbeddingWithCache = async (text: string, forceRefresh: boolean = false): Promise<number[] | null> => {
        const embedding = await gemini.getEmbedding(text);
        return embedding;
    };

    /**
     * 处理非广告消息的缓存操作
     * 仅当消息不是广告时调用
     */
    const processCacheForNormalMessage = (embedding: number[] | null) => {
        if (!embedding) return;

        // 与缓存中的现有向量比较
        const { bestIndex, bestSimilarity } = findBestCacheSimilarity(embedding);

        if (bestSimilarity >= 0.95) {
            // 相似度 95% 以上，替换最相似的条目
            recentVectors[bestIndex] = { embedding, timestamp: Date.now() };
            console.log(`[向量缓存] 抽換最相似的向量 (相似度: ${bestSimilarity.toFixed(4)})`);
        } else {
            // 无相似条目，添加到缓存（替换最旧的）
            if (recentVectors.length >= MAX_CACHE_SIZE) {
                recentVectors.shift(); // 移除最旧的
                console.log(`[向量缓存] 移除最舊的向量`);
            }
            recentVectors.push({ embedding, timestamp: Date.now() });
            console.log(`[向量缓存] 新增向量 (當前: ${recentVectors.length}/${MAX_CACHE_SIZE})`);
        }
    };

    // 1. 指令區
    setupCommands(bot, db, gemini, env);

    // 1.1 額外測試指令
    bot.command('ping', async (ctx) => {
        await ctx.reply('🏓 Pong! 機器人運作中。\nChat ID: ' + ctx.chat.id + '\nUser ID: ' + ctx.from.id);
    });

    // 1.2 診斷指令：/status
    bot.command('status', async (ctx) => {
        if (ctx.chat.type === 'private') {
            const config = await db.getConfig();
            const statusMsg = `📋 **機器人狀態診斷**:
            
✓ 資料庫連接: 正常
✓ Gemini API: 已配置

當前監控群組數: ${(config.monitored_groups || []).length}
轉發頻道: ${config.forward_channel_id ? '✓ 已設定' : '⚠️ 未設定'}
統計頻道: ${config.stats_channel_id ? '✓ 已設定' : '⚠️ 未設定'}
乾運行模式: ${config.dry_run ? '開啟 (演習模式)' : '正常模式'}

📍 當前群組 ID: ${ctx.chat.id}
👤 您的用戶 ID: ${ctx.from.id}`;
            await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
        } else {
            // 群內檢查
            const config = await db.getConfig();
            const monitoredGroups = config.monitored_groups || [];
            const currentChatId = String(ctx.chat.id);
            const isMonitored = monitoredGroups.includes(currentChatId);
            
            const statusMsg = `📋 **此群組狀態**:
監控狀態: ${isMonitored ? '✅ 監控中' : '❌ 未監控'}
群組 ID: ${ctx.chat.id}
乾運行模式: ${config.dry_run ? '開啟' : '關閉'}`;
            await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
        }
    });

    // 1.3 幫助指令：/help
    bot.command('help', async (ctx) => {
        const helpMsg = `🤖 **SpamKiller 機器人指令說明**

**📟 系統指令**:
/ping - 檢查機器人是否運作
/status - 查看機器人和群組狀態
/help - 顯示此幫助信息

**🛡️ 管理指令** (管理員使用):
/monitor [add|remove|list] [群組ID] - 管理監控群組
  例: /monitor add -1001234567890
  例: /monitor list
  例: /monitor remove -1001234567890
  
/config - 查看和修改機器人設定
  例: /config forward_channel -1001234567890
  例: /config threshold 3
  例: /config dry_run true

/whitelist - 將回覆的用戶加入白名單 (回覆訊息後使用)

/spam - 標記回覆的訊息為廣告並學習 (回覆訊息後使用)

/normal - 標記回覆的訊息為正常訊息 (回覆訊息後使用)

**⚙️ 常見設定任務**:
1️⃣ 設定轉發頻道: /config forward_channel -100123456789
2️⃣ 添加監控群組: /monitor add -100987654321
3️⃣ 查看狀態: /status
4️⃣ 測試連接: /ping

🔗 更多詳情: 在私聊中使用 /config 查看所有可設定選項`;
        await ctx.reply(helpMsg, { parse_mode: 'Markdown' });
    });

    // 2. 核心 Pipeline
    bot.on(['message', 'edited_message'], async (ctx: any, next) => {
        const msg = (ctx.message || ctx.editedMessage) as any;
        if (!msg || !('text' in msg)) return next();

        // 如果是指令，交給指令處理器 (Telegraf 預設會優先處理 command，但這裡保險起見)
        if (msg.text?.startsWith('/')) return next();

        console.log(`Processing message from ${msg.from?.id} in chat ${ctx.chat.id}`);
        if (msg.from?.is_bot) return;

        // [Pre-filter 2] 監控名單檢查
        const config = (ctx as any).state.config || await db.getConfig();
        ctx.state.config = config; // 確保 config 在 context 中

        const monitoredGroups = config.monitored_groups || [];
        const currentChatId = String(ctx.chat.id);

        console.log(`[Monitor Check] Current: ${currentChatId}, List: ${JSON.stringify(monitoredGroups)}`);

        if (!monitoredGroups.includes(currentChatId)) {
            console.log('[Monitor Check] Result: REJECTED (Not in monitor list)');
            return;
        }

        const userId = msg.from.id;
        const text = msg.text;

        // [Pre-filter 3] 白名單 (Cache First)
        let isWhitelisted = false;

        // A. Check Cache
        if (whitelistCache.has(userId)) {
            isWhitelisted = true;
            console.log(`[Whitelist] Cache Hit: ${userId}`);
        } else {
            // B. Check DB
            const inDb = await db.isWhitelisted(userId);
            if (inDb) {
                isWhitelisted = true;
                whitelistCache.set(userId, { userId, timestamp: Date.now() });
                console.log(`[Whitelist] DB Hit: ${userId}`);
            }
        }

        if (isWhitelisted) {
            console.log('[Whitelist] Result: SKIP (User is whitelisted)');
            return;
        }

        // [Judgment]
        let isSpam = false;
        let reason = '';
        let similarity = 0;
        let judgmentSource = '';
        
        // 獲取向量（直接從 Gemini API）
        const embedding = await getEmbeddingWithCache(text, false);
        if (embedding) {
            console.log(`[向量獲取] 成功 (維度: ${embedding.length})`);
        } else {
            console.log(`[向量獲取] 失敗，將依賴 LLM 判定`);
        }

        // Step A: Vector Match (Semantic Comparison) - 與廣告庫比對 (0.85)
        if (embedding) {
            const match = await db.matchSpam(embedding, 0.85);
            if (match) {
                isSpam = true;
                reason = `向量匹配 (ID: ${match.id})`;
                similarity = match.similarity;
                judgmentSource = 'Vector';
                console.log(`[向量比對] 發現匹配 (相似度: ${similarity.toFixed(4)})`);
            } else {
                console.log(`[向量比對] 無匹配，將進行 LLM 判定`);
            }
        }

        // Step B: LLM Breakout (Advanced Semantic Analysis)
        if (!isSpam && text.length > 5) {
            let bio = '';
            try {
                const chat = await ctx.telegram.getChat(userId);
                bio = (chat as any).bio || '';
            } catch (e) { }

            const llmResult = await gemini.isSpam(text, bio);
            if (llmResult === true) {
                isSpam = true;
                judgmentSource = `LLM (${gemini.getModelName()})`;
                reason = 'AI 判定為廣告';

                // 自動學習：將廣告向量保存到資料庫
                if (embedding) {
                    try {
                        await db.addSpamPattern(text, embedding);
                        console.log(`[自動學習] 訊息向量已保存到資料庫`);
                    } catch (e: any) {
                        console.error(`[自動學習] 保存失敗: ${e.message}`);
                    }
                } else {
                    console.log(`[自動學習] 無向量可保存，此廣告將被處理但不會用於未來比對`);
                }
            } else if (llmResult === false) {
                isSpam = false;
                judgmentSource = `LLM (${gemini.getModelName()})`;
                reason = 'AI 判定為正常';
            }
        }

        // 非廣告消息：處理向量緩存 (僅在消息不是廣告時執行)
        // 與緩存中 30 條向量進行比對，相似度 95% 時抽換，否則取代最舊的
        if (!isSpam && embedding) {
            processCacheForNormalMessage(embedding);
        }

        // 判定完成後，如果還是沒抓到但 API 爆了，為了保險我們記錄為 Normal 但標註 API 錯誤
        if (!isSpam && judgmentSource === '' && text.length > 0) {
            judgmentSource = `⚠️ API Error (Model: ${gemini.getModelName()})`;
            reason = 'API 配額已滿或發生錯誤，暫時放行並轉發紀錄。';
            // Fallback: 雖然是 Normal，但我們希望 Log 顯示為警告
        }

        // [Logging] 判斷後轉發
        let logChannelId = config.forward_channel_id || env.FORWARD_CHANNEL_ID;
        if (typeof logChannelId === 'string') logChannelId = logChannelId.trim();

        const shouldLog = !!(logChannelId && (isSpam || judgmentSource.includes('API Error') || monitoredGroups.includes(currentChatId)));

        const vectorStatus = embedding ? `✅ 已取得 (維度: ${embedding.length})` : '❌ 無法取得';
        console.log(`[判定完成] ${isSpam ? '⚠️ 廣告' : '✅ 正常'} | 來源: ${judgmentSource} | 向量: ${vectorStatus}`);

        if (shouldLog && logChannelId) {
            try {
                // 1. Forward Original
                const forwarded = await ctx.telegram.forwardMessage(logChannelId, ctx.chat.id, msg.message_id);

                // 2. Send Report (Reply to the forward)
                const verdictEmoji = isSpam ? '❌' : '✅';
                const embedModelStatus = embedding ? `✓ 已向量化 (${gemini.getEmbeddingModel()})` : '✗ 無向量 (LLM 判定)';
                const report = `${verdictEmoji} **判定結果**: ${isSpam ? '廣告 (SPAM)' : '正常 (NORMAL)'}\n` +
                    `📊 **相似度**: ${similarity.toFixed(4)}\n` +
                    `🧠 **判斷來源**: ${judgmentSource}\n` +
                    `📝 **詳細說明**: ${reason}\n` +
                    `🔧 **嵌入模型**: ${embedModelStatus}`;

                await ctx.telegram.sendMessage(logChannelId, report, {
                    reply_to_message_id: forwarded.message_id,
                    parse_mode: 'Markdown'
                });
            } catch (e: any) {
                console.error(`Logging failed to channel ${logChannelId}:`, e.message);

                // 特定處理 Chat not found，可能是 bot 沒加入或 ID 錯誤
                if (e.message?.includes('chat not found') || e.message?.includes('Bad Request: chat not found')) {
                    const helpMsg = `⚠️ 轉發失敗：找不到頻道 (${logChannelId})。\n` +
                        `1. 請確認機器人已加入該頻道並有管理員權限。\n` +
                        `2. 請確認 ID 是否正確 (是否少了 -100?)`;
                    try { await ctx.telegram.sendMessage(ctx.chat.id, helpMsg); } catch { }
                }

                // 自動修正：如果遇到群組升級錯誤，提示使用者更新 ID
                if (e.message?.includes('group chat was upgraded')) {
                    const helpMsg = `⚠️ 轉發失敗：轉發頻道 ID (${logChannelId}) 似乎已過期或錯誤（群組已升級）。請取得新的 Channel ID 並使用 /config forward_channel [新ID] 更新。`;
                    try { await ctx.telegram.sendMessage(ctx.chat.id, helpMsg); } catch { }
                }
            }
        }

        // [Action] 執行處置
        if (isSpam) {
            await handleSpamAction(ctx, db, env, userId, msg.message_id, reason);
        }
    });

    return bot;
}

function setupCommands(bot: any, db: DatabaseService, gemini: GeminiService, env: Env) {
    // 1. 歡迎指令：/start
    bot.command('start', async (ctx: any) => {
        const welcomeMsg = `👋 歡迎使用 **SpamKiller Bot**！

我是一個智能反廣告機器人，使用 AI 和向量匹配來偵測和處理垃圾訊息。

🚀 快速開始:
1. 將我添加到你的群組
2. 給我管理員權限
3. 在私聊中使用 /monitor add [群組ID] 添加監控
4. 使用 /help 查看所有指令

📖 詳細說明: /help`;
        await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
    });

    // 1.5 指令：/monitor
    bot.command('monitor', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        const config = await db.getConfig();
        const groups = config.monitored_groups || [];
        const args = ctx.message.text.split(/\s+/).filter((s: string) => s.length > 0);

        // 無參數：顯示當前監控群組或群內切換
        if (args.length < 2) {
            if (ctx.chat.type === 'private') {
                const groupList = groups.length > 0 ? groups.join('\n') : '無';
                const msg = `📊 **當前監控群組**:\n${groupList}\n\n用法: /monitor [add|remove|list] [群組ID]\n例: /monitor add -1001234567890`;
                await ctx.reply(msg, { parse_mode: 'Markdown' });
                return;
            }
            // 群內無參數：toggle
            const chatId = String(ctx.chat.id);
            if (groups.includes(chatId)) {
                await db.updateConfig('monitored_groups', groups.filter(g => g !== chatId));
                await ctx.reply('🛑 已停止監控此群組。');
            } else {
                groups.push(chatId);
                await db.updateConfig('monitored_groups', groups);
                await ctx.reply('✅ 已開始監控此群組。');
            }
            return;
        }

        // 有參數：add/remove/list
        const action = args[1];
        const groupId = args[2];

        if (action === 'list') {
            const groupList = groups.length > 0 ? groups.join('\n') : '無';
            const msg = `📊 **當前監控群組**:\n${groupList}`;
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        } else if (action === 'add' && groupId) {
            if (!groups.includes(groupId)) {
                groups.push(groupId);
                await db.updateConfig('monitored_groups', groups);
                await ctx.reply(`✅ 已添加群組: ${groupId}`);
            } else {
                await ctx.reply(`⚠️ 群組 ${groupId} 已在監控列表中。`);
            }
        } else if (action === 'remove' && groupId) {
            if (groups.includes(groupId)) {
                await db.updateConfig('monitored_groups', groups.filter(g => g !== groupId));
                await ctx.reply(`✅ 已移除群組: ${groupId}`);
            } else {
                await ctx.reply(`⚠️ 群組 ${groupId} 不在監控列表中。`);
            }
        } else {
            await ctx.reply('❌ 無效的操作。用法: /monitor [add|remove|list] [群組ID]');
        }
    });

    // 2. 指令：/whitelist
    bot.command('whitelist', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        const replyTo = ctx.message.reply_to_message;
        if (replyTo && replyTo.from) {
            await db.addToWhitelist(replyTo.from.id, replyTo.from.username);
            await ctx.reply(`已將 ${replyTo.from.id} 加入白名單`);
        } else {
            await ctx.reply('請回覆訊息以加入白名單');
        }
    });

    // 3. 指令：/spam
    bot.command('spam', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        const replyTo = ctx.message.reply_to_message;
        if (replyTo && 'text' in replyTo) {
            const text = replyTo.text || '';
            const embedding = await gemini.getEmbedding(text);
            
            if (embedding) {
                try {
                    await db.addSpamPattern(text, embedding);
                    await ctx.reply('✅ 已學習此廣告模式');
                } catch (e: any) {
                    await ctx.reply(`⚠️ 保存失敗: ${e.message}`);
                }
            } else {
                await ctx.reply('⚠️ 無法向量化該訊息，可能 API 配額已滿。');
            }

            if (replyTo.from) {
                await handleSpamAction(ctx, db, env, replyTo.from.id, replyTo.message_id, '管理員手動舉報');
            }
            try { await ctx.deleteMessage(); } catch { }
        }
    });

    // 3.1 指令：/normal (標記為正常訊息以改善向量資料庫)
    bot.command('normal', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        const replyTo = ctx.message.reply_to_message;
        if (replyTo && 'text' in replyTo) {
            const text = replyTo.text || '';
            const embedding = await gemini.getEmbedding(text);
            
            if (embedding) {
                try {
                    const { error } = await db.addNormalPattern(text, embedding);
                    if (!error) {
                        await ctx.reply('✅ 已學習此正常訊息特徵');
                    } else {
                        await ctx.reply('⚠️ 保存失敗');
                    }
                } catch (e: any) {
                    await ctx.reply(`⚠️ 保存失敗: ${e.message}`);
                }
            } else {
                await ctx.reply('⚠️ 無法向量化該訊息，可能 API 配額已滿。');
            }
            try { await ctx.deleteMessage(); } catch { }
        }
    });

    // 4. 指令：/config
    bot.command('config', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        // 使用正則表達式 split，避免多個空格造成的問題
        const args = ctx.message.text.split(/\s+/).filter((s: string) => s.length > 0);
        
        // 無參數：顯示當前配置
        if (args.length < 3) {
            const config = await db.getConfig();
            const helpMsg = `⚙️ **當前配置**：
• 懲罰閾值: ${config.punishment_threshold} 次違規後封鎖
• 申訴管道: ${config.appeal_channel}
• 轉發頻道 (日誌): ${config.forward_channel_id || '未設定'}
• 統計頻道: ${config.stats_channel_id || '未設定'}
• 觀察頻道 (演習模式): ${config.observation_channel_id || '未設定'}
• 控制頻道: ${config.control_channel_id || '未設定 (預設全部)'}
• 監控群組數: ${(config.monitored_groups || []).length}
• 乾運行模式: ${config.dry_run ? '開啟' : '關閉'}

**用法**: /config [key] [value]

**可設定的鍵值**:
• \`threshold [次數]\` - 設定懲罰閾值 (例: threshold 3)
• \`appeal [文字]\` - 設定申訴管道信息
• \`forward_channel [ID]\` - 設定轉發頻道 (例: -100123456)
• \`stats_channel [ID]\` - 設定統計頻道 (例: -100123456)
• \`observation_channel [ID]\` - 設定觀察頻道 (演習模式用)
• \`control_channel [ID]\` - 設定控制頻道 (僅該頻道可執行命令)
• \`dry_run [true/false]\` - 設定乾運行模式 (演習模式)
• \`monitored_groups [ID]\` - 設定監控群組 (使用 /monitor add|remove|list 管理)`;
            await ctx.reply(helpMsg, { parse_mode: 'Markdown' });
            return;
        }
        
        const key = args[1];
        const value = args.slice(2).join(' ').trim();

        // 簡單映射
        const mapping: any = {
            'threshold': 'punishment_threshold',
            'appeal': 'appeal_channel',
            'stats_channel': 'stats_channel_id',
            'observation_channel': 'observation_channel_id',
            'forward_channel': 'forward_channel_id',
            'control_channel': 'control_channel_id',
            'dry_run': 'dry_run',
            'monitored_groups': 'monitored_groups'
        };

        if (mapping[key]) {
            let val: any = value;
            if (key === 'threshold') val = parseInt(value);
            if (key === 'dry_run') val = (value === 'true');

            // monitored_groups 需要特殊處理
            if (key === 'monitored_groups') {
                await ctx.reply('⚠️ 請改用 /monitor add/remove/list 命令來管理監控群組', { parse_mode: 'Markdown' });
                return;
            }

            await db.updateConfig(mapping[key], val);
            await ctx.reply(`✅ 配置 \`${key}\` 已更新為 \`${val}\``, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply('❌ 未知設定鍵。請輸入 `/config` 查看幫助', { parse_mode: 'Markdown' });
        }
    });
}

async function checkAdmin(ctx: Context) {
    if (ctx.chat?.type === 'private') return true;
    try {
        const member = await ctx.getChatMember(ctx.from!.id);
        const isAdmin = ['administrator', 'creator'].includes(member.status);
        if (!isAdmin) {
            await ctx.reply('⚠️ 此指令僅限群組管理員使用。');
        }
        return isAdmin;
    } catch (e) {
        console.error('CheckAdmin failed', e);
        await ctx.reply('⚠️ 無法確認權限，請確保機器人具有管理員權限。');
        return false;
    }
}

async function handleSpamAction(ctx: Context, db: DatabaseService, env: Env, userId: number, messageId: number, reason: string) {
    const chatId = ctx.chat!.id;
    const config = (ctx as any).state.config || await db.getConfig();

    if (config.dry_run) {
        // 演習模式：僅記錄並通知觀察頻道
        if (config.observation_channel_id) {
            const report = `🚨 [演習模式] 偵測到疑似廣告\n` +
                `來源群組: ${chatId}\n` +
                `發言者: ${userId}\n` +
                `判定原因: ${reason}\n` +
                `預定處分: 刪除訊息並累計違規 (當前若執行應為第 ${(await getEstimatedCount(db, userId, chatId))} 次)`;

            try {
                await ctx.telegram.sendMessage(config.observation_channel_id, report);
                await ctx.telegram.forwardMessage(config.observation_channel_id, chatId, messageId);
            } catch (e) {
                console.error('Observation report failed', e);
            }
        }
        return;
    }

    // 正式模式：執行處分
    // 1. 刪除訊息
    try {
        await ctx.telegram.deleteMessage(chatId, messageId);
    } catch (e) { }

    // 2. 紀錄違規
    const count = await db.recordViolation(userId, chatId, reason);

    // 3. 通知申訴管道
    const appealMsg = `您的訊息被判定為廣告已刪除。如有誤刪請連繫：${config.appeal_channel}`;
    await ctx.reply(appealMsg);

    // 4. 判斷是否剔除
    if (count >= config.punishment_threshold) {
        try {
            await ctx.banChatMember(userId);
            await ctx.reply(`使用者 ${userId} 因一天內多次違規已被封鎖。`);
        } catch (e) {
            console.error('Ban failed', e);
        }
    }
}

async function getEstimatedCount(db: DatabaseService, userId: number, chatId: number): Promise<number> {
    // 這裡只是估計值，不實際寫入資料庫
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await (db as any).client
        .from('violation_logs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('chat_id', chatId)
        .gt('created_at', oneDayAgo);

    return (count || 0) + 1;
}
