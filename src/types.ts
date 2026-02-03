export interface Env {
  TG_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  GEMINI_API_KEY: string;
  FORWARD_CHANNEL_ID: string;
}

export interface Config {
  punishment_threshold: number;
  appeal_channel: string;
  stats_channel_id: string | null;
  dry_run: boolean;
  observation_channel_id: string | null;
}

export interface Violation {
  user_id: number;
  chat_id: number;
  count: number;
  last_violation: string;
}
