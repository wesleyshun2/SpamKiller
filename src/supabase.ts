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
    return !!data;
  }

  async addToWhitelist(userId: number, username?: string) {
    return this.client.from('whitelist').upsert({ user_id: userId, username });
  }

  async getConfig(): Promise<Config> {
    const { data, error } = await this.client.from('config').select('key, value');
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
    return this.client.from('config').upsert({ key, value, updated_at: new Date().toISOString() });
  }

  async matchSpam(embedding: number[], threshold: number = 0.85) {
    const { data, error } = await this.client.rpc('match_spam_patterns', {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: 1,
    });
    return data && data.length > 0 ? data[0] : null;
  }

  async addSpamPattern(content: string, embedding: number[]) {
    // 檢查是否已有極度相似的
    const existing = await this.matchSpam(embedding, 0.95);
    if (existing) {
      return this.client
        .from('spam_patterns')
        .update({ use_count: (existing.use_count || 1) + 1 })
        .eq('id', existing.id);
    }
    return this.client.from('spam_patterns').insert({ content, embedding });
  }

  async addNormalPattern(content: string, embedding: number[]) {
    // 檢查是否已有極度相似的正常模式
    const { data, error: matchError } = await this.client.rpc('match_normal_patterns', {
      query_embedding: embedding,
      match_threshold: 0.95,
      match_count: 1,
    });

    if (!matchError && data && data.length > 0) {
      return this.client
        .from('normal_patterns')
        .update({ use_count: (data[0].use_count || 1) + 1 })
        .eq('id', data[0].id);
    }

    return this.client.from('normal_patterns').insert({ content, embedding });
  }

  async recordViolation(userId: number, chatId: number, reason: string = 'Spam detected'): Promise<number> {
    // 1. Insert new violation log
    const { error: insertError } = await this.client.from('violation_logs').insert({
      user_id: userId,
      chat_id: chatId,
      reason: reason
    });

    if (insertError) {
      console.error('Failed to insert violation log:', insertError);
    }

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
      return 1; // Fallback
    }

    const violationCount = (count || 0) + 1;
    console.log(`[Violation Count] UserId: ${userId}, ChatId: ${chatId}, 24h Violations: ${violationCount}`);
    return violationCount;
  }

  async getDailyStats(threshold: number = 3) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 統計今日（24h內）刪除總數
    const { count: totalDeleted } = await this.client
      .from('violation_logs')
      .select('*', { count: 'exact', head: true })
      .gt('created_at', yesterday);

    // 找出達到封鎖門檻的使用者
    // 按 user_id + chat_id 進行分組計數
    const { data: logs } = await this.client
      .from('violation_logs')
      .select('user_id, chat_id')
      .gt('created_at', yesterday);

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
    return this.client.from('whitelist').select('user_id, username');
  }

  async cleanupViolations(days: number = 7) {
    const limit = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.client.from('violation_logs').delete().lt('created_at', limit);
  }
}
