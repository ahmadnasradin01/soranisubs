<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { writeAss, writeSrt, writeVtt, type Cue } from "./lib/engine";
  import { burnInBrowser, type BurnResult } from "./lib/burn";
  import {
    generateSoraniSubtitlesDirect,
    type DirectSubtitlesProgress,
    type DirectSubtitlesResult,
  } from "./lib/geminiDirectSubtitles";
  import {
    wrapSoraniLines,
    type SubtitleCue,
  } from "./lib/soraniTranslation";
  import {
    getGeminiApiKey,
    setGeminiApiKey,
    getGeminiModel,
    setGeminiModel,
    DEFAULT_GEMINI_API_KEY,
    DEFAULT_GEMINI_MODEL,
    FALLBACK_GEMINI_MODELS,
  } from "./lib/config";
  import { TOP_50_KURDISH_FONTS, type KurdishFontSpecimen } from "./lib/kurdishFonts";
  import { loadFontFile, loadWebFont, type CustomFontRecord } from "./lib/customFonts";
  import { calculateDynamicCaptionLayout } from "./lib/dynamicCaptionResizer";

  // --- Workflow Phases ---
  type WorkflowPhase = "upload" | "processing" | "studio";
  let phase: WorkflowPhase = $state("upload");

  // --- Video State ---
  let videoFile: File | null = $state(null);
  let videoUrl: string | null = $state(null);
  let videoDuration = $state(0);
  let videoWidth = $state(1280);
  let videoHeight = $state(720);
  let currentTime = $state(0);
  let isPlaying = $state(false);
  let isMuted = $state(false);
  let volume = $state(1);

  // --- Controls & Playback State ---
  let controlsVisible = $state(true);
  let controlsTimer: any = null;
  let isScrubbing = $state(false);
  let wasPlayingBeforeScrub = false;
  let isFullscreen = $state(false);

  let videoAspectRatio = $derived(
    videoWidth > 0 && videoHeight > 0 ? Number((videoWidth / videoHeight).toFixed(4)) : (16 / 9)
  );
  let isVerticalVideo = $derived(videoAspectRatio < 0.95);

  // --- Subtitles & Transcript State ---
  let cues: SubtitleCue[] = $state([]);
  let detectedLanguage = $state("");

  // --- Subtitle Customization State ---
  let uploadedFonts: CustomFontRecord[] = $state([]);
  let selectedFontId = $state("Noto Kufi Arabic");
  let subtitleFontSize = $state(16); // px (crisp medium caption default)
  let subtitleAlign: "center" | "left" | "right" = $state("center");
  let subtitleBg: "box" | "shadow" = $state("box");

  // --- Font Upload & Showcase States ---
  let fontUploadInput: HTMLInputElement | null = $state(null);
  let fontShowcaseOpen = $state(false);
  let fontSearchQuery = $state("");
  let selectedFontCategory = $state("All");
  let showcaseSampleText = $state("نموونەی دەقی کوردی سۆرانی بۆ ژێرنووس");
  let fontUploadSuccess = $state("");
  let fontUploadError = $state("");

  // --- Processing Step State ---
  let processingStep = $state(1); // 1 = Audio, 2 = Gemini Flash Lite, 3 = Gemini Thinking, 4 = Finalizing
  let processingStatusText = $state("");
  let processingDetailText = $state("");
  let processingStartTime = $state(0);
  let processingElapsed = $state(0);
  let elapsedTimer: any = null;

  // --- Burning & Export State ---
  let isBurning = $state(false);
  let burnProgressText = $state("");
  let burnFraction = $state(0);

  // --- Settings Modal & Error State ---
  let settingsOpen = $state(false);
  let errorMessage = $state("");
  let isDragging = $state(false);
  let geminiKeyInput = $state(getGeminiApiKey());
  let geminiModelInput = $state(getGeminiModel());

  // --- References ---
  let videoElement: HTMLVideoElement | null = $state(null);
  let playerContainer: HTMLElement | null = $state(null);
  let controlsBarElement: HTMLElement | null = $state(null);
  let scrubberTrack: HTMLElement | null = $state(null);
  let abortController: AbortController | null = null;

  // Real-time responsive player & controls dimensions for smart dynamic subtitle resizer
  let playerWidth = $state(640);
  let playerHeight = $state(360);
  let controlsBarHeight = $state(60);

  $effect(() => {
    if (!playerContainer) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect) {
          playerWidth = Math.round(entry.contentRect.width);
          playerHeight = Math.round(entry.contentRect.height);
        }
      }
    });
    ro.observe(playerContainer);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!controlsBarElement) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect) {
          controlsBarHeight = Math.round(entry.contentRect.height);
        }
      }
    });
    ro.observe(controlsBarElement);
    return () => ro.disconnect();
  });

  // --- Subtitle Editing & Selection State ---
  let selectedCueIndex: number | null = $state(null);

  // Current active cue derived from currentTime with exact acoustic start & end
  let activeCue = $derived.by(() => {
    if (cues.length === 0) return null;
    const t = currentTime;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      // Exact millisecond timing ensures subtitle appears precisely with vocals
      if (t >= c.start && t <= c.end) {
        return c;
      }
    }
    return null;
  });

  // Smart dynamic subtitle layout calculation based on screen, container dimensions, aspect ratio, text length & wordings
  let dynamicCaptionLayout = $derived.by(() => {
    return calculateDynamicCaptionLayout({
      containerWidth: playerWidth,
      containerHeight: playerHeight,
      videoAspectRatio,
      captionText: activeCue ? activeCue.kurdishText : "",
      baseFontSize: subtitleFontSize,
      controlsVisible,
      controlsBarHeight,
      isFullscreen,
    });
  });

  let activeCueIndex = $derived.by(() => {
    if (cues.length === 0) return -1;
    const t = currentTime;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.start && t <= c.end) {
        return i;
      }
    }
    return -1;
  });

  let editingCueIndex = $derived(
    selectedCueIndex !== null && selectedCueIndex >= 0 && selectedCueIndex < cues.length
      ? selectedCueIndex
      : activeCueIndex !== -1
      ? activeCueIndex
      : null
  );

  let editingCue = $derived(
    editingCueIndex !== null ? cues[editingCueIndex] ?? null : null
  );

  let allFonts = $derived([
    ...uploadedFonts.map((f) => ({
      id: f.id,
      name: f.name,
      label: `★ ${f.name} (Uploaded)`,
      family: f.family,
      isUploaded: true,
    })),
    { id: "Noto Kufi Arabic", name: "Noto Kufi Arabic", label: "Noto Kufi (Default)", family: "'Noto Kufi Arabic', sans-serif", isUploaded: false },
    { id: "Noto Sans Arabic", name: "Noto Sans Arabic", label: "Noto Sans (Modern)", family: "'Noto Sans Arabic', sans-serif", isUploaded: false },
    ...TOP_50_KURDISH_FONTS.map((f) => ({
      id: f.name,
      name: f.name,
      label: `#${f.rank} ${f.name}`,
      family: `'${f.name}', 'Noto Kufi Arabic', sans-serif`,
      isUploaded: false,
    })),
  ]);

  let activeFontDisplayName = $derived.by(() => {
    const uploaded = uploadedFonts.find((f) => f.id === selectedFontId);
    if (uploaded) return `★ ${uploaded.name}`;
    if (selectedFontId === "Noto Kufi Arabic") return "Noto Kufi (Default)";
    if (selectedFontId === "Noto Sans Arabic") return "Noto Sans (Modern)";
    const kf = TOP_50_KURDISH_FONTS.find((f) => f.name === selectedFontId);
    if (kf) return `#${kf.rank} ${kf.name}`;
    return selectedFontId;
  });

  let selectedFontFamily = $derived(
    allFonts.find((f) => f.id === selectedFontId)?.family ?? "'Noto Kufi Arabic', sans-serif"
  );

  let filteredKurdishFonts = $derived(
    TOP_50_KURDISH_FONTS.filter((f) => {
      const q = fontSearchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q) ||
        `#${f.rank}`.includes(q)
      );
    })
  );

  async function handleFontUpload(file: File) {
    if (!file) return;
    if (!file.name.match(/\.(ttf|otf|woff|woff2)$/i)) {
      alert("Please upload a valid font file (.ttf, .otf, or .woff).");
      return;
    }

    try {
      fontUploadError = "";
      const customFont = await loadFontFile(file);
      uploadedFonts = [customFont, ...uploadedFonts];
      selectedFontId = customFont.id;
      fontUploadSuccess = `Font "${customFont.name}" uploaded and applied to subtitles!`;
      setTimeout(() => { fontUploadSuccess = ""; }, 4000);
    } catch (err: any) {
      fontUploadError = err.message || "Failed to load font file.";
      alert(fontUploadError);
    }
  }

  function onFontFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      handleFontUpload(input.files[0]);
    }
  }

  async function selectAndApplyFont(font: { id?: string; name: string; fontUrl?: string; isUploaded?: boolean }) {
    selectedFontId = font.id && font.isUploaded ? font.id : font.name;
    if (font.fontUrl) {
      try {
        await loadWebFont(font.name, font.fontUrl);
      } catch (err) {
        console.error("Failed to load font:", err);
      }
    }
  }

  function removeUploadedFont(id: string) {
    uploadedFonts = uploadedFonts.filter((f) => f.id !== id);
    if (selectedFontId === id) {
      selectedFontId = "Noto Kufi Arabic";
    }
  }

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  function formatTimeMs(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
  }

  // --- Phase 1: Upload Handling ---

  function onSelectFile(file: File) {
    if (!file.type.startsWith("video/") && !file.name.match(/\.(mp4|webm|mov|mkv|avi|m4v)$/i)) {
      alert("Please select a supported video file (MP4, WebM, MOV, etc.).");
      return;
    }

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoFile = file;
    videoUrl = URL.createObjectURL(file);
    cues = [];
    errorMessage = "";
  }

  function onFileInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      onSelectFile(input.files[0]);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
      onSelectFile(e.dataTransfer.files[0]);
    }
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    isDragging = true;
  }

  function onDragLeave() {
    isDragging = false;
  }

  function resetUpload() {
    if (abortController) abortController.abort();
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoFile = null;
    videoUrl = null;
    cues = [];
    phase = "upload";
    errorMessage = "";
  }

  // --- Phase 2: Start Generation Pipeline ---

  async function startGenerating() {
    if (!videoFile) return;

    phase = "processing";
    processingStep = 1;
    processingStatusText = "Reading video & extracting audio...";
    processingDetailText = "Preparing 16 kHz high-fidelity acoustic stream";
    processingStartTime = Date.now();
    processingElapsed = 0;

    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      processingElapsed = Math.floor((Date.now() - processingStartTime) / 1000);
    }, 1000);

    abortController = new AbortController();

    try {
      // Direct 1-Go: Audio directly to Gemini Flash 3.8 Thinking -> Sorani Subtitles with Timestamps
      const result = await generateSoraniSubtitlesDirect(
        videoFile,
        (p) => {
          if (p.stage === "extracting") {
            processingStep = 1;
            processingStatusText = "Extracting audio from video...";
            processingDetailText = p.note;
          } else if (p.stage === "translating") {
            processingStep = 2;
            processingStatusText = `Listening & Translating to Sorani Kurdish (${getGeminiModel()} Thinking)...`;
            processingDetailText = p.note;
          } else if (p.stage === "ready") {
            processingStep = 3;
            processingStatusText = "Finalizing voice-synchronized Kurdish subtitles...";
            processingDetailText = p.note;
          }
        },
        abortController.signal
      );

      detectedLanguage = result.language;
      cues = result.cues;

      if (elapsedTimer) clearInterval(elapsedTimer);

      // Transition smoothly into Studio Mode
      setTimeout(() => {
        phase = "studio";
      }, 400);
    } catch (err: any) {
      if (err.name === "AbortError") {
        phase = "upload";
        return;
      }
      phase = "upload";
      errorMessage = err.message || "An error occurred during subtitle generation.";
      if (elapsedTimer) clearInterval(elapsedTimer);
      console.error(err);
    }
  }

  function cancelProcessing() {
    if (abortController) abortController.abort();
    if (elapsedTimer) clearInterval(elapsedTimer);
    phase = "upload";
  }

  // --- Phase 3: Studio & Custom Player ---

  function resetControlsTimer(delay = 2800) {
    if (controlsTimer) {
      clearTimeout(controlsTimer);
      controlsTimer = null;
    }
    controlsVisible = true;
    if (isPlaying && !isScrubbing) {
      controlsTimer = setTimeout(() => {
        if (isPlaying && !isScrubbing) {
          controlsVisible = false;
        }
      }, delay);
    }
  }

  function onPlayerPointerMove() {
    resetControlsTimer();
  }

  function onPlayerPointerLeave() {
    if (isPlaying && !isScrubbing) {
      if (controlsTimer) clearTimeout(controlsTimer);
      controlsTimer = setTimeout(() => {
        if (isPlaying && !isScrubbing) {
          controlsVisible = false;
        }
      }, 1000);
    }
  }

  function handlePlayerContainerClick() {
    // If controls were hidden, click/tap reveals them smoothly without toggling playback
    if (!controlsVisible) {
      resetControlsTimer();
      return;
    }

    // On mobile touch screens while playing, tapping empty video area hides controls smoothly (YouTube mobile behavior)
    const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
    if (isTouch && isPlaying) {
      controlsVisible = false;
      if (controlsTimer) clearTimeout(controlsTimer);
    } else {
      togglePlay();
    }
  }

  function togglePlay() {
    if (!videoElement) return;
    if (videoElement.paused) {
      videoElement.play().catch(() => {});
      isPlaying = true;
      resetControlsTimer();
    } else {
      videoElement.pause();
      isPlaying = false;
      controlsVisible = true;
      if (controlsTimer) clearTimeout(controlsTimer);
    }
  }

  let timeSyncRaf: number | null = null;
  let videoFrameCallbackId: number | null = null;

  function syncPlaybackTime() {
    if (!videoElement || !isPlaying) return;
    if (!isScrubbing) {
      currentTime = videoElement.currentTime;
    }
    // High-precision frame synchronization: triggers on every decoded frame (16ms / 33ms)
    // Eliminates HTML5 ontimeupdate 250ms latency for frame-accurate subtitle timing
    if ("requestVideoFrameCallback" in videoElement) {
      videoFrameCallbackId = (videoElement as any).requestVideoFrameCallback(() => {
        syncPlaybackTime();
      });
    } else {
      timeSyncRaf = requestAnimationFrame(syncPlaybackTime);
    }
  }

  function stopTimeSync() {
    if (timeSyncRaf !== null) {
      cancelAnimationFrame(timeSyncRaf);
      timeSyncRaf = null;
    }
    if (videoFrameCallbackId !== null && videoElement && "cancelVideoFrameCallback" in videoElement) {
      (videoElement as any).cancelVideoFrameCallback(videoFrameCallbackId);
      videoFrameCallbackId = null;
    }
  }

  function onVideoPlay() {
    isPlaying = true;
    resetControlsTimer();
    stopTimeSync();
    syncPlaybackTime();
  }

  function onVideoPause() {
    isPlaying = false;
    controlsVisible = true;
    if (controlsTimer) clearTimeout(controlsTimer);
    stopTimeSync();
    if (videoElement) {
      currentTime = videoElement.currentTime;
    }
  }

  function onVideoTimeUpdate() {
    if (videoElement && !isScrubbing) {
      currentTime = videoElement.currentTime;
    }
  }

  function onVideoMetadata() {
    if (videoElement) {
      videoDuration = videoElement.duration || 0;
      videoWidth = videoElement.videoWidth || 1280;
      videoHeight = videoElement.videoHeight || 720;
    }
  }

  // --- Touch & Pointer Friendly Real-Time Scrubber Dragging ---

  function getScrubberFraction(clientX: number): number {
    if (!scrubberTrack) return 0;
    const rect = scrubberTrack.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const frac = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, frac));
  }

  function onScrubberPointerDown(e: PointerEvent) {
    if (!videoElement || videoDuration <= 0) return;
    e.preventDefault();
    e.stopPropagation();

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (_) {}

    isScrubbing = true;
    controlsVisible = true;
    if (controlsTimer) clearTimeout(controlsTimer);

    wasPlayingBeforeScrub = !videoElement.paused;
    if (wasPlayingBeforeScrub) {
      videoElement.pause();
    }

    const frac = getScrubberFraction(e.clientX);
    const targetTime = frac * videoDuration;
    currentTime = targetTime;
    videoElement.currentTime = targetTime;
  }

  function onScrubberPointerMove(e: PointerEvent) {
    if (!isScrubbing || !videoElement || videoDuration <= 0) return;
    e.preventDefault();
    e.stopPropagation();

    const frac = getScrubberFraction(e.clientX);
    const targetTime = frac * videoDuration;
    currentTime = targetTime;
    videoElement.currentTime = targetTime;
  }

  function onScrubberPointerUp(e: PointerEvent) {
    if (!isScrubbing) return;
    e.preventDefault();
    e.stopPropagation();

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (_) {}

    isScrubbing = false;

    if (wasPlayingBeforeScrub && videoElement) {
      videoElement.play().catch(() => {});
      isPlaying = true;
    }
    resetControlsTimer();
  }

  function onScrubberPointerCancel(e: PointerEvent) {
    if (isScrubbing) {
      onScrubberPointerUp(e);
    }
  }

  function onScrubberKeydown(e: KeyboardEvent) {
    if (!videoElement || videoDuration <= 0) return;
    resetControlsTimer();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      videoElement.currentTime = Math.max(0, videoElement.currentTime - 5);
      currentTime = videoElement.currentTime;
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      videoElement.currentTime = Math.min(videoDuration, videoElement.currentTime + 5);
      currentTime = videoElement.currentTime;
    } else if (e.key === "Home") {
      e.preventDefault();
      videoElement.currentTime = 0;
      currentTime = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      videoElement.currentTime = videoDuration;
      currentTime = videoDuration;
    }
  }

  function toggleMute() {
    if (!videoElement) return;
    videoElement.muted = !videoElement.muted;
    isMuted = videoElement.muted;
    resetControlsTimer();
  }

  function onVolumeChange(e: Event) {
    if (!videoElement) return;
    const target = e.target as HTMLInputElement;
    volume = parseFloat(target.value);
    videoElement.volume = volume;
    videoElement.muted = volume === 0;
    isMuted = videoElement.muted;
    resetControlsTimer();
  }

  // --- Fullscreen with Mobile & Safari Support ---

  function toggleFullscreen() {
    if (!playerContainer && !videoElement) return;

    const fsElement =
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement;

    if (!fsElement) {
      if (playerContainer?.requestFullscreen) {
        playerContainer.requestFullscreen().catch(() => {
          fallbackEnterFullscreen();
        });
      } else {
        fallbackEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
    resetControlsTimer();
  }

  function fallbackEnterFullscreen() {
    if ((playerContainer as any)?.webkitRequestFullscreen) {
      (playerContainer as any).webkitRequestFullscreen();
    } else if ((videoElement as any)?.webkitEnterFullscreen) {
      (videoElement as any).webkitEnterFullscreen();
    }
  }

  function seekToCue(cue: SubtitleCue, index?: number) {
    if (index !== undefined) selectedCueIndex = index;
    if (videoElement) {
      videoElement.currentTime = cue.start;
      videoElement.play().catch(() => {});
      isPlaying = true;
      resetControlsTimer();
    }
  }

  function playCueSegment(index: number) {
    if (!cues[index] || !videoElement) return;
    selectedCueIndex = index;
    videoElement.currentTime = cues[index].start;
    videoElement.play().catch(() => {});
    isPlaying = true;
    resetControlsTimer();
  }

  function updateCueText(index: number, newText: string) {
    if (!cues[index]) return;
    const lines = newText.includes("\n")
      ? newText.split("\n").filter((l) => l.trim().length > 0)
      : wrapSoraniLines(newText);
    const updated = [...cues];
    updated[index] = {
      ...updated[index],
      kurdishText: newText,
      lines: lines.length > 0 ? lines : [newText],
    };
    cues = updated;
  }

  function updateCueStartTime(index: number, newStart: number) {
    if (!cues[index]) return;
    const validStart = Math.max(0, Math.min(cues[index].end - 0.2, newStart));
    const updated = [...cues];
    updated[index] = { ...updated[index], start: Number(validStart.toFixed(2)) };
    cues = updated;
  }

  function updateCueEndTime(index: number, newEnd: number) {
    if (!cues[index]) return;
    const maxEnd = videoDuration > 0 ? videoDuration : cues[index].start + 60;
    const validEnd = Math.max(cues[index].start + 0.2, Math.min(maxEnd, newEnd));
    const updated = [...cues];
    updated[index] = { ...updated[index], end: Number(validEnd.toFixed(2)) };
    cues = updated;
  }

  function nudgeCueStart(index: number, delta: number) {
    if (!cues[index]) return;
    updateCueStartTime(index, cues[index].start + delta);
  }

  function nudgeCueEnd(index: number, delta: number) {
    if (!cues[index]) return;
    updateCueEndTime(index, cues[index].end + delta);
  }

  function setCueStartToCurrentTime(index: number) {
    if (!cues[index]) return;
    updateCueStartTime(index, currentTime);
  }

  function setCueEndToCurrentTime(index: number) {
    if (!cues[index]) return;
    updateCueEndTime(index, currentTime);
  }

  function deleteCue(index: number) {
    if (index < 0 || index >= cues.length) return;
    cues = cues.filter((_, i) => i !== index);
    if (selectedCueIndex !== null) {
      if (selectedCueIndex === index) selectedCueIndex = null;
      else if (selectedCueIndex > index) selectedCueIndex--;
    }
  }

  function addCueAtCurrentTime() {
    const start = Number(currentTime.toFixed(2));
    const end = Number(Math.min(videoDuration || start + 3, start + 3).toFixed(2));
    const newCue: SubtitleCue = {
      id: cues.length + 1,
      start,
      end: end > start ? end : start + 1.5,
      sourceText: "",
      kurdishText: "دەقی نوێی کوردی",
      lines: ["دەقی نوێی کوردی"],
    };

    const insertIdx = cues.findIndex((c) => c.start > start);
    if (insertIdx === -1) {
      cues = [...cues, newCue];
      selectedCueIndex = cues.length - 1;
    } else {
      cues = [...cues.slice(0, insertIdx), newCue, ...cues.slice(insertIdx)];
      selectedCueIndex = insertIdx;
    }
  }

  // Build ASS template matching the user's custom font, size, align, and bg
  function buildCustomAssTemplate(): string {
    const alignmentNum = subtitleAlign === "left" ? 1 : subtitleAlign === "right" ? 3 : 2;
    // Standard subtitle size relative to video height (clean ~3.8% screen height)
    const sizePct = Math.max(2.5, Math.min(5.5, (subtitleFontSize / 16) * 3.8));
    const isBox = subtitleBg === "box";

    const activeCustom = uploadedFonts.find((f) => f.id === selectedFontId);
    const fontName = activeCustom ? activeCustom.name : selectedFontId;

    const template = {
      name: "CustomKurdish",
      font: fontName,
      size_pct: Number(sizePct.toFixed(2)),
      primary: { r: 255, g: 255, b: 255, a: 255 },
      outline_color: { r: 0, g: 0, b: 0, a: 255 },
      back_color: isBox ? { r: 0, g: 0, b: 0, a: 195 } : { r: 0, g: 0, b: 0, a: 0 },
      bold: true,
      italic: false,
      border_style: isBox ? "OpaqueBox" : "OutlineShadow",
      outline: isBox ? 0.0 : 2.2,
      shadow: isBox ? 0.0 : 1.2,
      alignment: alignmentNum,
      margin_v_pct: 5.0,
    };

    return JSON.stringify(template);
  }

  // --- Downloads ---

  function downloadTextFile(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadSrt() {
    if (cues.length === 0) return;
    const srt = writeSrt(cues);
    const base = videoFile ? videoFile.name.replace(/\.[^/.]+$/, "") : "subtitles";
    downloadTextFile(srt, `${base}_sorani.srt`, "text/plain;charset=utf-8");
  }

  function downloadVtt() {
    if (cues.length === 0) return;
    const vtt = writeVtt(cues);
    const base = videoFile ? videoFile.name.replace(/\.[^/.]+$/, "") : "subtitles";
    downloadTextFile(vtt, `${base}_sorani.vtt`, "text/vtt;charset=utf-8");
  }

  async function exportBurnedVideo() {
    if (!videoFile || cues.length === 0) return;
    isBurning = true;
    burnProgressText = "0% - Preparing video burn...";
    burnFraction = 0;

    try {
      // Generate ASS subtitle document using current customization options
      const customAss = writeAss(cues, buildCustomAssTemplate(), videoWidth, videoHeight);

      let fontBytes: Uint8Array | null = null;
      let fontNameForAss = selectedFontId;

      const activeCustom = uploadedFonts.find((f) => f.id === selectedFontId);
      if (activeCustom) {
        fontBytes = activeCustom.bytes;
        fontNameForAss = activeCustom.name;
      } else {
        const kf = TOP_50_KURDISH_FONTS.find((f) => f.name === selectedFontId);
        if (kf) {
          fontNameForAss = kf.name;
          fontBytes = await loadWebFont(kf.name, kf.fontUrl);
        }
      }

      const result: BurnResult = await burnInBrowser({
        file: videoFile,
        ass: customAss,
        width: videoWidth,
        height: videoHeight,
        start: 0,
        end: null,
        customFont: fontBytes ? { name: fontNameForAss, bytes: fontBytes } : null,
        onProgress: (frac, note) => {
          burnFraction = frac;
          burnProgressText = `${Math.round(frac * 100)}% - ${note}`;
        },
      });

      const baseName = videoFile.name.replace(/\.[^/.]+$/, "");
      const ext = result.extension;
      const downloadUrl = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${baseName}_sorani_burned.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      isBurning = false;
    } catch (err: any) {
      isBurning = false;
      alert(`Burn failed: ${err.message || "Unknown error"}`);
    }
  }

  function saveSettings() {
    setGeminiApiKey(geminiKeyInput);
    setGeminiModel(geminiModelInput);
    settingsOpen = false;
  }

  function resetToDefaults() {
    geminiKeyInput = DEFAULT_GEMINI_API_KEY;
    geminiModelInput = DEFAULT_GEMINI_MODEL;
    saveSettings();
  }

  onMount(() => {
    const handleFullscreenChange = () => {
      isFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement
      );
      resetControlsTimer();
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
    };
  });

  onDestroy(() => {
    stopTimeSync();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (abortController) abortController.abort();
    if (elapsedTimer) clearInterval(elapsedTimer);
    if (controlsTimer) clearTimeout(controlsTimer);
  });
</script>

<div class="app-container">
  <!-- Top Navigation Header -->
  <header class="site-header">
    <div class="brand-wrapper">
      <h1 class="brand-title">
        <span>SoraniSubs</span>
      </h1>
    </div>

    <div class="header-actions">
      {#if phase === "studio"}
        <button class="btn btn-secondary" onclick={resetUpload}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1 4 1 10 7 10"></polyline>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
          </svg>
          <span>New Video</span>
        </button>
      {/if}

      <button class="btn btn-secondary" onclick={() => settingsOpen = true} aria-label="API Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <span>Settings</span>
      </button>
    </div>
  </header>

  <!-- =========================================================================
       PHASE 1: UPLOAD & FILE REVIEW (Does not start automatically)
       ========================================================================= -->
  {#if phase === "upload"}
    <main class="upload-section">
      <div class="upload-hero">
        <h2 class="upload-hero-title">Video to Sorani Kurdish Subtitles</h2>
        <p class="upload-hero-subtitle">
          Direct audio speech recognition with Gemini Flash Lite and idiomatic Central Kurdish translation with Gemini Thinking.
        </p>
      </div>

      {#if !videoFile}
        <!-- Dropzone Area -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="dropzone-box"
          class:dragging={isDragging}
          ondrop={onDrop}
          ondragover={onDragOver}
          ondragleave={onDragLeave}
          onclick={() => document.getElementById("video-file-input")?.click()}
        >
          <input
            id="video-file-input"
            type="file"
            accept="video/*"
            style="display: none;"
            onchange={onFileInputChange}
          />
          <div class="dropzone-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
          </div>
          <div class="dropzone-prompt">
            <strong>Choose a video</strong> or drag and drop it here
          </div>
          <div class="dropzone-hint">
            Supports MP4, WebM, MOV, MKV &bull; 100% private, processed in your browser
          </div>
        </div>
      {:else}
        <!-- Selected File Review Card (Waiting for User to Click Start) -->
        <div class="selected-file-card">
          <div class="file-info-row">
            <div class="file-icon-badge">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                <line x1="7" y1="2" x2="7" y2="22"></line>
                <line x1="17" y1="2" x2="17" y2="22"></line>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <line x1="2" y1="7" x2="7" y2="7"></line>
                <line x1="2" y1="17" x2="7" y2="17"></line>
                <line x1="17" y1="17" x2="22" y2="17"></line>
                <line x1="17" y1="7" x2="22" y2="7"></line>
              </svg>
            </div>
            <div class="file-meta-col">
              <span class="file-meta-name">{videoFile.name}</span>
              <span class="file-meta-size">
                {(videoFile.size / (1024 * 1024)).toFixed(1)} MB &bull; Ready to process
              </span>
            </div>
            <button
              class="btn btn-secondary"
              onclick={() => document.getElementById("video-file-input")?.click()}
            >
              Change
            </button>
            <input
              id="video-file-input"
              type="file"
              accept="video/*"
              style="display: none;"
              onchange={onFileInputChange}
            />
          </div>

          <div class="start-action-row">
            <button class="btn btn-primary btn-large" onclick={startGenerating}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Start Generating Subtitles</span>
            </button>
          </div>
        </div>
      {/if}

      {#if errorMessage}
        <div class="error-banner">
          <span>{errorMessage}</span>
          <button class="btn-text" onclick={() => errorMessage = ""}>Dismiss</button>
        </div>
      {/if}
    </main>
  {/if}

  <!-- =========================================================================
       PHASE 2: PREPARING & GENERATING PHASES ("Faces of Preparing")
       ========================================================================= -->
  {#if phase === "processing"}
    <main class="processing-section">
      <div class="processing-card">
        <div class="processing-header">
          <h2 class="processing-title">Preparing Kurdish Subtitles</h2>
          <p class="processing-subtitle">
            {processingStatusText} &bull; {processingElapsed}s elapsed
          </p>
        </div>

        <div class="phases-list">
          <!-- Step 1: Extract Audio -->
          <div class="phase-item" class:current={processingStep === 1} class:completed={processingStep > 1}>
            <div class="phase-status-icon">
              {#if processingStep > 1}
                &#10003;
              {:else if processingStep === 1}
                <div class="phase-spinner"></div>
              {:else}
                1
              {/if}
            </div>
            <div class="phase-content">
              <span class="phase-title">Extracting Audio Track</span>
              <span class="phase-desc">In-browser extraction of 16 kHz mono acoustic stream</span>
            </div>
          </div>

          <!-- Step 2: Direct Listening & Sorani Translation -->
          <div class="phase-item" class:current={processingStep === 2} class:completed={processingStep > 2}>
            <div class="phase-status-icon">
              {#if processingStep > 2}
                &#10003;
              {:else if processingStep === 2}
                <div class="phase-spinner"></div>
              {:else}
                2
              {/if}
            </div>
            <div class="phase-content">
              <span class="phase-title">Direct Speech to Sorani Subtitles (Gemini 3.8 Flash Thinking)</span>
              <span class="phase-desc">Listens to audio directly & translates to synchronized Sorani Kurdish in 1 go</span>
            </div>
          </div>

          <!-- Step 3: Finalizing -->
          <div class="phase-item" class:current={processingStep === 3} class:completed={processingStep > 3}>
            <div class="phase-status-icon">
              {#if processingStep > 3}
                &#10003;
              {:else if processingStep === 3}
                <div class="phase-spinner"></div>
              {:else}
                3
              {/if}
            </div>
            <div class="phase-content">
              <span class="phase-title">Assembling Studio Subtitles</span>
              <span class="phase-desc">Voice-synchronized Kurdish subtitles ready for preview, editing & export</span>
            </div>
          </div>
        </div>

        <div class="phase-detail-note">
          {processingDetailText}
        </div>

        <div style="margin-top: 24px; text-align: center;">
          <button class="btn btn-secondary" onclick={cancelProcessing}>
            Cancel
          </button>
        </div>
      </div>
    </main>
  {/if}

  <!-- =========================================================================
       PHASE 3: STUDIO MODE WITH CUSTOM PLAYER & SUBTITLE CUSTOMIZATION
       ========================================================================= -->
  {#if phase === "studio"}
    <main class="studio-workspace">
      <!-- Left: Custom Player and Subtitle Styling Controls -->
      <div class="studio-panel player-panel">
        <!-- Custom Video Player Wrapper -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="player-container"
          class:controls-hidden={!controlsVisible}
          class:is-fullscreen={isFullscreen}
          class:is-vertical={isVerticalVideo}
          class:is-scrubbing={isScrubbing}
          class:is-playing={isPlaying}
          style="--player-aspect: {videoAspectRatio};"
          bind:this={playerContainer}
          onpointermove={onPlayerPointerMove}
          onpointerleave={onPlayerPointerLeave}
          onclick={handlePlayerContainerClick}
        >
          <!-- Video Element (controls disabled, handled by custom UI) -->
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            class="main-video"
            bind:this={videoElement}
            src={videoUrl}
            onloadedmetadata={onVideoMetadata}
            ontimeupdate={onVideoTimeUpdate}
            onplay={onVideoPlay}
            onpause={onVideoPause}
            onended={() => { isPlaying = false; controlsVisible = true; stopTimeSync(); }}
            playsinline
          ></video>

          <!-- Direct In-Player Kurdish Subtitle Overlay -->
          <div
            class="video-subtitle-overlay"
            class:align-left={subtitleAlign === "left"}
            class:align-center={subtitleAlign === "center"}
            class:align-right={subtitleAlign === "right"}
            style="bottom: {dynamicCaptionLayout.bottomPx}px;"
          >
            {#if activeCue}
              <div
                class="active-subtitle-badge"
                class:badge-boxed={subtitleBg === "box"}
                class:badge-shadow={subtitleBg === "shadow"}
                style="font-family: {selectedFontFamily}; font-size: {dynamicCaptionLayout.fontSize}px; line-height: {dynamicCaptionLayout.lineHeight}; max-width: {dynamicCaptionLayout.maxWidthPct}%; padding: {dynamicCaptionLayout.padding};"
                dir="rtl"
              >
                {#each dynamicCaptionLayout.lines as line}
                  <div>{line}</div>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Custom Player Controls Bar -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="player-controls-bar"
            bind:this={controlsBarElement}
            onclick={(e) => e.stopPropagation()}
          >
            <!-- Scrubber Track with Real-Time Touch Dragging -->
            <div
              class="scrubber-track"
              class:is-scrubbing={isScrubbing}
              bind:this={scrubberTrack}
              onpointerdown={onScrubberPointerDown}
              onpointermove={onScrubberPointerMove}
              onpointerup={onScrubberPointerUp}
              onpointercancel={onScrubberPointerCancel}
              onkeydown={onScrubberKeydown}
              role="slider"
              aria-label="Seek timeline"
              aria-valuenow={currentTime}
              aria-valuemin="0"
              aria-valuemax={videoDuration}
              tabindex="0"
            >
              <div
                class="scrubber-fill"
                style="width: {videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0}%;"
              >
                <div class="scrubber-thumb"></div>
              </div>
            </div>

            <!-- Controls Buttons Row -->
            <div class="controls-row">
              <div class="controls-left">
                <!-- Play/Pause -->
                <button class="player-btn" aria-label={isPlaying ? "Pause" : "Play"} onclick={togglePlay}>
                  {#if isPlaying}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16"></rect>
                      <rect x="14" y="4" width="4" height="16"></rect>
                    </svg>
                  {:else}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                  {/if}
                </button>

                <!-- Timecode Display -->
                <span class="time-display">
                  {formatTime(currentTime)} / {formatTime(videoDuration)}
                </span>
              </div>

              <div class="controls-right">
                <!-- Volume Control -->
                <button class="player-btn" aria-label={isMuted ? "Unmute" : "Mute"} onclick={toggleMute}>
                  {#if isMuted || volume === 0}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="1" y1="1" x2="23" y2="23"></line>
                      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
                      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                      <line x1="12" y1="19" x2="12" y2="23"></line>
                      <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                  {/if}
                </button>
                <input
                  type="range"
                  class="volume-slider"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  oninput={onVolumeChange}
                  aria-label="Volume"
                />

                <!-- Fullscreen -->
                <button
                  class="player-btn"
                  aria-label={isFullscreen ? "Exit Fullscreen" : "Toggle Fullscreen"}
                  onclick={toggleFullscreen}
                >
                  {#if isFullscreen}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
                    </svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                    </svg>
                  {/if}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Subtitle Customization Toolbar -->
        <div class="customizer-toolbar">
          <div class="customizer-group font-action-group">
            <span class="customizer-label">Font</span>
            <button
              type="button"
              class="btn-change-font"
              onclick={() => fontShowcaseOpen = true}
              title="Change Subtitle Font"
            >
              <span class="font-icon-badge">Aa</span>
              <span class="font-current-name">{activeFontDisplayName}</span>
              <span class="font-change-tag">Change</span>
            </button>
            <input
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              style="display: none;"
              bind:this={fontUploadInput}
              onchange={onFontFileChange}
            />
          </div>

          <div class="customizer-group size-group">
            <label class="customizer-label" for="font-size-slider">Size ({subtitleFontSize}px)</label>
            <div class="size-controls-row">
              <button
                type="button"
                class="size-nudge-btn"
                title="Decrease font size"
                onclick={() => subtitleFontSize = Math.max(12, subtitleFontSize - 1)}
              >&minus;</button>
              <input
                id="font-size-slider"
                type="range"
                class="customizer-range"
                min="12"
                max="34"
                step="1"
                bind:value={subtitleFontSize}
                oninput={(e) => subtitleFontSize = Number((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="size-nudge-btn"
                title="Increase font size"
                onclick={() => subtitleFontSize = Math.min(34, subtitleFontSize + 1)}
              >+</button>
            </div>
          </div>

          <div class="customizer-group">
            <span class="customizer-label">Alignment</span>
            <div class="button-toggle-group">
              <button
                class="toggle-btn"
                class:active={subtitleAlign === "left"}
                onclick={() => subtitleAlign = "left"}
              >
                Left
              </button>
              <button
                class="toggle-btn"
                class:active={subtitleAlign === "center"}
                onclick={() => subtitleAlign = "center"}
              >
                Center
              </button>
              <button
                class="toggle-btn"
                class:active={subtitleAlign === "right"}
                onclick={() => subtitleAlign = "right"}
              >
                Right
              </button>
            </div>
          </div>

          <div class="customizer-group">
            <span class="customizer-label">Style</span>
            <div class="button-toggle-group">
              <button
                class="toggle-btn"
                class:active={subtitleBg === "box"}
                onclick={() => subtitleBg = "box"}
              >
                Boxed
              </button>
              <button
                class="toggle-btn"
                class:active={subtitleBg === "shadow"}
                onclick={() => subtitleBg = "shadow"}
              >
                Outline
              </button>
            </div>
          </div>
        </div>

        <!-- Actions Toolbar: Export and Downloads -->
        <div class="actions-toolbar">
          <button
            class="btn btn-primary"
            onclick={exportBurnedVideo}
            disabled={isBurning || cues.length === 0}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>{isBurning ? "Burning Video..." : "Download Video (MP4)"}</span>
          </button>

          <button class="btn btn-secondary" onclick={downloadSrt} disabled={cues.length === 0}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>Download .SRT</span>
          </button>

          <button class="btn btn-secondary" onclick={downloadVtt} disabled={cues.length === 0}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>Download .VTT</span>
          </button>
        </div>

        {#if isBurning}
          <div style="font-size: 12px; color: var(--accent-gold); display: flex; align-items: center; gap: 8px;">
            <div class="phase-spinner"></div>
            <span>{burnProgressText}</span>
          </div>
        {/if}
      </div>

      <!-- Right: Interactive Cue Timeline Editor -->
      <div class="studio-panel cue-panel">
        <div class="cue-panel-header">
          <div class="cue-header-title-box">
            <h2 class="cue-panel-title">Subtitle Cues ({cues.length})</h2>
            <span class="cue-lang-tag">
              {detectedLanguage ? `From ${detectedLanguage} to Sorani` : "Sorani Kurdish"}
            </span>
          </div>
          <button
            class="btn btn-secondary btn-sm"
            onclick={addCueAtCurrentTime}
            title="Insert new subtitle at current video playback position"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>+ Add ({formatTime(currentTime)})</span>
          </button>
        </div>

        <div class="cue-scroll-area">
          {#each cues as cue, i}
            {@const isActive = currentTime >= cue.start && currentTime <= cue.end}
            {@const isSelected = selectedCueIndex === i}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="cue-item"
              class:active={isActive}
              class:selected={isSelected}
              onclick={() => seekToCue(cue, i)}
            >
              <div class="cue-header-row">
                <div class="cue-idx-badge">#{i + 1}</div>

                <div class="cue-timing-actions" onclick={(e) => e.stopPropagation()}>
                  <button
                    class="cue-mini-nudge"
                    title="Nudge start earlier (-0.2s)"
                    onclick={() => nudgeCueStart(i, -0.2)}
                  >-</button>
                  <span class="cue-time-text">{formatTime(cue.start)}</span>
                  <button
                    class="cue-mini-nudge"
                    title="Nudge start later (+0.2s)"
                    onclick={() => nudgeCueStart(i, 0.2)}
                  >+</button>

                  <span class="cue-time-sep">&rarr;</span>

                  <button
                    class="cue-mini-nudge"
                    title="Nudge end earlier (-0.2s)"
                    onclick={() => nudgeCueEnd(i, -0.2)}
                  >-</button>
                  <span class="cue-time-text">{formatTime(cue.end)}</span>
                  <button
                    class="cue-mini-nudge"
                    title="Nudge end later (+0.2s)"
                    onclick={() => nudgeCueEnd(i, 0.2)}
                  >+</button>
                </div>

                <div class="cue-right-actions" onclick={(e) => e.stopPropagation()}>
                  <button
                    class="cue-sync-btn"
                    title="Set start time to current video playhead"
                    onclick={() => setCueStartToCurrentTime(i)}
                  >
                    Sync
                  </button>
                  <button
                    class="cue-delete-icon-btn"
                    title="Delete this cue"
                    aria-label="Delete cue"
                    onclick={() => deleteCue(i)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              </div>

              {#if cue.sourceText}
                <div class="cue-original-text">
                  {cue.sourceText}
                </div>
              {/if}

              <textarea
                class="cue-kurdish-input"
                style="font-family: {selectedFontFamily};"
                rows={Math.max(1, cue.lines.length)}
                value={cue.kurdishText}
                oninput={(e) => updateCueText(i, (e.target as HTMLTextAreaElement).value)}
                onclick={(e) => { e.stopPropagation(); selectedCueIndex = i; }}
                placeholder="دەقی کوردی سۆرانی..."
              ></textarea>
            </div>
          {/each}
        </div>
      </div>
    </main>
  {/if}

  <!-- =========================================================================
       SETTINGS MODAL
       ========================================================================= -->
  {#if settingsOpen}
    <div
      class="modal-backdrop"
      onclick={() => settingsOpen = false}
      onkeydown={(e) => { if (e.key === "Escape") settingsOpen = false; }}
      role="presentation"
    >
      <div
        class="modal-box"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-settings-title"
        tabindex="-1"
      >
        <div class="modal-header">
          <h3 id="modal-settings-title" class="modal-title">API Configuration</h3>
          <button class="btn-icon" aria-label="Close" onclick={() => settingsOpen = false}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="form-group">
          <label class="form-label" for="cfg-gemini-key">Gemini API Key</label>
          <input
            id="cfg-gemini-key"
            type="password"
            class="form-input"
            bind:value={geminiKeyInput}
            placeholder="AQ... / AIzaSy..."
          />
          <span class="form-hint">Used for audio speech recognition and Sorani Kurdish translation.</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="cfg-gemini-model">Gemini Model (Direct Audio to Sorani Kurdish Subtitles)</label>
          <select id="cfg-gemini-model" class="form-input" bind:value={geminiModelInput}>
            <option value="gemini-3.8-flash">gemini-3.8-flash (Thinking, Default)</option>
            <option value="gemini-3-flash-preview">gemini-3.0-flash (Preview)</option>
            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            <option value="gemini-robotics-er-2-preview">gemini-robotics-er-2-preview</option>
            <option value="gemini-3.7-flash">gemini-3.7-flash</option>
            <option value="gemini-3.6-flash">gemini-3.6-flash</option>
            <option value="gemini-3.5-flash">gemini-3.5-flash</option>
            <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
            <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            <option value="gemini-flash-latest">gemini-flash-latest</option>
          </select>
          <span class="form-hint">Direct 1-go audio to Sorani subtitles. Default fallback: Gemini 3.8 Flash Thinking → 3.0 Flash → 2.5 Flash.</span>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
          <button class="btn btn-secondary" onclick={resetToDefaults}>
            Reset to Default Keys
          </button>
          <button class="btn btn-primary" onclick={saveSettings}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- =========================================================================
       CHANGE FONT & SHOWCASE MODAL (گۆڕینی فۆنت)
       ========================================================================= -->
  {#if fontShowcaseOpen}
    <div
      class="modal-backdrop font-showcase-backdrop"
      onclick={() => fontShowcaseOpen = false}
      onkeydown={(e) => { if (e.key === "Escape") fontShowcaseOpen = false; }}
      role="presentation"
    >
      <div
        class="font-showcase-modal"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Change Subtitle Font"
        tabindex="-1"
        dir="ltr"
      >
        <!-- Modal Header -->
        <div class="showcase-header">
          <h2 class="showcase-title">Fonts</h2>
          <button
            class="btn-icon showcase-close-btn"
            aria-label="Close"
            onclick={() => fontShowcaseOpen = false}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <!-- Success/Error alert if font uploaded -->
        {#if fontUploadSuccess}
          <div class="font-alert success">
            <span>&#10003;</span>
            <span>{fontUploadSuccess}</span>
          </div>
        {/if}

        <!-- Top Action Row: Upload Button & Quick Standard/Custom Font Pills -->
        <div class="modal-top-section">
          <div class="modal-actions-bar">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onclick={() => fontUploadInput?.click()}
            >
              + Upload Font (.ttf)
            </button>
            <div class="quick-pills-list">
              <button
                type="button"
                class="quick-font-pill"
                class:active={selectedFontId === "Noto Kufi Arabic"}
                onclick={() => selectAndApplyFont({ id: "Noto Kufi Arabic", name: "Noto Kufi Arabic" })}
              >
                Noto Kufi (Default)
                {#if selectedFontId === "Noto Kufi Arabic"}<span class="pill-check">✓</span>{/if}
              </button>
              <button
                type="button"
                class="quick-font-pill"
                class:active={selectedFontId === "Noto Sans Arabic"}
                onclick={() => selectAndApplyFont({ id: "Noto Sans Arabic", name: "Noto Sans Arabic" })}
              >
                Noto Sans
                {#if selectedFontId === "Noto Sans Arabic"}<span class="pill-check">✓</span>{/if}
              </button>
              {#each uploadedFonts as uf}
                {@const isSelected = selectedFontId === uf.id}
                <div class="quick-font-pill uploaded-chip" class:active={isSelected}>
                  <button
                    type="button"
                    class="chip-select-btn"
                    onclick={() => selectAndApplyFont(uf)}
                  >
                    ★ {uf.name} {isSelected ? "✓" : ""}
                  </button>
                  <button
                    type="button"
                    class="chip-del-btn"
                    title="Delete font"
                    onclick={() => removeUploadedFont(uf.id)}
                  >&times;</button>
                </div>
              {/each}
            </div>
          </div>

          <!-- Clean Search Input -->
          <div class="showcase-search-box">
            <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              class="showcase-search-input"
              placeholder="Search fonts..."
              bind:value={fontSearchQuery}
            />
            {#if fontSearchQuery}
              <button type="button" class="clear-search-btn" onclick={() => fontSearchQuery = ""}>&times;</button>
            {/if}
          </div>
        </div>

        <!-- 50 Kurdish Fonts Cards Grid -->
        <div class="showcase-grid-scroll">
          <div class="showcase-grid">
            {#each filteredKurdishFonts as font (font.id)}
              {@const isCurrentSelected = selectedFontId === font.name}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="font-pick-card"
                class:is-selected={isCurrentSelected}
                onclick={() => selectAndApplyFont(font)}
              >
                <div class="font-card-header">
                  <span class="font-card-title">#{font.rank} {font.name}</span>
                  {#if isCurrentSelected}
                    <span class="active-badge">✓ Active</span>
                  {/if}
                </div>

                <div class="font-specimen-wrap">
                  <img
                    src={font.localPreview}
                    alt={font.name}
                    class="font-specimen-img"
                    loading="lazy"
                    onerror={(e) => {
                      (e.currentTarget as HTMLImageElement).src = font.remotePreview;
                    }}
                  />
                </div>
              </div>
            {/each}
          </div>

          {#if filteredKurdishFonts.length === 0}
            <div class="showcase-empty">
              <p>No fonts found matching "{fontSearchQuery}"</p>
              <button type="button" class="btn btn-secondary btn-sm" onclick={() => fontSearchQuery = ""}>
                Clear
              </button>
            </div>
          {/if}
        </div>

        <!-- Sticky Modal Footer -->
        <div class="showcase-sticky-footer">
          <div class="footer-current-font">
            <span class="footer-label">Active:</span>
            <span class="footer-font-name">{activeFontDisplayName}</span>
          </div>
          <button type="button" class="btn btn-primary btn-sm" onclick={() => fontShowcaseOpen = false}>
            Done
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
