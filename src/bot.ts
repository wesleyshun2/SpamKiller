import { Telegraf, Context } from 'telegraf';
import { DatabaseService } from './supabase';
import { GeminiService } from './gemini';
import { Env } from './types';

export function createBot(env: Env, db: DatabaseService, gemini: GeminiService) {
  const bot = new Telegraf(env.TG_TOKEN);

  // 1. 中間層：轉發訊息到頻道
  bot.on(['message', 'edited_message'], async (ctx, next) => {
    if (env.FORWARD_CHANNEL_ID) {
      const msg = (ctx.message || ctx.editedMessage) as any;
      if (msg && msg.message_id) {
        try {
          await ctx.telegram.forwardMessage(env.FORWARD_CHANNEL_ID, ctx.chat.id, msg.message_id);
        } catch (e) {
          console.error('Forward failed', e);
        }
      }
    }
    return next();
  });

  // 2. 指令：/whitelist (管理員用)
  bot.command('whitelist', async (ctx) => {
    const isAdmin = await checkAdmin(ctx);
    if (!isAdmin) return;

    const replyTo = ctx.message.reply_to_message;
    if (replyTo && replyTo.from) {
      await db.addToWhitelist(replyTo.from.id, replyTo.from.username);
      await ctx.reply(`已將 ${replyTo.from.id} 加入白名單`);
    } else {
      await ctx.reply('請回覆某人的訊息以將其加入白名單');
    }
  });

  // 3. 指令：/spam (管理員回覆舉報)
  bot.command('spam', async (ctx) => {
    const isAdmin = await checkAdmin(ctx);
    if (!isAdmin) return;

    const replyTo = ctx.message.reply_to_message;
    if (replyTo && 'text' in replyTo) {
      const text = replyTo.text || '';
      const embedding = await gemini.getEmbedding(text);
      await db.addSpamPattern(text, embedding);

      // 紀錄違規並檢查是否需剔除 (手動舉報也算違規)
      if (replyTo.from) {
        await handleSpamAction(ctx, db, env, replyTo.from.id, replyTo.message_id);
      }

      // 刪除管理員的指令訊息
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (e) {}

      await ctx.reply('已學習此廣告模式、紀錄違規並處理訊息');
    }
  });

  // 4. 指令：/config (管理員用)
  bot.command('config', async (ctx) => {
    const isAdmin = await checkAdmin(ctx);
    if (!isAdmin) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
      await ctx.reply('用法: /config [threshold|appeal|stats_channel] [值]\n' +
                      '例如: /config threshold 5\n' +
                      '例如: /config appeal 請連繫 @admin');
      return;
    }

    const key = args[1];
    const value = args.slice(2).join(' ');

    if (key === 'threshold') {
      await db.updateConfig('punishment_threshold', parseInt(value));
    } else if (key === 'appeal') {
      await db.updateConfig('appeal_channel', value);
    } else if (key === 'stats_channel') {
      await db.updateConfig('stats_channel_id', value);
    }

    await ctx.reply(`配置 ${key} 已更新為 ${value}`);
  });

  // 5. 核心邏輯：監測訊息
  bot.on(['message', 'edited_message'], async (ctx) => {
    const msg = (ctx.message || ctx.editedMessage) as any;
    if (!msg || !('text' in msg)) return;

    const userId = msg.from.id;
    const text = msg.text;

    // 白名單檢查
    if (await db.isWhitelisted(userId)) return;

    // 向量檢查 (先做向量檢查，再決定是否拿 Bio，節省 API 呼叫)
    const embedding = await gemini.getEmbedding(text);
    const match = await db.matchSpam(embedding, 0.85); // 門檻暫定 0.85

    let isSpam = !!match;

    // 如果向量沒中，但文字較長，交給 Gemini 判斷
    if (!isSpam && text.length > 10) {
      // 此時才獲取 Bio
      let bio = '';
      try {
        const chat = await ctx.telegram.getChat(userId);
        bio = (chat as any).bio || '';
      } catch (e) {}

      isSpam = await gemini.isSpam(text, bio);
    }

    if (isSpam) {
      await handleSpamAction(ctx, db, env, userId, msg.message_id);
    }
  });

  return bot;
}

async function checkAdmin(ctx: Context) {
  if (ctx.chat?.type === 'private') return true;
  const member = await ctx.getChatMember(ctx.from!.id);
  return ['administrator', 'creator'].includes(member.status);
}

async function handleSpamAction(ctx: Context, db: DatabaseService, env: Env, userId: number, messageId: number) {
  const chatId = ctx.chat!.id;
  const config = await db.getConfig();

  // 1. 刪除訊息
  try {
    await ctx.telegram.deleteMessage(chatId, messageId);
  } catch (e) {}

  // 2. 紀錄違規
  const count = await db.recordViolation(userId, chatId);

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
