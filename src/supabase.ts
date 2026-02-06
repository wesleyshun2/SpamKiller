import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Config, Violation } from './types';

export class DatabaseService {
  private client: SupabaseClient;

  constructor(url: string, key: string) {
    this.client = createClient(url, key);
  }

  async isWhitelisted(userId: number): Promise<boolean> {
    const { data, error } = await this.client
      .from('whitelist')
      .select('user_id')
      .eq('user_id', userId)
      .single();
    if (error) console.error('isWhitelisted error:', error);
    return !!data;
  }

  async addToWhitelist(userId: number, username?: string) {
    const { data, error } = await this.client.from('whitelist').upsert({ user_id: userId, username });
    if (error) console.error('addToWhitelist error:', error);
    return data;
  }

  async getConfig(): Promise<Config> {
    const { data, error } = await this.client.from('config').select('key, value');
    if (error) console.error('getConfig error:', error);
    const config: any = {};
    data?.forEach((item) => {
      config[item.key] = item.value;
    });
    return {
      punishment_threshold: Number(config.punishment_threshold || 3),
      appeal_channel: config.appeal_channel || '請私訊管理員',
      stats_channel_id: config.stats_channel_id || null,
      dry_run: config.dry_run === true || config.dry_run === 'true',
      observation_channel_id: config.observation_channel_id || null,
      forward_channel_id: config.forward_channel_id || null,
      control_channel_id: config.control_channel_id || null,
      monitored_groups: Array.isArray(config.monitored_groups) ? config.monitored_groups : [],
    };
  }

  async updateConfig(key: string, value: any) {
    const { data, error } = await this.client.from('config').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error('updateConfig error:', error);
    return data;
  }

  async matchSpam(embedding: number[], threshold: number = 0.85) {
    const { data, error } = await this.client.rpc('match_spam_patterns', {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: 1,
    });
    if (error) console.error('matchSpam rpc error:', error);
    return data && data.length > 0 ? data[0] : null;
  }

  async addSpamPattern(content: string, embedding: number[]) {
    try {
      // 驗證輸入
      if (!content || content.trim().length === 0) {
        throw new Error('內容不能為空');
      }
      if (!embedding || embedding.length === 0) {
        throw new Error('嵌入向量不能為空');
      }
      // 記錄向量維度，但不再強制要求特定維度，直接儲存模型輸出
      console.log(`[保存廣告模式] 內容長度: ${content.length}, 嵌入向量維度: ${embedding.length}`);
      
      // 檢查是否已有極度相似的
      const existing = await this.matchSpam(embedding, 0.95);
      if (existing) {
        console.log(`[保存廣告模式] 發現現有模式 (相似度: ${existing.similarity.toFixed(4)}), 更新計數`);
        const { data, error } = await this.client
          .from('spam_patterns')
          .update({ use_count: (existing.use_count || 1) + 1 })
          .eq('id', existing.id);
        if (error) {
          console.error('❌ 更新失敗:', error);
          throw error;
        }
        console.log(`✅ 現有模式計數已增加`);
        return data;
      }
      
      console.log(`[保存廣告模式] 新模式，插入資料庫...`);
      const { data, error } = await this.client
        .from('spam_patterns')
        .insert({ content, embedding })
        .select();
      
      if (error) {
        console.error('❌ 插入失敗:', error, { contentLength: content.length, embeddingLength: embedding.length });
        throw error;
      }
      
      console.log('✅ 新廣告模式已成功保存');
      return data;
    } catch (e: any) {
      console.error('❌ 廣告模式保存失敗:', e.message);
      throw e;
    }
  }

