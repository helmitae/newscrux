// src/summarizer.ts
import { OpenRouter } from '@openrouter/sdk';
import { config } from './config.js';
import { createLogger } from './logger.js';
import type { QueueEntry, StructuredSummary, FeedKind } from './types.js';

const log = createLogger('summarizer');

const openrouter = new OpenRouter({
  apiKey: config.openrouterApiKey,
});

const KIND_TO_SOURCE_TYPE: Record<FeedKind, StructuredSummary['source_type']> = {
  official_blog: 'official_announcement',
  media: 'media_report',
  research: 'research',
  newsletter: 'newsletter',
};

function buildSystemPrompt(feedKind: FeedKind): string {
  const kindLabel = {
    official_blog: 'resmi blog/duyuru',
    media: 'medya haberi',
    research: 'araştırma makalesi',
    newsletter: 'teknik bülten',
  }[feedKind];

  return `Sen bir teknoloji haberleri analiz sistemisin.
Sana bir ${kindLabel} veriliyor. Analiz edip aşağıdaki JSON formatında Türkçe çıktı üret.

Zorunlu JSON formatı:
{
  "title_tr": "Haberin Türkçe başlığı (tek satır, kısa ve öz)",
  "what_happened": "Ne oldu — en az 2-3 cümle detaylı açıklama",
  "why_it_matters": "Neden önemli — en az 1-2 cümle, pratik etki ve sonuçlar",
  "key_detail": "Bir kritik detay, rakam veya dikkat çeken bilgi",
  "source_type": "${KIND_TO_SOURCE_TYPE[feedKind]}"
}

Kurallar:
- Tüm metin Türkçe olmalı.
- what_happened en az 50 karakter olmalı.
- why_it_matters en az 20 karakter olmalı.
- Teknik terimlerin Türkçe karşılığı varsa kullan, yoksa orijinalini koru.
- SADECE geçerli JSON döndür, başka metin ekleme.`;
}

const MAX_RETRIES = 1;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractResponseText(result: any): string {
  const rawContent = result.choices?.[0]?.message?.content;
  if (typeof rawContent === 'string') return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter((item: any): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item: any) => item.text)
      .join('');
  }
  return '';
}

function parseAndValidateSummary(text: string, feedKind: FeedKind): StructuredSummary | null {
  try {
    let jsonStr = text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);

    const required = ['title_tr', 'what_happened', 'why_it_matters', 'key_detail', 'source_type'] as const;
    for (const field of required) {
      if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
        log.warn(`Missing or empty field: ${field}`);
        return null;
      }
    }

    if (parsed.what_happened.length < 50) {
      log.warn(`what_happened too short: ${parsed.what_happened.length} chars (min 50)`);
      return null;
    }
    if (parsed.why_it_matters.length < 20) {
      log.warn(`why_it_matters too short: ${parsed.why_it_matters.length} chars (min 20)`);
      return null;
    }

    const expectedSourceType = KIND_TO_SOURCE_TYPE[feedKind];
    if (parsed.source_type !== expectedSourceType) {
      log.debug(`source_type mismatch: model="${parsed.source_type}" vs config="${expectedSourceType}" — using config`);
    }

    return {
      title_tr: parsed.title_tr.trim(),
      what_happened: parsed.what_happened.trim(),
      why_it_matters: parsed.why_it_matters.trim(),
      key_detail: parsed.key_detail.trim(),
      source_type: expectedSourceType,
    };
  } catch (err) {
    log.warn(`JSON parse error: ${err}`);
    return null;
  }
}

export async function summarizeEntry(entry: QueueEntry): Promise<StructuredSummary | null> {
  const content = entry.enrichedContent || entry.snippet;
  const userContent = `Başlık: ${entry.title}\nKaynak: ${entry.feedName}\nKaynak tipi: ${entry.feedKind}\n\nİçerik:\n${content}`;

  log.debug(`Summarizing: ${entry.title}`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await openrouter.chat.send({
        model: config.openrouterModel,
        messages: [
          { role: 'system', content: buildSystemPrompt(entry.feedKind) },
          { role: 'user', content: userContent },
        ],
      });

      const text = extractResponseText(result);
      const summary = parseAndValidateSummary(text, entry.feedKind);

      if (summary) {
        log.info(`Summarized: ${entry.title} (${summary.what_happened.length} chars)`);
        return summary;
      }

      if (attempt < MAX_RETRIES) {
        log.warn(`Summary validation failed for "${entry.title}", retrying...`);
        await delay(2000);
      }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        log.warn(`Summarization attempt ${attempt + 1} failed for "${entry.title}", retrying: ${err}`);
        await delay(Math.pow(2, attempt + 1) * 1000);
      } else {
        log.error(`Summarization failed after retries: ${entry.title}`, err);
      }
    }
  }

  return null;
}
