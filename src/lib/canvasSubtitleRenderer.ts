/**
 * SoraniSubs - High-Fidelity Canvas Subtitle Renderer
 *
 * Renders Kurdish subtitles directly onto the HTML5 video export canvas with 100%
 * visual parity to the in-player preview:
 * 1. Exact Kurdish font (Noto Kufi Arabic, Noto Sans Arabic, KurdFonts, or custom upload)
 * 2. Exact dynamic sizing scaled to native video resolution
 * 3. Exact balanced Kurdish line wrapping
 * 4. Exact modern rounded pill box (rgba(0,0,0,0.84) with blur shadow) or crisp outline
 * 5. Native browser HarfBuzz/CoreText RTL shaping
 */

import { calculateDynamicCaptionLayout } from "./dynamicCaptionResizer";

export interface SubtitleBurnConfig {
  cues: Array<{ start: number; end: number; lines?: string[]; kurdishText?: string }>;
  fontFamily: string;
  fontSize: number;
  bg: "box" | "shadow";
  align: "left" | "center" | "right";
  playerWidth?: number;
  playerHeight?: number;
}

interface PrecomputedCueItem {
  start: number;
  end: number;
  lines: string[];
  fontSizePx: number;
  lineHeightPx: number;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  borderRadius: number;
  paddingX: number;
  paddingY: number;
  scale: number;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }
}

export interface SubtitleCanvasRenderer {
  drawAt(ctx: CanvasRenderingContext2D, timestamp: number): void;
}