  async addNormalPattern(content: string, embedding: number[]) {
    try {
      // 檢查是否已有極度相似的正常模式
      const { data, error: matchError } = await this.client.rpc('match_normal_patterns', {
        query_embedding: embedding,
        match_threshold: 0.95,
        match_count: 1,
      });
      if (matchError) {
        console.error('matchNormal rpc error:', matchError);
        throw matchError;
      }

      if (!matchError && data && data.length > 0) {
        const { data: udata, error: uerror } = await this.client
          .from('normal_patterns')
          .update({ use_count: (data[0].use_count || 1) + 1 })
          .eq('id', data[0].id);
        if (uerror) {
          console.error('addNormalPattern update error:', uerror);
          throw uerror;
        }
        console.log(`Updated existing normal pattern ${data[0].id}, use_count increased`);
        return { data: udata, error: null };
      }

      const { data: idata, error: ierr } = await this.client.from('normal_patterns').insert({ content, embedding });
      if (ierr) {
        console.error('addNormalPattern insert error:', ierr);
        throw ierr;
      }
      console.log('Successfully inserted new normal pattern');
      return { data: idata, error: null };
    } catch (e: any) {
      console.error('addNormalPattern failed:', e.message || e);
      return { data: null, error: e };
    }
  }

  async recordViolation(userId: number, chatId: number, reason: string = 'Spam detected'): Promise<number> {
    try {
      // 1. Insert new violation log
      const { data: vdata, error: insertError } = await this.client.from('violation_logs').insert({
        user_id: userId,
        chat_id: chatId,
        reason: reason
      });

      if (insertError) {
        console.error('Failed to insert violation log:', insertError);
        throw insertError;
      }
      console.log(`Violation recorded for user ${userId} in chat ${chatId}`);

      // 2. Count violations in the last 24 hours (across all chats for this user)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { count, error: countError } = await this.client
        .from('violation_logs')
        .select('*', { count: 'exact', head: true }) // count only
        .eq('user_id', userId)
        .eq('chat_id', chatId)
        .gt('created_at', oneDayAgo);

      if (countError) {
        console.error('Failed to count violations:', countError);
        throw countError;
      }

      const violationCount = (count || 0) + 1;
      console.log(`[Violation Count] UserId: ${userId}, ChatId: ${chatId}, 24h Violations: ${violationCount}`);
      return violationCount;
    } catch (e: any) {
      console.error('recordViolation failed:', e.message || e);
      return 1; // Fallback
    }
  }

  async getDailyStats(threshold: number = 3) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 統計今日（24h內）刪除總數
    const { count: totalDeleted, error: totalError } = await this.client
      .from('violation_logs')
      .select('*', { count: 'exact', head: true })
      .gt('created_at', yesterday);
    if (totalError) console.error('getDailyStats totalDeleted error:', totalError);

    // 找出達到封鎖門檻的使用者
    // 按 user_id + chat_id 進行分組計數
    const { data: logs, error: logsError } = await this.client
      .from('violation_logs')
      .select('user_id, chat_id')
      .gt('created_at', yesterday);
    if (logsError) console.error('getDailyStats logs query error:', logsError);

    const userChatCounts = new Map<string, number>();
    logs?.forEach(log => {
      const key = `${log.user_id}_${log.chat_id}`;
      const current = userChatCounts.get(key) || 0;
      userChatCounts.set(key, current + 1);
    });

    const kickedUsers = Array.from(userChatCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([key]) => {
        const [userId] = key.split('_');
        return parseInt(userId);
      });

    return {
      totalDeleted: totalDeleted || 0,
      kickedUsers: [...new Set(kickedUsers)] // 去重（同一用戶可能在多個群組被踢）
    };
  }

  async getViolationCountForUser(userId: number, chatId: number, hoursBack: number = 24): Promise<number> {
    const timeAgo = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    const { count, error } = await this.client
      .from('violation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .gt('created_at', timeAgo);

    if (error) {
      console.error('Failed to get violation count:', error);
      return 0;
    }

    return count || 0;
  }

  async getAllWhitelist() {
    const { data, error } = await this.client.from('whitelist').select('user_id, username');
    if (error) console.error('getAllWhitelist error:', error);
    return data;
  }

  async cleanupViolations(days: number = 7) {
    const limit = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.client.from('violation_logs').delete().lt('created_at', limit);
    if (error) console.error('cleanupViolations error:', error);
    return data;
  }
}
