import { Env, WhitelistCacheEntry } from './types';
import { DatabaseService } from './supabase';
import { GeminiService } from './gemini';
import { createBot } from './bot';

// Global Cache (persists in Worker memory)
const WHITELIST_CACHE = new Map<number, WhitelistCacheEntry>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log('Request Method:', request.method);
    console.log('Env Check:', {
      hasToken: !!env.TG_TOKEN,
      hasSupabaseUrl: !!env.SUPABASE_URL,
      hasSupabaseKey: !!env.SUPABASE_SERVICE_KEY,
      hasGeminiKey: !!env.GEMINI_API_KEY
    });

    const db = new DatabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const gemini = new GeminiService(env.GEMINI_API_KEY);
    const bot = createBot(env, db, gemini, WHITELIST_CACHE);

    // Global Bot Error Handler
    bot.catch((err: any, ctx: any) => {
      console.error(`Telegraf error for ${ctx.updateType}:`, err);
    });

    if (request.method === 'POST') {
      try {
        const update = await request.json() as any;
        console.log('Incoming update:', JSON.stringify(update));
        await bot.handleUpdate(update);
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Error processing update:', error);
        return new Response('Error', { status: 500 });
      }
    }

    return new Response('TG Bot is running');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = new DatabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    // 1. 每週清理 (假設週日執行，或每次都檢查是否需要清理)
    // 這裡簡單判定：如果今天是週日，執行清理
    const today = new Date();
    if (today.getDay() === 0) {
      await db.cleanupViolations();
      console.log('Weekly cleanup executed');
    }

    // 2. 每日統計
    const config = await db.getConfig();
    const statsChannelId = config.stats_channel_id || config.forward_channel_id || env.FORWARD_CHANNEL_ID;

    if (!statsChannelId) return;

    // 取得今日統計
    // 注意：這裡也傳入了 cache，雖然 scheduled 事件可能不需要用到 bot 的所有功能，但為了 API 一致性
    const bot = createBot(env, db, new GeminiService(env.GEMINI_API_KEY), WHITELIST_CACHE);

    const stats = await db.getDailyStats(config.punishment_threshold);

    const statsMsg = `[每日統計報告]\n` +
      `今日處理廣告訊息總數: ${stats.totalDeleted}\n` +
      `今日封鎖使用者人數: ${stats.kickedUsers.length}\n` +
      (stats.kickedUsers.length > 0 ? `封鎖名單: ${stats.kickedUsers.join(', ')}` : '');

    try {
      await bot.telegram.sendMessage(statsChannelId, statsMsg);
    } catch (e) {
      console.error('Failed to send stats', e);
    }
  },
};
