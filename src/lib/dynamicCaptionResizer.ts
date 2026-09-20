/**
 * SoraniSubs - Smart Dynamic Caption Resizer
 *
 * Dynamically computes optimal font size, line wrapping, line height,
 * max-width, padding, and bottom clearance based on:
 * 1. Screen / Player container dimensions (width & height in px)
 * 2. Video aspect ratio (landscape 16:9, vertical 9:16, ultra-wide 21:9, square 1:1)
 * 3. Caption wording: character length, word count, longest word length
 * 4. User's base font size preference (default: 16px Medium)
 * 5. Controls visibility & measured controls bar height
 * 6. Fullscreen & safe area metrics
 */

export interface DynamicCaptionOptions {
  containerWidth: number;
  containerHeight: number;
  videoAspectRatio: number;
  captionText: string;
  baseFontSize?: number;
  controlsVisible?: boolean;
  controlsBarHeight?: number;
  isFullscreen?: boolean;
}

export interface DynamicCaptionLayout {
  fontSize: number;          // in px
  lineHeight: number;        // CSS unitless line-height
  lines: string[];           // intelligently wrapped lines
  bottomPx: number;          // distance from bottom of player in px
  maxWidthPct: number;       // badge max-width percentage (e.g. 92)
  padding: string;           // CSS padding string
  containerWidth: number;
  containerHeight: number;
}

/**
 * Balanced Kurdish text line wrapping algorithm.
 * Divides words into 1, 2, or at most 3 balanced lines matching the available
 * character width per line, avoiding orphan words and mid-word breaks.
 */
export function wrapDynamicSoraniLines(text: string, maxCharsPerLine: number): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return [];

  // If text easily fits within a single line limit, don't split
  if (clean.length <= maxCharsPerLine) {
    return [clean];
  }

  const words = clean.split(" ");
  if (words.length <= 1) {
    return [clean];
  }

  // If text is short enough to fit comfortably in 2 balanced lines
  if (clean.length <= maxCharsPerLine * 2.1) {
    let bestSplit = 1;
    let minScore = Infinity;

    for (let i = 1; i < words.length; i++) {
      const line1 = words.slice(0, i).join(" ");
      const line2 = words.slice(i).join(" ");

      // Avoid leaving a single short word (e.g. "لە", "بە", "وەک") on either line
      const line1LastWord = words[i - 1];
      const line2FirstWord = words[i];
      let penalty = 0;
      if (i === 1 && line1LastWord.length <= 3) penalty += 15;
      if (i === words.length - 1 && line2FirstWord.length <= 3) penalty += 15;

      const diff = Math.abs(line1.length - line2.length);
      const score = diff + penalty;

      if (score < minScore) {
        minScore = score;
        bestSplit = i;
      }
    }

    const l1 = words.slice(0, bestSplit).join(" ");
    const l2 = words.slice(bestSplit).join(" ");
    return [l1, l2];
  }

  // For very long text, wrap into 3 balanced lines
  const targetLen = clean.length / 3;
  let split1 = 1;
  let split2 = 2;
  let bestScore = Infinity;

  for (let i = 1; i < words.length - 1; i++) {
    const l1Len = words.slice(0, i).join(" ").length;
    for (let j = i + 1; j < words.length; j++) {
      const l2Len = words.slice(i, j).join(" ").length;
      const l3Len = words.slice(j).join(" ").length;

      const varLen =
        Math.abs(l1Len - targetLen) +
        Math.abs(l2Len - targetLen) +
        Math.abs(l3Len - targetLen);

      if (varLen < bestScore) {
        bestScore = varLen;
        split1 = i;
        split2 = j;
      }
    }
  }

  return [
    words.slice(0, split1).join(" "),
    words.slice(split1, split2).join(" "),
    words.slice(split2).join(" "),
  ].filter((l) => l.length > 0);
}

/**
 * Calculates responsive, dynamic caption layout metrics.
 * Ensures a clear, legible Medium font size on mobile (14.0px - 15.5px)
 * while dynamically adapting to wording length, container size, and aspect ratios.
 */
