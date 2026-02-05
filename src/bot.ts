import { Telegraf, Context } from 'telegraf';
import { DatabaseService } from './supabase';
import { GeminiService } from './gemini';
import { Env } from './types';

export function createBot(env: Env, db: DatabaseService, gemini: GeminiService, whitelistCache: Map<number, any>) {
    const bot = new Telegraf(env.TG_TOKEN);

    // 1. 指令區
    setupCommands(bot, db, gemini, env);

    // 1.1 額外測試指令
    bot.command('ping', async (ctx) => {
        await ctx.reply('🏓 Pong! 機器人運作中。\nChat ID: ' + ctx.chat.id + '\nUser ID: ' + ctx.from.id);
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

        // Step A: Vector Match (Semantic Comparison)
        const embedding = await gemini.getEmbedding(text);

        if (embedding) {
            const match = await db.matchSpam(embedding, 0.85); // 向量比對
            if (match) {
                isSpam = true;
                reason = `Vector Match (ID: ${match.id})`;
                similarity = match.similarity;
                judgmentSource = 'Vector';
            }
        }

        // Step B: LLM Breakout (Advanced Semantic Analysis)
        // 若向量庫無匹配，則呼叫 Gemini LLM 進行最終語意判定
        if (!isSpam && text.length > 5) {
            let bio = '';
            try {
                const chat = await ctx.telegram.getChat(userId);
                bio = (chat as any).bio || '';
            } catch (e) { }

            const llmResult = await gemini.isSpam(text, bio);
            if (llmResult === true) {
                isSpam = true;
                judgmentSource = `Gemini LLM (${gemini.getModelName()})`;
                reason = 'AI 判定為廣告';

                // [Auto-Learning] 重點：如果 AI 判定為廣告，且我們有向量，則自動存入資料庫
                if (embedding) {
                    try {
                        await db.addSpamPattern(text, embedding);
                        console.log('Automated learning: Saved new spam pattern to DB.');
                    } catch (e) {
                        console.error('Failed to auto-save spam pattern:', e);
                    }
                }
            } else if (llmResult === false) {
                isSpam = false;
                judgmentSource = `Gemini LLM (${gemini.getModelName()})`;
                reason = 'AI 判定為正常';
            }
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

        console.log(`[Logging Check] logChannelId: "${logChannelId}", shouldLog: ${shouldLog}, isSpam: ${isSpam}, source: ${judgmentSource}`);

        if (shouldLog && logChannelId) {
            try {
                // 1. Forward Original
                const forwarded = await ctx.telegram.forwardMessage(logChannelId, ctx.chat.id, msg.message_id);

                // 2. Send Report (Reply to the forward)
                const verdictEmoji = isSpam ? 'EX' : 'OK';
                const report = `[${verdictEmoji}] 判定結果: ${isSpam ? '廣告 (SPAM)' : '正常 (NORMAL)'}\n` +
                    `分數: ${similarity.toFixed(4)}\n` +
                    `核心: ${judgmentSource}\n` +
                    `說明: ${reason}`;

                await ctx.telegram.sendMessage(logChannelId, report, {
                    reply_to_message_id: forwarded.message_id
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
    // 1.5 指令：/monitor
    bot.command('monitor', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        if (ctx.chat.type === 'private') {
            await ctx.reply('請在群組中使用。');
            return;
        }
        const config = await db.getConfig();
        const groups = config.monitored_groups || [];
        const chatId = String(ctx.chat.id);

        if (groups.includes(chatId)) {
            await db.updateConfig('monitored_groups', groups.filter(g => g !== chatId));
            await ctx.reply('🛑 已停止監控。');
        } else {
            groups.push(chatId);
            await db.updateConfig('monitored_groups', groups);
            await ctx.reply('✅ 已開始監控。');
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
                await db.addSpamPattern(text, embedding);
                await ctx.reply('✅ 已學習此廣告模式');
            } else {
                await ctx.reply('⚠️ 無法向量化該訊息，可能 API 配額已滿。');
            }

            if (replyTo.from) {
                await handleSpamAction(ctx, db, env, replyTo.from.id, replyTo.message_id, '管理員手動舉報');
            }
            try { await ctx.deleteMessage(); } catch { }
        }
    });

    // 4. 指令：/config
    bot.command('config', async (ctx: any) => {
        if (!await checkAdmin(ctx)) return;
        // 使用正則表達式 split，避免多個空格造成的問題
        const args = ctx.message.text.split(/\s+/).filter((s: string) => s.length > 0);
        if (args.length < 3) {
            await ctx.reply('用法: /config [key] [value]');
            return;
        }
        const key = args[1];
        const value = args.slice(2).join(' ').trim(); // 確保去除前後空白

        // 簡單映射
        const mapping: any = {
            'threshold': 'punishment_threshold',
            'appeal': 'appeal_channel',
            'stats_channel': 'stats_channel_id',
            'dry_run': 'dry_run',
            'observation_channel': 'observation_channel_id',
            'forward_channel': 'forward_channel_id'
        };

        if (mapping[key]) {
            let val: any = value;
            if (key === 'threshold') val = parseInt(value);
            if (key === 'dry_run') val = (value === 'true');

            await db.updateConfig(mapping[key], val);
            await ctx.reply(`配置 ${key} 更新為 ${val}`);
        } else {
            await ctx.reply('未知設定鍵');
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
