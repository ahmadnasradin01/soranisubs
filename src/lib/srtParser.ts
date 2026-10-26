/**
 * SoraniSubs - High-Fidelity SRT & VTT Subtitle Parser
 *
 * Fully parses SubRip (.srt) and WebVTT (.vtt) files:
 * - Robust regex matching for timestamps with comma or period millisecond delimiters
 * - Supports hours-optional timestamps (e.g. 01:23.450 --> 01:25.800)
 * - Strips WebVTT headers, cues settings, and HTML formatting tags (<b>, <i>, <font>)
 * - Accurately extracts clean Kurdish Sorani text lines and builds unified Cue objects
 * - Zero external dependencies, runs offline and in-browser with 100% reliability
 */

export interface ParsedSubtitleCue {
  id: number;
  start: number;
  end: number;
  lines: string[];
  kurdishText: string;
  sourceText?: string;
}

/**
 * Converts a time string (HH:MM:SS,mmm or HH:MM:SS.mmm or MM:SS.mmm) into seconds.
 */
function parseTimeString(timeStr: string): number | null {
  const clean = timeStr.trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);
    if (isNaN(hrs) || isNaN(mins) || isNaN(secs)) return null;
    return hrs * 3600 + mins * 60 + secs;
  } else if (parts.length === 2) {
    const mins = parseFloat(parts[0]);
    const secs = parseFloat(parts[1]);
    if (isNaN(mins) || isNaN(secs)) return null;
    return mins * 60 + secs;
  }
  return null;
}

/**
 * Parses raw SRT or VTT text content into an array of ParsedSubtitleCue.
 */
export function parseSrtOrVtt(content: string): ParsedSubtitleCue[] {
  if (!content || typeof content !== "string") return [];

  // Remove BOM and normalize line endings
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalized) return [];

  // Match timestamp arrow lines: "00:00:01,000 --> 00:00:04,000" or with VTT settings
  const arrowRegex = /(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)/;

  // Split into blocks separated by blank lines
  const rawBlocks = normalized.split(/\n\s*\n/);
  const cues: ParsedSubtitleCue[] = [];

  for (const block of rawBlocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) continue;

    let timeLineIdx = -1;
    let startSec: number | null = null;
    let endSec: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const match = arrowRegex.exec(lines[i]);
      if (match) {
        const s = parseTimeString(match[1]);
        const e = parseTimeString(match[2]);
        if (s !== null && e !== null && e > s) {
          timeLineIdx = i;
          startSec = s;
          endSec = e;
          break;
        }
      }
    }

    if (timeLineIdx === -1 || startSec === null || endSec === null) {
      continue;
    }

    // Text lines are everything after the timestamp line
    const textLines = lines
      .slice(timeLineIdx + 1)
      // Strip HTML tags like <b>, <i>, <u>, <font color=...>, <c.yellow>
      .map((l) => l.replace(/<[^>]*>/g, "").trim())
      // Strip VTT comments or cues
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("NOTE") &&
          !l.startsWith("STYLE") &&
          !l.startsWith("REGION")
      );

    if (textLines.length === 0) continue;

    const kurdish = textLines.join(" ");

    cues.push({
      id: cues.length + 1,
      start: Number(startSec.toFixed(2)),
      end: Number(endSec.toFixed(2)),
      lines: textLines,
      kurdishText: kurdish,
      sourceText: "",
    });
  }

  // Sort cues chronologically by start timestamp
  cues.sort((a, b) => a.start - b.start);

  // Re-number IDs sequentially
  cues.forEach((c, idx) => {
    c.id = idx + 1;
  });

  return cues;
}