export function calculateDynamicCaptionLayout(options: DynamicCaptionOptions): DynamicCaptionLayout {
  const {
    containerWidth = 640,
    containerHeight = 360,
    videoAspectRatio = 16 / 9,
    captionText = "",
    baseFontSize = 16,
    controlsVisible = true,
    controlsBarHeight = 60,
    isFullscreen = false,
  } = options;

  const text = captionText.trim();
  const charCount = text.length;
  const words = text ? text.split(/\s+/) : [];
  const wordCount = words.length;

  // Find longest word to prevent overflow
  let maxWordLen = 0;
  for (const w of words) {
    if (w.length > maxWordLen) maxWordLen = w.length;
  }

  const isVertical = videoAspectRatio < 0.95;
  const isSmallScreen = containerWidth < 480 || containerHeight < 270;
  const isTinyScreen = containerWidth < 350 || containerHeight < 200;

  // 1. Gentle responsive container scaling:
  // Desktop (640px): 1.0 -> 16px
  // Mobile (360px): widthRatio = 0.5625 -> containerScale = 0.922 -> ~14.8px (True Medium!)
  const widthRatio = Math.max(0.5, Math.min(1.8, containerWidth / 640));
  const containerScale = Math.pow(widthRatio, 0.14);

  // 2. Container Height Constraint (only kicks in for extremely shallow letterboxed players)
  let heightScale = 1.0;
  if (containerHeight < 190) {
    heightScale = Math.max(0.92, containerHeight / 190);
  } else if (isVertical) {
    heightScale = 1.02;
  }

  // 3. Caption Length Scaling:
  // Short/medium text stays prominent; long multi-clause text tightens slightly
  let lengthScale = 1.0;
  if (charCount <= 35) {
    lengthScale = 1.0;
  } else if (charCount <= 65) {
    lengthScale = 0.96;
  } else if (charCount <= 95) {
    lengthScale = 0.91;
  } else {
    lengthScale = 0.86;
  }

  let computedSize = baseFontSize * containerScale * heightScale * lengthScale;

  // 4. Longest word safety check
  const badgeMaxWidthPct = isTinyScreen ? 94 : isSmallScreen ? 92 : isVertical ? 86 : 88;
  const availableBadgeWidth = containerWidth * (badgeMaxWidthPct / 100) - (isSmallScreen ? 16 : 28);
  const approxCharWidthRatio = 0.58;
  if (maxWordLen > 0) {
    const requiredWordWidth = maxWordLen * (computedSize * approxCharWidthRatio);
    if (requiredWordWidth > availableBadgeWidth && availableBadgeWidth > 80) {
      computedSize = (availableBadgeWidth / maxWordLen) / approxCharWidthRatio;
    }
  }

  // 5. Readability Clamp for Medium font size:
  // On mobile: guarantees a crisp, legible Medium size (14.0px - 15.5px)
  // On desktop: 16.0px - 18.0px
  const minFont = isTinyScreen ? 13.0 : isSmallScreen ? 14.0 : 14.5;
  const maxFont = isFullscreen ? Math.max(20, baseFontSize * 1.35) : baseFontSize * 1.25;
  const fontSize = Number(Math.max(minFont, Math.min(maxFont, computedSize)).toFixed(1));

  // 6. Line Height: compact & comfortable
  const lineHeight = isSmallScreen ? 1.42 : 1.48;

  // 7. Dynamic Padding: comfortable medium padding
  let padding: string;
  if (isTinyScreen) {
    padding = "4px 10px";
  } else if (isSmallScreen) {
    padding = "5px 12px";
  } else if (isVertical) {
    padding = "6px 14px";
  } else {
    padding = "5px 14px";
  }

  // 8. Dynamic Safe Line Wrapping
  const effectiveCharWidth = fontSize * approxCharWidthRatio;
  const maxCharsPerLine = Math.max(16, Math.floor(availableBadgeWidth / effectiveCharWidth));
  const lines = wrapDynamicSoraniLines(text, maxCharsPerLine);

  // 9. Dynamic Bottom Clearance
  // Ensures subtitles NEVER go under player controls or off the bottom edge
  let bottomPx: number;
  const actualControlsHeight = Math.max(48, Math.min(90, controlsBarHeight));

  if (controlsVisible) {
    // Controls are visible: sit comfortably above the controls bar
    const gapAboveControls = isTinyScreen ? 6 : isSmallScreen ? 8 : isVertical ? 14 : 10;
    bottomPx = actualControlsHeight + gapAboveControls;
  } else {
    // Controls are hidden: sit near bottom without clipping
    if (isVertical) {
      bottomPx = isSmallScreen ? 28 : 34;
    } else if (isTinyScreen) {
      bottomPx = 10;
    } else if (isSmallScreen) {
      bottomPx = 14;
    } else {
      bottomPx = 20;
    }
  }

  if (isFullscreen) {
    bottomPx += 10;
  }

  return {
    fontSize,
    lineHeight,
    lines,
    bottomPx,
    maxWidthPct: badgeMaxWidthPct,
    padding,
    containerWidth,
    containerHeight,
  };
}
