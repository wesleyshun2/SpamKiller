import { GoogleGenerativeAI } from "@google/generative-ai";

export class GeminiService {
  private genAI: GoogleGenerativeAI;

  // 候選模型清單 (優先嘗試較新的)
  private readonly textModels = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"];
  private readonly embedModels = ["text-embedding-004", "embedding-001"];

  private currentTextModel: string;
  private currentEmbedModel: string;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.currentTextModel = this.textModels[0];
    this.currentEmbedModel = this.embedModels[0];
  }

  getModelName(): string {
    return this.currentTextModel;
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    for (const modelName of this.embedModels) {
      try {
        const model = this.genAI.getGenerativeModel({ model: modelName });
        const result = await model.embedContent(text);
        this.currentEmbedModel = modelName; // Update working model
        return result.embedding.values;
      } catch (e: any) {
        console.warn(`Embedding failed with ${modelName}:`, e.message);
        if (this.isPermanentError(e)) {
          continue; // Try next model
        }
        return null; // Quota or other error, stop trying
      }
    }
    return null;
  }

  async isSpam(text: string, bio: string): Promise<boolean | null> {
    const prompt = `你是一個 Telegram 群組管理員。請判斷以下訊息與發言者簡介是否為廣告、詐騙或垃圾訊息。
如果是廣告，請回覆 "YES"，否則回覆 "NO"。

使用者簡介: ${bio}
訊息內容: ${text}

判斷結果:`;

    for (const modelName of this.textModels) {
      try {
        const model = this.genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const prediction = response.text().trim().toUpperCase();

        this.currentTextModel = modelName; // Update working model
        return prediction.includes("YES");
      } catch (e: any) {
        console.warn(`isSpam failed with ${modelName}:`, e.message);
        if (this.isPermanentError(e)) {
          continue; // Try next model
        }
        // If checking explicitly for 429 or other retryable, handling might differ. 
        // For now, if one fails with quota, likely all will.
        return null;
      }
    }
    return null;
  }

  private isPermanentError(e: any): boolean {
    const msg = e.message || '';
    // 429 (Too Many Requests) 也視為需要 fallback 的錯誤，讓我們切換到下一個模型
    if (msg.includes('429') || msg.includes('quota')) return true;

    return msg.includes('404') || msg.includes('not found') || msg.includes('not supported');
  }
}
