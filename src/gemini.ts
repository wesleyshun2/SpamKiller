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

  getEmbeddingModel(): string {
    return this.currentEmbedModel;
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    if (!text || text.trim().length === 0) {
      console.warn('⚠️ 無法嵌入空文本');
      return null;
    }

    console.log(`[嵌入請求] 文本長度: ${text.length}`);
    
    const TARGET_DIM = 768;
    for (const modelName of this.embedModels) {
      try {
        console.log(`[嵌入請求] 嘗試模型: ${modelName}`);
        const model = this.genAI.getGenerativeModel({ model: modelName });
        // 優先使用 top-level models.embedContent API（支援 outputDimensionality），若不可用再 fallback
        let result: any;
        if (this.genAI && (this.genAI as any).models && typeof (this.genAI as any).models.embedContent === 'function') {
          result = await (this.genAI as any).models.embedContent({ model: modelName, content: text, outputDimensionality: TARGET_DIM });
        } else {
          // fallback: legacy model instance method (可能只接受 text string)
          result = await model.embedContent ? await model.embedContent(text) : null;
        }
        
        if (!result.embedding || !result.embedding.values) {
          console.warn(`⚠️ 嵌入結果無數據`);
          continue;
        }

        const embeddingValues = result.embedding.values;
        this.currentEmbedModel = modelName;

        // 如果模型已回傳正確維度，直接做 L2 正規化以確保向量長度為 1
        const normalized = this.resizeAndNormalizeEmbedding(embeddingValues, TARGET_DIM);
        console.log(`✅ 嵌入成功 (原始維度: ${embeddingValues.length} -> 使用維度: ${normalized.length})`);
        return normalized;
      } catch (e: any) {
        if (this.isNotFoundError(e)) {
          try {
            console.log(`[嵌入請求] 嘗試 v1 API: ${modelName}`);
            const modelV1 = this.genAI.getGenerativeModel({ model: modelName }, { apiVersion: 'v1' });
            let resultV1: any;
            if (this.genAI && (this.genAI as any).models && typeof (this.genAI as any).models.embedContent === 'function') {
              resultV1 = await (this.genAI as any).models.embedContent({ model: modelName, content: text, outputDimensionality: TARGET_DIM, apiVersion: 'v1' });
            } else {
              resultV1 = await modelV1.embedContent ? await modelV1.embedContent(text) : null;
            }
            
            if (!resultV1 || !resultV1.embedding || !resultV1.embedding.values) {
              console.warn(`⚠️ v1 嵌入結果無數據`);
              continue;
            }

            const embeddingValues = resultV1.embedding.values;
            this.currentEmbedModel = modelName;
            const normalized = this.resizeAndNormalizeEmbedding(embeddingValues, TARGET_DIM);
            console.log(`✅ 嵌入成功 (v1 API, 原始維度: ${embeddingValues.length} -> 使用維度: ${normalized.length})`);
            return normalized;
          } catch (e2: any) {
            console.warn(`❌ v1 API 失敗: ${e2.message}`);
          }
        }
        console.warn(`❌ 嵌入失敗: ${e.message}`);
        if (this.isPermanentError(e)) continue;
        return null;
      }
    }
    
    console.error('❌ 所有嵌入模型都失敗');
    return null;
  }

  private resizeAndNormalizeEmbedding(vec: number[], targetDim: number): number[] {
    if (!vec || vec.length === 0) return [];
    const n = vec.length;
    let out: number[] = new Array(targetDim).fill(0);

    if (n === targetDim) {
      out = vec.slice();
    } else if (n > targetDim) {
      // Downsample by averaging ranges that map to each target index
      for (let i = 0; i < targetDim; i++) {
        const start = Math.floor((i * n) / targetDim);
        let end = Math.floor(((i + 1) * n) / targetDim);
        if (end <= start) end = Math.min(start + 1, n);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end && j < n; j++) {
          sum += vec[j];
          count++;
        }
        out[i] = count > 0 ? sum / count : 0;
      }
    } else {
      // n < targetDim: copy and pad with zeros
      for (let i = 0; i < n; i++) out[i] = vec[i];
      for (let i = n; i < targetDim; i++) out[i] = 0;
    }

    // L2 normalize
    let norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0));
    if (norm === 0) return out;
    out = out.map((v) => v / norm);
    return out;
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
