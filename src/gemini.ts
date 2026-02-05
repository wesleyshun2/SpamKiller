import { GoogleGenerativeAI } from "@google/generative-ai";

export class GeminiService {
  private genAI: GoogleGenerativeAI;

  // 候選模型清單 (優先嘗試較新的)
  private readonly textModels = [
    "gemini-2.5-flash-lite",
    "gemma-3-4b-it"
  ];
  private readonly embedModels = ["gemini-embedding-001"];

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
        // 先嘗試預設 v1beta
        const model = this.genAI.getGenerativeModel({ model: modelName });
        const result = await model.embedContent(text);
        this.currentEmbedModel = modelName;
        return result.embedding.values;
      } catch (e: any) {
        if (this.isNotFoundError(e)) {
          // 如果 404，嘗試強制使用 v1
          try {
            const modelV1 = this.genAI.getGenerativeModel({ model: modelName }, { apiVersion: 'v1' });
            const result = await modelV1.embedContent(text);
            this.currentEmbedModel = modelName;
            return result.embedding.values;
          } catch (e2: any) {
            console.warn(`Embedding failed with ${modelName} on both v1beta & v1: ${e2.message}`);
          }
        }
        console.warn(`Embedding failed with ${modelName}:`, e.message);
        if (this.isPermanentError(e)) continue;
        return null;
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

        this.currentTextModel = modelName;
        return prediction.includes("YES");
      } catch (e: any) {
        if (this.isNotFoundError(e)) {
          // 如果 404，嘗試強迫使用 v1 API 再次嘗試
          try {
            const modelV1 = this.genAI.getGenerativeModel({ model: modelName }, { apiVersion: 'v1' });
            const result = await modelV1.generateContent(prompt);
            const response = await result.response;
            this.currentTextModel = modelName;
            return response.text().trim().toUpperCase().includes("YES");
          } catch (e2: any) {
            console.warn(`isSpam failed with ${modelName} on both v1beta & v1: ${e2.message}`);
          }
        }
        console.warn(`isSpam failed with ${modelName}:`, e.message);
        if (this.isPermanentError(e)) continue;
        return null;
      }
    }
    return null;
  }

  private isNotFoundError(e: any): boolean {
    const msg = e.message || '';
    return msg.includes('404') || msg.includes('not found');
  }

  private isPermanentError(e: any): boolean {
    const msg = e.message || '';
    // 429 (Too Many Requests) 也視為需要 fallback 的錯誤，讓我們切換到下一個模型
    if (msg.includes('429') || msg.includes('quota')) return true;

    return msg.includes('404') || msg.includes('not found') || msg.includes('not supported');
  }
}
