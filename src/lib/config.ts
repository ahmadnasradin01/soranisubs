// Configuration store for SoraniSubs Sorani Kurdish Subtitler.
// Holds Google Gemini API key and model preferences with localStorage persistence.

const STORAGE_KEYS = {
  GEMINI_API_KEY: "soranisubs_gemini_api_key",
  GEMINI_MODEL: "soranisubs_gemini_model",
  LEGACY_GEMINI_API_KEY: "opensubs_gemini_api_key",
  LEGACY_GEMINI_MODEL: "opensubs_gemini_model",
} as const;

// Gemini API key resolution from environment variables (Vite) or user configuration.
// Hardcoded secret keys are NEVER stored in this file to prevent Git/public exposure.
export const DEFAULT_GEMINI_API_KEY =
  (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim() || "";

export const FALLBACK_GEMINI_API_KEYS: string[] = [
  (import.meta.env.VITE_GEMINI_API_KEY_FALLBACK_1 as string | undefined)?.trim(),
  (import.meta.env.VITE_GEMINI_API_KEY_FALLBACK_2 as string | undefined)?.trim(),
].filter((k): k is string => Boolean(k && k.length > 0));

// Primary default model: Gemini 3.8 Flash (with Thinking)
// Default fallback chain: Gemini 3.8 Flash -> Gemini 3.0 Flash -> Gemini 2.5 Flash
// (3.7, 3.6, 3.5, robotics, etc. are ignored from fallback unless selected manually in settings)
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const CORE_FALLBACK_MODELS = [
  "gemini-3.8-flash",
  "gemini-3-flash-preview", // 3.0 Flash
  "gemini-2.5-flash",
];
export const FALLBACK_GEMINI_MODELS = CORE_FALLBACK_MODELS;

// Legacy exports for backwards compatibility
export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = DEFAULT_GEMINI_MODEL;
export const DEFAULT_GEMINI_TRANSLATE_MODEL = DEFAULT_GEMINI_MODEL;
export const FALLBACK_GEMINI_TRANSCRIBE_MODELS = FALLBACK_GEMINI_MODELS;
export const FALLBACK_GEMINI_TRANSLATE_MODELS = FALLBACK_GEMINI_MODELS;

export function getAllGeminiApiKeys(): string[] {
  const activeKey = getGeminiApiKey();
  const set = new Set<string>();
  if (activeKey) set.add(activeKey);
  for (const k of FALLBACK_GEMINI_API_KEYS) {
    if (k) set.add(k);
  }
  if (DEFAULT_GEMINI_API_KEY) set.add(DEFAULT_GEMINI_API_KEY);
  return Array.from(set);
}

export function getGeminiApiKey(): string {
  if (typeof localStorage === "undefined") return DEFAULT_GEMINI_API_KEY;
  return (
    localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY)?.trim() ||
    localStorage.getItem(STORAGE_KEYS.LEGACY_GEMINI_API_KEY)?.trim() ||
    DEFAULT_GEMINI_API_KEY
  );
}

export function setGeminiApiKey(key: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEYS.GEMINI_API_KEY, key.trim());
  }
}

export function getGeminiModel(): string {
  if (typeof localStorage === "undefined") return DEFAULT_GEMINI_MODEL;
  const stored =
    localStorage.getItem(STORAGE_KEYS.GEMINI_MODEL)?.trim() ||
    localStorage.getItem(STORAGE_KEYS.LEGACY_GEMINI_MODEL)?.trim();
  // Automatically migrate legacy/test defaults to gemini-3.8-flash
  if (
    !stored ||
    stored === "gemini-robotics-er-2-preview" ||
    stored === "gemini-1.5-flash" ||
    stored === "gemini-flash-latest"
  ) {
    return DEFAULT_GEMINI_MODEL;
  }
  return stored;
}

export function setGeminiModel(model: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEYS.GEMINI_MODEL, model.trim());
  }
}

// Aliases
export function getGeminiTranscribeModel(): string {
  return getGeminiModel();
}

export function setGeminiTranscribeModel(model: string): void {
  setGeminiModel(model);
}

export function getGeminiTranslateModel(): string {
  return getGeminiModel();
}

export function setGeminiTranslateModel(model: string): void {
  setGeminiModel(model);
}