export function createSubtitleCanvasRenderer(
  config: SubtitleBurnConfig,
  videoWidth: number,
  videoHeight: number,
): SubtitleCanvasRenderer {
  const {
    cues = [],
    fontFamily = "'Noto Kufi Arabic', sans-serif",
    fontSize = 16,
    bg = "box",
    align = "center",
    playerWidth = 640,
    playerHeight = 360,
  } = config;

  const aspectRatio = videoWidth / videoHeight;

  // Determine reference preview dimensions
  const refWidth = Math.max(320, playerWidth || 640);
  const refHeight = Math.max(180, playerHeight || Math.round(refWidth / aspectRatio));

  // Scale factor from preview container to physical video export dimensions
  const scale = Math.max(1.0, videoHeight / refHeight);

  // Scratch measurement canvas
  const measureCanvas = document.createElement("canvas");
  const mCtx = measureCanvas.getContext("2d");

  // Precompute layout and geometry for all cues
  const precomputed: PrecomputedCueItem[] = [];

  for (const cue of cues) {
    const text = (cue.kurdishText || (cue.lines || []).join(" ")).trim();
    if (!text) continue;

    // Use the exact preview dynamic layout calculator
    const layout = calculateDynamicCaptionLayout({
      containerWidth: refWidth,
      containerHeight: refHeight,
      videoAspectRatio: aspectRatio,
      captionText: text,
      baseFontSize: fontSize,
      controlsVisible: false, // No controls in burned video
      controlsBarHeight: 60,
      isFullscreen: false,
    });

    let fontSizePx = Math.round(layout.fontSize * scale);
    const lineHeightRatio = layout.lineHeight || 1.44;
    let lineHeightPx = Math.round(fontSizePx * lineHeightRatio);
    const bottomPx = Math.round(layout.bottomPx * scale);
    const borderRadius = Math.max(4, Math.round(6 * scale));
    const isSmallContainer = refWidth < 480;
    const paddingX = Math.round((isSmallContainer ? 12 : 14) * scale);
    const paddingY = Math.round((isSmallContainer ? 5 : 6) * scale);
    const maxWidth = Math.round(videoWidth * (layout.maxWidthPct / 100));

    // Measure line widths
    if (mCtx) {
      mCtx.font = `600 ${fontSizePx}px ${fontFamily}`;
      mCtx.direction = "rtl";
    }

    const rawWidths = layout.lines.map((line) =>
      mCtx ? mCtx.measureText(line).width : line.length * fontSizePx * 0.58
    );
    let maxLineWidth = Math.max(...rawWidths, 0);

    // Safeguard: if text exceeds maxWidth, gently scale down font size
    if (maxLineWidth + paddingX * 2 > maxWidth && maxLineWidth > 0) {
      const fitFactor = (maxWidth - paddingX * 2) / maxLineWidth;
      fontSizePx = Math.max(12, Math.round(fontSizePx * fitFactor));
      lineHeightPx = Math.round(fontSizePx * lineHeightRatio);
      maxLineWidth = maxWidth - paddingX * 2;
    }

    const boxWidth = Math.min(maxWidth, Math.round(maxLineWidth + paddingX * 2));
    const boxHeight = Math.round(layout.lines.length * lineHeightPx + paddingY * 2);

    let boxX: number;
    if (align === "center") {
      boxX = Math.round((videoWidth - boxWidth) / 2);
    } else if (align === "left") {
      boxX = Math.round(paddingX * 1.5);
    } else {
      boxX = Math.round(videoWidth - boxWidth - paddingX * 1.5);
    }

    const boxY = Math.round(videoHeight - bottomPx - boxHeight);

    precomputed.push({
      start: cue.start,
      end: cue.end,
      lines: layout.lines,
      fontSizePx,
      lineHeightPx,
      boxX,
      boxY,
      boxWidth,
      boxHeight,
      borderRadius,
      paddingX,
      paddingY,
      scale,
    });
  }

  // Sort by start timestamp for binary / sequential search
  precomputed.sort((a, b) => a.start - b.start);

  let cachedIdx = 0;

  function findActiveItem(time: number): PrecomputedCueItem | null {
    if (precomputed.length === 0) return null;

    // Check cached item first (handles consecutive video frames)
    if (cachedIdx >= 0 && cachedIdx < precomputed.length) {
      const c = precomputed[cachedIdx];
      if (time >= c.start && time <= c.end) return c;
      if (
        cachedIdx + 1 < precomputed.length &&
        time >= precomputed[cachedIdx + 1].start &&
        time <= precomputed[cachedIdx + 1].end
      ) {
        cachedIdx++;
        return precomputed[cachedIdx];
      }
    }

    // Binary search fallback
    let low = 0;
    let high = precomputed.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const item = precomputed[mid];
      if (time >= item.start && time <= item.end) {
        cachedIdx = mid;
        return item;
      }
      if (time < item.start) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return null;
  }

  return {
    drawAt(ctx: CanvasRenderingContext2D, timestamp: number) {
      const item = findActiveItem(timestamp);
      if (!item) return;

      const {
        lines,
        fontSizePx,
        lineHeightPx,
        boxX,
        boxY,
        boxWidth,
        boxHeight,
        borderRadius,
        paddingX,
        paddingY,
        scale: itemScale,
      } = item;

      if (bg === "box") {
        // --- 1. Rounded Box Background with Soft Drop Shadow ---
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = Math.round(14 * itemScale);
        ctx.shadowOffsetY = Math.round(3 * itemScale);
        ctx.fillStyle = "rgba(0, 0, 0, 0.84)";
        drawRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, borderRadius);
        ctx.fill();
        ctx.restore();

        // --- 2. Kurdish RTL Subtitle Text Lines ---
        ctx.save();
        ctx.font = `600 ${fontSizePx}px ${fontFamily}`;
        ctx.direction = "rtl";
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineY = boxY + paddingY + (i + 0.5) * lineHeightPx;
          if (align === "center") {
            ctx.textAlign = "center";
            ctx.fillText(line, boxX + boxWidth / 2, lineY);
          } else if (align === "left") {
            ctx.textAlign = "left";
            ctx.fillText(line, boxX + paddingX, lineY);
          } else {
            ctx.textAlign = "right";
            ctx.fillText(line, boxX + boxWidth - paddingX, lineY);
          }
        }
        ctx.restore();
      } else {
        // --- Outline / Text Shadow Mode (badge-shadow) ---
        ctx.save();
        ctx.font = `600 ${fontSizePx}px ${fontFamily}`;
        ctx.direction = "rtl";
        ctx.textBaseline = "middle";

        const totalHeight = lines.length * lineHeightPx;
        const startY = boxY + (boxHeight - totalHeight) / 2;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineY = startY + (i + 0.5) * lineHeightPx;
          let textX: number;
          if (align === "center") {
            ctx.textAlign = "center";
            textX = boxX + boxWidth / 2;
          } else if (align === "left") {
            ctx.textAlign = "left";
            textX = boxX + paddingX;
          } else {
            ctx.textAlign = "right";
            textX = boxX + boxWidth - paddingX;
          }

          // Pass 1: Deep ambient drop shadow
          ctx.save();
          ctx.shadowColor = "rgba(0, 0, 0, 0.95)";
          ctx.shadowBlur = Math.round(8 * itemScale);
          ctx.shadowOffsetY = Math.round(2 * itemScale);
          ctx.fillStyle = "#000000";
          ctx.fillText(line, textX, lineY);
          ctx.restore();

          // Pass 2: High-contrast crisp black outline
          ctx.save();
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = Math.max(2, Math.round(3.5 * itemScale));
          ctx.lineJoin = "round";
          ctx.strokeText(line, textX, lineY);
          ctx.restore();

          // Pass 3: Pure white crisp text
          ctx.fillStyle = "#ffffff";
          ctx.fillText(line, textX, lineY);
        }
        ctx.restore();
      }
    },
  };
}
