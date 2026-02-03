import { webhookCallback } from 'telegraf';
import { Env } from './types';
import { DatabaseService } from './supabase';
import { GeminiService } from './gemini';
import { createBot } from './bot';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const db = new DatabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const gemini = new GeminiService(env.GEMINI_API_KEY);
    const bot = createBot(env, db, gemini);

    if (request.method === 'POST') {
      return webhookCallback(bot, 'cloudflare-workers')(request);
    }

    return new Response('TG Bot is running');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = new DatabaseService(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const config = await db.getConfig();
    const statsChannelId = config.stats_channel_id || env.FORWARD_CHANNEL_ID;

    if (!statsChannelId) return;

    // 取得今日統計 (簡單範例：這裡可以從資料庫實作更複雜的查詢)
    // 這裡我們只發送一個簡單的每日提醒
    const bot = createBot(env, db, new GeminiService(env.GEMINI_API_KEY));

    const stats = await db.getDailyStats(config.punishment_threshold);

    const statsMsg = `[每日統計報告]\n` +
      `今日處理廣告訊息總數: ${stats.totalDeleted}\n` +
      `今日封鎖使用者人數: ${stats.kickedUsers.length}\n` +
      (stats.kickedUsers.length > 0 ? `封鎖名單: ${stats.kickedUsers.join(', ')}` : '');

    await bot.telegram.sendMessage(statsChannelId, statsMsg);
  },
};
