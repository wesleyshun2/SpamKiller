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

  async recordViolation(userId: number, chatId: number, reason: string = 'Spam detected'): Promise<number> {
    // 1. Insert new violation log
    const { error: insertError } = await this.client.from('violation_logs').insert({
      user_id: userId,
      chat_id: chatId,
      reason: reason
    });

    if (insertError) {
      console.error('Failed to insert violation log:', insertError);
      // Fallback: if insert fails, we might still want to try to count or just return a safe value
      // But usually if insert fails, count might fail too.
    }

    // 2. Count violations in the last 24 hours
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

    return count || 0;
  }

  async getDailyStats(threshold: number = 3) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 統計今日（24h內）刪除總數
    const { count: totalDeleted } = await this.client
      .from('violation_logs')
      .select('*', { count: 'exact', head: true })
      .gt('created_at', yesterday);

    // 找出達到封鎖門檻的使用者
    // 這需要 aggregation，Supabase client 比較難直接做 group by having count > x
    // 為了簡單起見，我們先抓取所有 logs 然後在 JS 處理 (若量大建議改用 RPC)
    const { data: logs } = await this.client
      .from('violation_logs')
      .select('user_id')
      .gt('created_at', yesterday);

    const userCounts = new Map<number, number>();
    logs?.forEach(log => {
      const current = userCounts.get(log.user_id) || 0;
      userCounts.set(log.user_id, current + 1);
    });

    const kickedUsers = Array.from(userCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([userId]) => userId);

    return {
      totalDeleted: totalDeleted || 0,
      kickedUsers
    };
  }

  async getAllWhitelist() {
    return this.client.from('whitelist').select('user_id, username');
  }

  async cleanupViolations(days: number = 7) {
    const limit = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.client.from('violation_logs').delete().lt('created_at', limit);
  }
}
