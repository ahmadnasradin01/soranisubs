// Direct Audio-to-Sorani Kurdish Subtitle Generation Service.
// Feeds extracted audio directly to Gemini 3.8 Flash Thinking in one single pass.
// Directly detects speech, acoustics, voice timestamps, and translates to idiomatic Sorani Kurdish.

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
  getGeminiApiKey,
  getAllGeminiApiKeys,
  getGeminiModel,
  FALLBACK_GEMINI_MODELS,
} from "./config";
import {
  wrapSoraniLines,
  type SubtitleCue,
} from "./soraniTranslation";

const TARGET_SAMPLE_RATE = 16_000;

export interface DirectSubtitlesProgress {
  stage: "extracting" | "translating" | "ready";
  fraction: number;
  note: string;
}

export interface DirectSubtitlesResult {
  cues: SubtitleCue[];
  language: string;
  duration: number;
}

/** Resample via OfflineAudioContext. */
async function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Promise<Float32Array> {
  const frames = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const context = new OfflineAudioContext(1, frames, toRate);
  const buffer = context.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

/**
 * Extracts 16 kHz mono PCM audio from a video file in the browser.
 */
export async function extractMonoAudio(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ samples: Float32Array; duration: number }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      throw new Error("The selected video has no audio track.");
    }

    const duration = await input.computeDuration();
    if (duration <= 0) {
      throw new Error("Video has zero duration.");
    }

    const sink = new AudioBufferSink(track);
    const chunks: Float32Array[] = [];
    let totalFrames = 0;
    let sourceRate = TARGET_SAMPLE_RATE;

    for await (const wrapped of sink.buffers(0, duration)) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const buffer = wrapped.buffer;
      sourceRate = buffer.sampleRate;

      // Downmix to mono
      const frames = buffer.length;
      const mono = new Float32Array(frames);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const channelData = buffer.getChannelData(c);
        for (let i = 0; i < frames; i++) {
          mono[i] += channelData[i];
        }
      }
      if (buffer.numberOfChannels > 1) {
        for (let i = 0; i < frames; i++) {
          mono[i] /= buffer.numberOfChannels;
        }
      }

      chunks.push(mono);
      totalFrames += frames;
      onProgress?.(Math.min(1, wrapped.timestamp / duration));
    }

    if (totalFrames === 0) {
      throw new Error("Could not decode audio samples from the video.");
    }

    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    if (Math.abs(sourceRate - TARGET_SAMPLE_RATE) < 1) {
      return { samples: merged, duration };
    }

    const resampled = await resample(merged, sourceRate, TARGET_SAMPLE_RATE);
    return { samples: resampled, duration };
  } finally {
    input.dispose();
  }
}

