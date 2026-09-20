// Dedicated Gemini Flash Lite audio transcription service.
// Directly listens to the audio track and extracts subtitle cues with exact voice-synchronized timestamps.

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
  getGeminiApiKey,
  getGeminiTranscribeModel,
  FALLBACK_GEMINI_TRANSCRIBE_MODELS,
} from "./config";

const TARGET_SAMPLE_RATE = 16_000;

export interface TranscriptionProgress {
  stage: "extracting" | "transcribing" | "ready";
  fraction: number;
  note: string;
}

export interface AcousticCue {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface GeminiTranscriptionResult {
  cues: AcousticCue[];
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

const TRANSCRIBE_PROMPT = `You are a professional audio subtitler and timestamp specialist.
Analyze the audio track and transcribe the spoken speech into short, precise subtitle cues with exact acoustic timestamps.

CRITICAL RULES FOR ACCURATE SUBTITLES & TIMESTAMPS:
1. MAXIMUM CUE LENGTH (2.0 to 4.5 seconds):
   - Every cue must be short and comfortable to read on screen (maximum 5 to 9 words per cue).
   - NEVER create a single long cue exceeding 5 seconds!
   - If a spoken sentence takes 6, 8, 10, or 12 seconds, you MUST cut it into 2 or 3 short sequential pieces at natural pauses, conjunctions, or clause boundaries so the text is spread across the speaker's cadence.
2. VOICE SYNCHRONIZATION:
   - "start": The exact second (float) when the first word of this cue begins being spoken.
   - "end": The exact second (float) when the last word of this cue finishes being spoken.
3. SILENCE & PAUSES:
   - NEVER keep a subtitle active during silence, pauses, or breath gaps.
   - NEVER start a subtitle before speech begins.
   - If the speaker stops speaking or pauses between sentences or thoughts, END the cue immediately. Start a new cue when speech resumes.
4. NO MERGING ACROSS PAUSES:
   - Never link words spoken seconds apart across a pause.
5. ACCURACY:
   - Transcribe words faithfully as spoken in the original language.`;

const TRANSCRIBE_SCHEMA = {
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
          text: { type: "STRING" },
        },
        required: ["id", "start", "end", "text"],
      },
    },
  },
  required: ["cues"],
};

/**
 * Transcribe video audio directly using Gemini Flash Lite.
 */
export async function transcribeWithGeminiFlashLite(
  file: File,
  onProgress?: (p: TranscriptionProgress) => void,
  signal?: AbortSignal,
): Promise<GeminiTranscriptionResult> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  // 1. Extract audio
  onProgress?.({
    stage: "extracting",
    fraction: 0.1,
    note: "Extracting audio from video...",
  });

  const { samples, duration } = await extractMonoAudio(
    file,
    (frac) =>
      onProgress?.({
        stage: "extracting",
        fraction: 0.1 + frac * 0.3,
        note: `Extracting audio (${Math.round(frac * 100)}%)...`,
      }),
    signal,
  );

  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

  // 2. Encode to WAV Base64
  onProgress?.({
    stage: "transcribing",
    fraction: 0.45,
    note: "Preparing audio for Gemini Flash Lite...",
  });

  const wavBuffer = wavFrom(samples);
  const audioBase64 = arrayBufferToBase64(wavBuffer);

  // 3. Send audio to Gemini Flash Lite
  onProgress?.({
    stage: "transcribing",
    fraction: 0.55,
    note: "Listening and detecting speech timestamps with Gemini Flash Lite...",
  });

  const primaryModel = getGeminiTranscribeModel();
  const candidateModels = [
    primaryModel,
    ...FALLBACK_GEMINI_TRANSCRIBE_MODELS.filter((m) => m !== primaryModel),
  ];

  let lastError: Error | null = null;
  let parsedResult: {
    detected_language?: string;
    cues: { id: number; start: number; end: number; text: string }[];
  } | null = null;

  for (const model of candidateModels) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
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
                  text: TRANSCRIBE_PROMPT,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: TRANSCRIBE_SCHEMA,
          },
        }),
        signal,
      });

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
      const contentPart = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!contentPart) {
        throw new Error(`Gemini (${model}) returned an empty response.`);
      }

      const parsed = JSON.parse(contentPart);
      if (Array.isArray(parsed.cues) && parsed.cues.length > 0) {
        parsedResult = parsed;
        break;
      } else if (Array.isArray(parsed) && parsed.length > 0) {
        parsedResult = { cues: parsed };
        break;
      } else {
        throw new Error(`Gemini (${model}) detected no speech cues.`);
      }
    } catch (err: any) {
      if (err.name === "AbortError") throw err;
      lastError = err;
      console.warn(`Model ${model} transcription failed:`, err);
    }
  }

  if (!parsedResult || !parsedResult.cues || parsedResult.cues.length === 0) {
    throw (
      lastError ||
      new Error("Could not transcribe audio with Gemini Flash Lite.")
    );
  }

  // 4. Validate and sort acoustic cues
  const cleanCues: AcousticCue[] = parsedResult.cues
    .map((c, idx) => ({
      id: typeof c.id === "number" ? c.id : idx + 1,
      start: Math.max(0, parseFloat(String(c.start)) || 0),
      end: Math.min(duration, parseFloat(String(c.end)) || 0),
      text: (c.text || "").trim(),
    }))
    .filter((c) => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  // Fix any minor timestamp overlaps between adjacent cues
  for (let i = 0; i < cleanCues.length - 1; i++) {
    const current = cleanCues[i];
    const next = cleanCues[i + 1];
    if (current.end > next.start) {
      current.end = Math.max(current.start + 0.5, next.start - 0.05);
    }
  }

  onProgress?.({
    stage: "ready",
    fraction: 1.0,
    note: `Detected ${cleanCues.length} speech segments.`,
  });

  return {
    cues: cleanCues,
    language: parsedResult.detected_language || "Auto-detected",
    duration,
  };
}
