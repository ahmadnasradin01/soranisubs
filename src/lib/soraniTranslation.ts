// Dedicated Sorani Kurdish (Central Kurdish / کوردیی ناوەندی) subtitle translation service.
// Translates speech cues into idiomatic Sorani Kurdish and spreads long speech into short 2-3 piece subtitles.

import {
  getGeminiApiKey,
  getGeminiTranslateModel,
  FALLBACK_GEMINI_TRANSLATE_MODELS,
} from "./config";
import type { AcousticCue } from "./geminiTranscription";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_BATCH_SIZE = 30;

const SYSTEM_INSTRUCTION = `You are a master subtitle translator specializing in idiomatic Sorani Kurdish (کوردیی ناوەندی / Central Kurdish / ckb).
Translate each subtitle line accurately into concise, natural Sorani Kurdish written in standard Kurdish Arabic-based script (ئەلفوبێی کوردی).

Mandatory Rules:
1. Return a JSON object with a "translations" array holding exactly one translation per input string, in the exact same order.
2. Entry N of your output corresponds strictly to index N of the input: never merge, split, drop, or reorder entries.
3. Use natural spoken register appropriate for video subtitles. Keep translations concise and clear so viewers can easily read them in the time available.
4. Always use Kurdish letters properly (پ، چ، ژ، گ، ڤ، ڕ، ڵ، ۆ، ێ، ە).
5. Preserve proper nouns, numbers, and technical terms.
6. Do not add annotations, brackets, markdown bolding, or transliterations.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    translations: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["translations"],
};

export interface TranslationProgress {
  currentBatch: number;
  totalBatches: number;
  processedCues: number;
  totalCues: number;
}

export interface SubtitleCue {
  id: number;
  start: number;
  end: number;
  lines: string[];
  sourceText: string;
  kurdishText: string;
}

/**
 * Wraps Sorani Kurdish text into at most 2 balanced lines (max ~36 chars per line).
 */
export function wrapSoraniLines(text: string, maxPerLine = 36): string[] {
  const clean = text.trim();
  if (clean.length <= maxPerLine) {
    return [clean];
  }

  const words = clean.split(/\s+/);
  if (words.length <= 1) {
    return [clean];
  }

  // Find balanced split point minimizing the longer line
  let bestSplit = 1;
  let bestDiff = Infinity;

  for (let i = 1; i < words.length; i++) {
    const leftLen = words.slice(0, i).join(" ").length;
    const rightLen = words.slice(i).join(" ").length;
    const diff = Math.abs(leftLen - rightLen);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = i;
    }
  }

  const line1 = words.slice(0, bestSplit).join(" ");
  const line2 = words.slice(bestSplit).join(" ");
  return [line1, line2];
}

/**
 * Cuts long subtitles into 2 or 3 short sequential pieces spread across the speaker's vocal duration.
 * Guarantees subtitles never block the video or form 4-line blocks.
 */
export function spreadAndSplitLongCues(
  cues: SubtitleCue[],
  maxDuration = 4.6,
  maxChars = 48,
): SubtitleCue[] {
  const result: SubtitleCue[] = [];
  let nextId = 1;

  for (const cue of cues) {
    const dur = cue.end - cue.start;
    const text = cue.kurdishText.trim();
    const sourceText = cue.sourceText ? cue.sourceText.trim() : "";

    const words = text.split(/\s+/);
    const sourceWords = sourceText ? sourceText.split(/\s+/) : [];
    const totalWords = words.length;

    // Don't split if text is already short and easily readable (<= 45 chars and <= 8 words)
    const isTooLong =
      (dur > 5.2 && (text.length > 45 || words.length > 8)) ||
      text.length > 70 ||
      dur > 8.0;

    if (!isTooLong || totalWords < 2) {
      result.push({
        ...cue,
        id: nextId++,
        lines: wrapSoraniLines(text, 36),
      });
      continue;
    }

    // Determine how many pieces to cut it into (2 or 3 pieces)
    const numPieces = dur >= 8.5 || text.length >= 85 ? 3 : 2;

    if (totalWords < numPieces) {
      result.push({
        ...cue,
        id: nextId++,
        lines: wrapSoraniLines(text, 36),
      });
      continue;
    }

    const pieceDur = dur / numPieces;
    const targetWordsPerPiece = Math.round(totalWords / numPieces);
    const sourceWordsPerPiece = Math.round((sourceWords.length || 0) / numPieces);

    let wordIdx = 0;
    let sourceIdx = 0;

    for (let p = 0; p < numPieces; p++) {
      const isLast = p === numPieces - 1;
      const pStart = cue.start + p * pieceDur;
      const pEnd = isLast ? cue.end : cue.start + (p + 1) * pieceDur;

      let endWordIdx: number;
      if (isLast) {
        endWordIdx = totalWords;
      } else {
        endWordIdx = Math.min(
          totalWords - (numPieces - p - 1),
          wordIdx + targetWordsPerPiece,
        );
      }

      const pWords = words.slice(wordIdx, endWordIdx);
      wordIdx = endWordIdx;

      let pSourceText = "";
      if (sourceWords.length > 0) {
        const nextSourceIdx = isLast
          ? sourceWords.length
          : Math.min(sourceWords.length, sourceIdx + sourceWordsPerPiece);
        pSourceText = sourceWords.slice(sourceIdx, nextSourceIdx).join(" ");
        sourceIdx = nextSourceIdx;
      }

      const pieceText = pWords.join(" ").trim();
      if (pieceText.length > 0) {
        result.push({
          id: nextId++,
          start: Number(pStart.toFixed(2)),
          end: Number(pEnd.toFixed(2)),
          sourceText: pSourceText,
          kurdishText: pieceText,
          lines: wrapSoraniLines(pieceText, 36),
        });
      }
    }
  }

  return result;
}

async function callGemini(
  texts: string[],
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const promptText = `Translate the following ${texts.length} subtitle lines into Sorani Kurdish:\n${JSON.stringify(texts)}`;

  const payload: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        parts: [{ text: promptText }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const raw = await response.text();

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const errJson = JSON.parse(raw);
      if (errJson?.error?.message) {
        errorMsg = errJson.error.message;
      }
    } catch {
      // ignore
    }
    throw new Error(errorMsg);
  }

  let parsedResponse: any;
  try {
    parsedResponse = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned invalid response JSON");
  }

  const candidate = parsedResponse?.candidates?.[0];
  const contentText = candidate?.content?.parts?.[0]?.text;
  if (!contentText) {
    throw new Error("Gemini returned empty candidate content");
  }

  let data: { translations?: string[] };
  try {
    data = JSON.parse(contentText);
  } catch {
    throw new Error("Could not parse structured translations array from Gemini");
  }

  const translations = data.translations;
  if (!Array.isArray(translations)) {
    throw new Error("Translations property is not an array");
  }

  if (translations.length !== texts.length) {
    throw new Error(
      `Count mismatch: sent ${texts.length} lines, but received ${translations.length} translations`,
    );
  }

  return translations;
}

/**
 * Translates acoustic speech cues into Sorani Kurdish using Gemini Thinking.
 * Automatically spreads long speech segments into 2-3 concise pieces so subtitles never cover the video.
 */
export async function translateAcousticCuesToSorani(
  cues: AcousticCue[],
  onProgress?: (p: TranslationProgress) => void,
  signal?: AbortSignal,
): Promise<SubtitleCue[]> {
  if (cues.length === 0) return [];

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  const primaryModel = getGeminiTranslateModel();
  const modelsToTry = [
    primaryModel,
    ...FALLBACK_GEMINI_TRANSLATE_MODELS.filter((m) => m !== primaryModel),
  ];

  const totalCues = cues.length;
  const batches: { startIdx: number; cues: AcousticCue[] }[] = [];

  for (let i = 0; i < totalCues; i += MAX_BATCH_SIZE) {
    batches.push({
      startIdx: i,
      cues: cues.slice(i, i + MAX_BATCH_SIZE),
    });
  }

  const translatedRawCues: SubtitleCue[] = new Array(totalCues);
  let processedCount = 0;

  for (let b = 0; b < batches.length; b++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    const batch = batches[b];
    const originalTexts = batch.cues.map((c) => c.text);

    let batchTranslations: string[] | null = null;
    let lastError: Error | null = null;

    // Try models in cascade if one fails with 503 / high demand
    for (const model of modelsToTry) {
      try {
        batchTranslations = await callGemini(originalTexts, model, apiKey, signal);
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`Gemini model ${model} failed: ${err.message}. Trying fallback...`);
      }
    }

    if (!batchTranslations) {
      throw lastError || new Error("Failed to translate batch with Gemini");
    }

    // Map translated lines back into SubtitleCues
    for (let i = 0; i < batch.cues.length; i++) {
      const orig = batch.cues[i];
      const translatedText = batchTranslations[i] || orig.text;
      const wrapped = wrapSoraniLines(translatedText, 36);

      translatedRawCues[batch.startIdx + i] = {
        id: orig.id,
        start: orig.start,
        end: orig.end,
        sourceText: orig.text,
        kurdishText: translatedText,
        lines: wrapped,
      };
    }

    processedCount += batch.cues.length;
    onProgress?.({
      currentBatch: b + 1,
      totalBatches: batches.length,
      processedCues: processedCount,
      totalCues,
    });
  }

  // Spread and cut long speech segments into 2-3 piece short subtitles
  return spreadAndSplitLongCues(translatedRawCues);
}