/** Wrap mono 16 kHz float samples as a 16-bit PCM WAV. */
export function wavFrom(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

/** Convert ArrayBuffer to Base64 efficiently without stack overflow. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

const DIRECT_SUBTITLES_PROMPT = `You are a precision audio subtitler and acoustic timing expert for Sorani Kurdish (کوردیی ناوەندی / Central Kurdish / ckb).
Listen intently to the acoustic audio track (speech, song lyrics, vocals with music background).
Detect spoken or sung phrases with millisecond-exact vocal onset and release boundaries, and translate directly into authentic Sorani Kurdish subtitles in Central Kurdish Arabic script (ئەلفوبێی کوردی).

CRITICAL ACOUSTIC SYNCHRONIZATION & LYRICS TIMING RULES:
1. EXACT VOCAL ONSET & RELEASE (High-Precision Floats):
   - "start": The EXACT second (float with 2 decimal places, e.g. 2.14) when the speaker or singer begins vocalizing the first syllable of this line.
     * NEVER start before the voice/singing begins!
     * NEVER display the subtitle prematurely while the speaker is silent or while music is playing!
   - "end": The EXACT second (float with 2 decimal places, e.g. 4.38) when the speaker or singer finishes vocalizing the last syllable.
     * NEVER keep a subtitle active during instrumental breaks, guitar/piano interludes, or silence!
   - NEVER round timestamps to full integers (never output 2.0 or 5.0 unless voice strictly starts/stops at that exact second).

2. SONG LYRICS & MUSICAL TIMING:
   - For songs, poetry, and music videos: each sung lyric line, verse phrase, or chorus bar MUST be its own distinct subtitle cue.
   - If a lyric line is sung in 1.2 seconds, keep "start" and "end" strictly matching those 1.2 seconds! Do NOT stretch it into the music!
   - NEVER show a lyric line before the singer starts singing!
   - If there is an instrumental music break, guitar solo, beat, or pause between lines, NO subtitle should be active during that break!

3. SPOKEN SPEECH & DIALOGUE:
   - Break continuous speech at the speaker's natural acoustic breath pauses or clause boundaries (typically 1.5 to 3.8 seconds per cue, 4 to 8 words).
   - If the speaker pauses between sentences, end the current cue immediately. Start a new cue when speech resumes.

4. STRICT CHRONOLOGY:
   - All cues MUST be in strict chronological order with "start" strictly less than "end".
   - Adjacent cues must not overlap.

5. AUTHENTIC SORANI KURDISH:
   - Natural spoken Kurdish register appropriate for video subtitles.
   - Always use proper Kurdish alphabet characters (پ، چ، ژ، گ، ڤ، ڕ، ڵ، ۆ، ێ، ە).
   - Preserve proper nouns, numbers, and technical terms accurately.
   - Also provide "source_text" with the original spoken/sung words.`;

const DIRECT_SUBTITLES_SCHEMA = {
  type: "OBJECT",
  properties: {
    detected_language: { type: "STRING" },
    cues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER" },
          start: { type: "NUMBER" },
          end: { type: "NUMBER" },
          source_text: { type: "STRING" },
          kurdish_text: { type: "STRING" },
        },
        required: ["id", "start", "end", "kurdish_text"],
      },
    },
  },
  required: ["cues"],
};

/**
 * Robust JSON extractor that handles markdown code fences, trailing comments,
 * and duplicate closing braces that some thinking/preview models emit.
 */
function extractValidJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {}

  const clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {}

  // Balanced brace scan for object
  const startIdx = clean.indexOf("{");
  if (startIdx !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < clean.length; i++) {
      const char = clean[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(clean.slice(startIdx, i + 1));
            } catch {}
          }
        }
      }
    }
  }

  // Balanced bracket scan for array
  const arrStartIdx = clean.indexOf("[");
  if (arrStartIdx !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = arrStartIdx; i < clean.length; i++) {
      const char = clean[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "[") depth++;
        else if (char === "]") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(clean.slice(arrStartIdx, i + 1));
            } catch {}
          }
        }
      }
    }
  }

  // Regex fallback: extract cues individually if overall JSON wrapper is truncated or malformed
  const cueMatches = [
    ...clean.matchAll(
      /\{\s*"id"\s*:\s*(\d+)\s*,\s*"start"\s*:\s*([0-9.]+)\s*,\s*"end"\s*:\s*([0-9.]+)(?:[^{}]*?"source_text"\s*:\s*"([^"]*)")?[^{}]*?"kurdish_text"\s*:\s*"([^"]*)"/g,
    ),
  ];
  if (cueMatches.length > 0) {
    const extractedCues = cueMatches.map((m) => ({
      id: parseInt(m[1], 10),
      start: parseFloat(m[2]),
      end: parseFloat(m[3]),
      source_text: m[4] || "",
      kurdish_text: m[5] || "",
    }));
    return { cues: extractedCues };
  }

  throw new Error("Could not parse valid JSON from model response.");
}

/**
 * Directly translates video audio into Sorani Kurdish subtitles in one single pass using Gemini.
 */
export async function generateSoraniSubtitlesDirect(
  file: File,
  onProgress?: (p: DirectSubtitlesProgress) => void,
  signal?: AbortSignal,
): Promise<DirectSubtitlesResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  // 1. Extract audio
  onProgress?.({
    stage: "extracting",
    fraction: 0.1,
    note: "Extracting 16 kHz audio track from video...",
  });

  const { samples, duration } = await extractMonoAudio(
    file,
    (frac) =>
      onProgress?.({
        stage: "extracting",
        fraction: 0.1 + frac * 0.35,
        note: `Extracting audio (${Math.round(frac * 100)}%)...`,
      }),
    signal,
  );

  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

  // 2. Encode to WAV Base64
  onProgress?.({
    stage: "translating",
    fraction: 0.5,
    note: "Encoding audio stream for Gemini Flash Thinking...",
  });

  const wavBuffer = wavFrom(samples);
  const audioBase64 = arrayBufferToBase64(wavBuffer);

  // 3. Send audio directly to Gemini Flash Thinking in one go
  const primaryModel = getGeminiModel();
  const candidateModels = [
    primaryModel,
    ...FALLBACK_GEMINI_MODELS.filter((m) => m !== primaryModel),
  ];
  const apiKeys = getAllGeminiApiKeys();
  const keysToTry = apiKeys.length > 0 ? apiKeys : ["__SERVER_PROXY__"];

  onProgress?.({
    stage: "translating",
    fraction: 0.65,
    note: `Listening & translating directly to Sorani Kurdish with ${primaryModel}...`,
  });

  let lastError: Error | null = null;
  let parsedResult: {
    detected_language?: string;
    cues: {
      id: number;
      start: number;
      end: number;
      source_text?: string;
      kurdish_text: string;
    }[];
  } | null = null;

  modelLoop: for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx];
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    for (let kIdx = 0; kIdx < keysToTry.length; kIdx++) {
      const currentKey = keysToTry[kIdx];
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

      if (mIdx > 0 || kIdx > 0) {
        const prevErrNote = lastError?.message ? ` (${lastError.message.slice(0, 45)})` : "";
        onProgress?.({
          stage: "translating",
          fraction: 0.65 + mIdx * 0.03,
          note:
            kIdx > 0
              ? `Retrying ${model} with alternate key (${kIdx + 1}/${keysToTry.length})${prevErrNote}...`
              : `Switching to model ${model}${prevErrNote}...`,
        });
      }

      // Dynamic timeout: scaled by audio duration (minimum 90 seconds, up to 2.2x duration)
      // Thinking preview models need time to analyze acoustics and reasoning tokens
      const attemptTimeoutMs = Math.max(90_000, Math.round(duration * 2_200));
      const attemptController = new AbortController();
      const timeoutId = setTimeout(() => attemptController.abort("Timeout"), attemptTimeoutMs);
      const onUserAbort = () => attemptController.abort("Cancelled");
      if (signal) signal.addEventListener("abort", onUserAbort);

      try {
        const isServerProxy = currentKey === "__SERVER_PROXY__";
        const url = isServerProxy
          ? "/api/gemini"
          : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;
        
        // Prepare generationConfig with thinkingBudget: 0 for thinking/preview models
        // to cut response latency from ~40s to ~9-17s with peak Kurdish accuracy
        const generationConfig: Record<string, any> = {
          responseMimeType: "application/json",
          responseSchema: DIRECT_SUBTITLES_SCHEMA,
        };

        // For thinking models, allocate a focused thinking budget (1024 tokens)
        // to enable deep audio acoustic waveform reasoning and exact millisecond time alignment
        if (
          model.includes("robotics") ||
          model.includes("preview") ||
          model.includes("thinking") ||
          model.includes("3.8") ||
          model.includes("3.7")
        ) {
          generationConfig.thinkingConfig = { thinkingBudget: 1024 };
        }

        let res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/wav",
                      data: audioBase64,
                    },
                  },
                  {
                    text: DIRECT_SUBTITLES_PROMPT,
                  },
                ],
              },
            ],
            generationConfig,
          }),
          signal: attemptController.signal,
        });

        // If a model rejects thinkingConfig with 400, retry without thinkingConfig
        if (res.status === 400 && generationConfig.thinkingConfig) {
          const errBody = await res.text();
          if (
            errBody.toLowerCase().includes("thinkingconfig") ||
            errBody.toLowerCase().includes("thinking_config")
          ) {
            delete generationConfig.thinkingConfig;
            res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "audio/wav",
                          data: audioBase64,
                        },
                      },
                      {
                        text: DIRECT_SUBTITLES_PROMPT,
                      },
                    ],
                  },
                ],
                generationConfig,
              }),
              signal: attemptController.signal,
            });
          } else {
            let message = `Gemini (${model}) returned status 400`;
            try {
              const errJson = JSON.parse(errBody);
              if (errJson?.error?.message) message = errJson.error.message;
            } catch {}
            throw new Error(message);
          }
        }

        if (!res.ok) {
          const errorText = await res.text();
          let message = `Gemini (${model}) returned status ${res.status}`;
          try {
            const errJson = JSON.parse(errorText);
            if (errJson?.error?.message) message = errJson.error.message;
          } catch {
            // ignore
          }
          throw new Error(message);
        }

        const resJson = await res.json();
        const parts = resJson?.candidates?.[0]?.content?.parts || [];
        const rawContent = parts
          .map((p: any) => p.text || "")
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!rawContent) {
          throw new Error(`Gemini (${model}) returned an empty response.`);
        }

        const parsed = extractValidJson(rawContent);
        if (Array.isArray(parsed.cues) && parsed.cues.length > 0) {
          parsedResult = parsed;
          break modelLoop;
        } else if (Array.isArray(parsed) && parsed.length > 0) {
          parsedResult = { cues: parsed };
          break modelLoop;
        } else {
          throw new Error(`Gemini (${model}) detected no speech cues.`);
        }
      } catch (err: any) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        lastError = err;
        console.warn(
          `Model ${model} with API key ${kIdx + 1}/${apiKeys.length} failed:`,
          err.message || err,
        );
      } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener("abort", onUserAbort);
      }
    }
  }

  if (!parsedResult || !parsedResult.cues || parsedResult.cues.length === 0) {
    throw (
      lastError ||
      new Error("Could not translate audio to Sorani Kurdish with Gemini Flash.")
    );
  }

  // 4. Validate, wrap lines, and preserve authentic acoustic timestamps
  const parsedCues: SubtitleCue[] = parsedResult.cues
    .map((c, idx) => {
      const kurdish = (c.kurdish_text || "").trim();
      const start = Math.max(0, parseFloat(String(c.start)) || 0);
      const end = Math.min(duration, parseFloat(String(c.end)) || 0);
      return {
        id: typeof c.id === "number" ? c.id : idx + 1,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        sourceText: (c.source_text || "").trim(),
        kurdishText: kurdish,
        lines: wrapSoraniLines(kurdish, 36),
      };
    })
    .filter((c) => c.kurdishText.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  // Use the exact acoustic timestamps directly from Gemini without artificial splitting or shifting
  const finalizedCues = parsedCues;

  // Resolve any slight overlap between adjacent cues without artificially shifting boundaries
  for (let i = 0; i < finalizedCues.length; i++) {
    const current = finalizedCues[i];
    const next = finalizedCues[i + 1];

    // Resolve overlap: cue must not step into the next speaker's onset
    if (next && current.end > next.start) {
      current.end = Number(Math.max(current.start + 0.1, next.start - 0.02).toFixed(2));
    }
  }

  onProgress?.({
    stage: "ready",
    fraction: 1.0,
    note: `Prepared ${finalizedCues.length} voice-synchronized Kurdish subtitle segments.`,
  });

  return {
    cues: finalizedCues,
    language: parsedResult.detected_language || "Auto-detected",
    duration,
  };
}
