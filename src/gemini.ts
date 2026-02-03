import { GoogleGenerativeAI } from "@google/generative-ai";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private embeddingModel: any;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    this.embeddingModel = this.genAI.getGenerativeModel({ model: "text-embedding-004" });
  }

  async getEmbedding(text: string): Promise<number[]> {
    const result = await this.embeddingModel.embedContent(text);
    return result.embedding.values;
  }

  async isSpam(text: string, bio: string): Promise<boolean> {
    const prompt = `你是一個 Telegram 群組管理員。請判斷以下訊息與發言者簡介是否為廣告、詐騙或垃圾訊息。
如果是廣告，請回覆 "YES"，否則回覆 "NO"。

使用者簡介: ${bio}
訊息內容: ${text}

判斷結果:`;

    const result = await this.model.generateContent(prompt);
    const response = await result.response;
    const prediction = response.text().trim().toUpperCase();
    return prediction.includes("YES");
  }
}
