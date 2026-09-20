/**
 * SoraniSubs - Smart Dynamic Caption Resizer
 *
 * Dynamically computes optimal font size, line wrapping, line height,
 * max-width, padding, and bottom clearance based on:
 * 1. Screen / Player container dimensions (width & height in px)
 * 2. Video aspect ratio (landscape 16:9, vertical 9:16, ultra-wide 21:9, square 1:1)
 * 3. Caption wording: character length, word count, longest word length
 * 4. User's base font size preference
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
 */
export function calculateDynamicCaptionLayout(options: DynamicCaptionOptions): DynamicCaptionLayout {
  const {
    containerWidth = 640,
    containerHeight = 360,
    videoAspectRatio = 16 / 9,
    captionText = "",
    baseFontSize = 15,
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
  const isUltraWide = videoAspectRatio > 2.05;
  const isSmallScreen = containerWidth < 460 || containerHeight < 260;
  const isTinyScreen = containerWidth < 360 || containerHeight < 210;

  // 1. Container Width Scaling Factor
  // Reference standard desktop player width: 640px
  const widthRatio = Math.max(0.4, Math.min(1.6, containerWidth / 640));
  // Smooth sub-linear scaling curve: y = x^0.42
  const widthScale = Math.pow(widthRatio, 0.42);

  // 2. Container Height & Aspect Ratio Constraint
  // When height is cramped (e.g. 16:9 on mobile where height is ~190-210px), scale down
  let heightScale = 1.0;
  if (containerHeight < 280) {
    const hRatio = Math.max(0.65, containerHeight / 280);
    heightScale = 0.78 + (hRatio - 0.65) * 0.62;
  } else if (isVertical) {
    // In vertical video, height is abundant, text wraps faster
    heightScale = 1.02;
  }

  // 3. Caption Length & Word Count Scaling Factor
  let lengthScale = 1.0;
  if (charCount <= 22) {
    // Short, punchy single-line caption (e.g. "سڵاو هاوڕێیان")
    lengthScale = 1.06;
  } else if (charCount <= 45) {
    // Normal medium caption
    lengthScale = 1.0;
  } else if (charCount <= 75) {
    // Longer sentence: scale down slightly to fit 2 lines cleanly
    lengthScale = 0.92;
  } else if (charCount <= 110) {
    // Long multi-clause sentence: scale down so it doesn't crowd screen
    lengthScale = 0.83;
  } else {
    // Very long paragraph
    lengthScale = 0.75;
  }

  // 4. Ultra-wide player dampening
  if (isUltraWide && containerHeight < 240) {
    lengthScale *= 0.90;
  }

  // 5. Combine scales with user base preference
  let computedSize = baseFontSize * widthScale * heightScale * lengthScale;

  // 6. Longest word safety check:
  // Ensure the longest word fits within containerWidth with margins
  const badgeMaxWidthPct = isTinyScreen ? 94 : isSmallScreen ? 92 : isVertical ? 86 : 88;
  const availableBadgeWidth = containerWidth * (badgeMaxWidthPct / 100) - (isSmallScreen ? 20 : 32);
  const approxCharWidthRatio = 0.58; // Kurdish / Arabic glyph width ratio
  if (maxWordLen > 0) {
    const requiredWordWidth = maxWordLen * (computedSize * approxCharWidthRatio);
    if (requiredWordWidth > availableBadgeWidth && availableBadgeWidth > 80) {
      computedSize = (availableBadgeWidth / maxWordLen) / approxCharWidthRatio;
    }
  }

  // 7. Clamp font size within safe readability boundaries
  const minFont = isTinyScreen ? 11.0 : isSmallScreen ? 11.5 : 12.5;
  const maxFont = isFullscreen ? Math.max(18, baseFontSize * 1.35) : baseFontSize * 1.15;
  const fontSize = Number(Math.max(minFont, Math.min(maxFont, computedSize)).toFixed(1));

  // 8. Line Height: tighter on small screens to conserve vertical height
  const lineHeight = isTinyScreen ? 1.36 : isSmallScreen ? 1.40 : 1.48;

  // 9. Dynamic Safe Line Wrapping
  const effectiveCharWidth = fontSize * approxCharWidthRatio;
  const maxCharsPerLine = Math.max(16, Math.floor(availableBadgeWidth / effectiveCharWidth));
  const lines = wrapDynamicSoraniLines(text, maxCharsPerLine);

  // 10. Dynamic Bottom Clearance
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
      bottomPx = isSmallScreen ? 26 : 34;
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

  // 11. Dynamic Padding
  let padding: string;
  if (isTinyScreen) {
    padding = "3px 8px";
  } else if (isSmallScreen) {
    padding = "4px 10px";
  } else if (isVertical) {
    padding = "6px 14px";
  } else {
    padding = "5px 13px";
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
