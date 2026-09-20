// Dynamic Font Loading & Registration for SoraniSubs
// Supports user-uploaded font files (.ttf, .otf, .woff, .woff2) & KurdFonts webfonts

export interface CustomFontRecord {
  id: string;
  name: string;
  family: string;
  bytes: Uint8Array;
}

const loadedFontFaces = new Set<string>();
const fontBytesCache = new Map<string, Uint8Array>();

/**
 * Returns cached Uint8Array font bytes for burning / rasterizing, if loaded.
 */
export function getLoadedFontBytes(nameOrId: string): Uint8Array | null {
  return fontBytesCache.get(nameOrId) || null;
}

/**
 * Loads a user-uploaded font file, registers it with document.fonts so it renders in the DOM,
 * and retains raw font bytes for WebAssembly / libass video burning.
 */
export async function loadFontFile(file: File): Promise<CustomFontRecord> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Derive a valid CSS font-family name
  const rawName = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
  const cleanName = rawName || "UploadedFont";
  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const familyName = `UserFont_${cleanName.replace(/\s+/g, "_")}_${id}`;

  try {
    const fontFace = new FontFace(cleanName, buffer);
    await fontFace.load();
    document.fonts.add(fontFace);
    loadedFontFaces.add(cleanName);
    loadedFontFaces.add(familyName);
    
    // Cache bytes for libass burning
    fontBytesCache.set(id, bytes);
    fontBytesCache.set(cleanName, bytes);
  } catch (err) {
    console.error("Failed to register FontFace in document.fonts:", err);
    throw new Error(`Could not parse or load font "${file.name}". Please ensure it is a valid .ttf, .otf, or .woff file.`);
  }

  return {
    id,
    name: cleanName,
    family: `'${cleanName}', '${familyName}', 'Noto Kufi Arabic', sans-serif`,
    bytes,
  };
}

/**
 * Loads a remote or locally-hosted webfont by name and URL, adding it to document.fonts
 * so that captions and UI render instantly in that font, and caches bytes for video burning.
 */
export async function loadWebFont(name: string, url: string): Promise<Uint8Array | null> {
  if (fontBytesCache.has(name) && loadedFontFaces.has(name)) {
    return fontBytesCache.get(name)!;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    fontBytesCache.set(name, bytes);

    if (!loadedFontFaces.has(name)) {
      const fontFace = new FontFace(name, buffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      loadedFontFaces.add(name);
    }
    return bytes;
  } catch (err) {
    console.warn(`Could not load web font ${name} from ${url}:`, err);
    return null;
  }
}
