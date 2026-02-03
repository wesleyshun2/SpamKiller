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

  async recordViolation(userId: number, chatId: number): Promise<number> {
    const { data: existing } = await this.client
      .from('violations')
      .select('count, last_violation')
      .eq('user_id', userId)
      .eq('chat_id', chatId)
      .single();

    const now = new Date();
    let count = 1;

    if (existing) {
      const last = new Date(existing.last_violation);
      const diff24h = (now.getTime() - last.getTime()) < 24 * 60 * 60 * 1000;
      count = diff24h ? existing.count + 1 : 1;
    }

    await this.client.from('violations').upsert({
      user_id: userId,
      chat_id: chatId,
      count,
      last_violation: now.toISOString(),
    });

    return count;
  }

  async getDailyStats(threshold: number = 3) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 統計刪除總數
    // 我們可以從 violations 累加
    const { data: violations } = await this.client
      .from('violations')
      .select('user_id, count')
      .gt('last_violation', yesterday);

    const totalDeleted = violations?.reduce((acc, curr) => acc + curr.count, 0) || 0;
    const kickedUsers = violations?.filter(v => v.count >= threshold).map(v => v.user_id) || [];

    return {
      totalDeleted,
      kickedUsers
    };
  }
}
