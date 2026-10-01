import './style.css';
import { EditSession, formatTime, normalizeRange, type Range } from './model.ts';
import { Timeline } from './timeline.ts';
import * as bridge from './bridge.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const frame = $<HTMLImageElement>('frame');
const fileInput = $<HTMLInputElement>('browser-file');
const dialog = $<HTMLDialogElement>('export-dialog');
const container = $<HTMLSelectElement>('container');
const status = $('status');
let source: bridge.MediaInfo | null = null;
let sourcePath = '';
let session: EditSession | null = null;
let time = 0;
let selection: Range | null = null;
let inPoint: number | null = null;
let outPoint: number | null = null;
let selectedId: number | null = null;
let openGeneration = 0;
let objectUrl: string | null = null;
let fallback = false;
let seeking = false;
let lastSeek = 0;
let seekTimer: ReturnType<typeof setTimeout> | undefined;
let previewBusy = false;
let previewPending: { time: number; accurate: boolean; generation: number; serial: number } | null = null;
let previewSerial = 0;
let playbackRaf = 0;
let exportJob: string | null = null;
let exportStarting = false;
let openingAt = 0;
const frameCache = new Map<string, string>();

const metrics = { shellMs: performance.now(), firstFrameMs: 0, probeMs: 0, lastEditMs: 0 };
// Read-only instrumentation, used by performance verification without affecting startup.
Object.defineProperty(window, '__QUICKCUT_METRICS__', { value: metrics });
performance.mark('quickcut:shell');
const mac = /Mac/.test(navigator.platform);
if (mac) {
  document.querySelectorAll('.open-shortcut').forEach(e => e.textContent = 'Cmd + O');
  document.querySelectorAll('.export-shortcut').forEach(e => e.textContent = 'Cmd + E  Export');
}

function message(text: string, error = false): void { status.textContent = text; status.classList.toggle('error', error); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function loaded(): boolean { return !!session; }
function render(): void {
  const available = loaded();
  for (const id of ['previous-frame', 'next-frame', 'mark-in', 'mark-out', 'split']) $<HTMLButtonElement>(id).disabled = !available;
  $<HTMLButtonElement>('play').disabled = !available || fallback;
  $<HTMLButtonElement>('remove').disabled = !available || !selection;
  $<HTMLButtonElement>('keep').disabled = !available || !selection;
  $<HTMLButtonElement>('export').disabled = !available || !session!.segments.length || !!exportJob || exportStarting;
  $<HTMLButtonElement>('undo').disabled = !session?.canUndo;
  $<HTMLButtonElement>('redo').disabled = !session?.canRedo;
  $('current-time').textContent = formatTime(time);
  $('duration').textContent = formatTime(session?.duration ?? 0);
  $('range-info').hidden = !selection;
  $('timeline-info').hidden = !available;
  if (selection) $('selection-label').textContent = `${formatTime(selection.start)} → ${formatTime(selection.end)}   ·   ${formatTime(selection.end - selection.start)} selected`;
  if (session) $('clip-summary').textContent = `${session.segments.length} ${session.segments.length === 1 ? 'clip' : 'clips'} · ${formatTime(session.outputDuration, false)} to export`;
  timeline.update({ duration: session?.duration ?? 0, time, segments: session?.segments ?? [], selection, selectedId });
}
function setSelection(range: Range | null, id?: number): void {
  selection = range && session ? normalizeRange(range, session.duration) : null;
  if (selection && selection.end - selection.start < .000001) selection = null;
  inPoint = selection?.start ?? null;
  outPoint = selection?.end ?? null;
  selectedId = id ?? null;
  render();
}
const timeline = new Timeline($<HTMLCanvasElement>('timeline'), { seek, select: setSelection });

function pause(): void { video.pause(); cancelAnimationFrame(playbackRaf); updatePlayButton(); }
function updatePlayButton(): void {
  const playing = !video.paused;
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('play').innerHTML = playing ? '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zm6 0h3v14h-3z" class="filled" /></svg>' : '<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z" class="filled" /></svg>';
}
function playbackTick(): void {
  if (!session || video.paused) return;
  time = Math.min(video.currentTime, session.duration);
  // Playback previews the retained clips and skips deleted gaps.
  const next = session.segments.find(s => s.enabled && s.end > time + .0001);
  if (!next) { pause(); time = session.duration; render(); return; }
  if (time < next.start) { video.currentTime = next.start; time = next.start; }
  $('current-time').textContent = formatTime(time);
  timeline.setTime(time);
  playbackRaf = requestAnimationFrame(playbackTick);
}
async function togglePlay(): Promise<void> {
  if (!session) return;
  if (fallback) { message('This codec needs a system playback decoder. Frame preview, cuts and export are available.'); return; }
  if (!video.paused) { pause(); return; }
  const retained = session.segments.find(s => s.end > time);
  if (!retained) {
    if (!session.segments.length) return;
    seek(session.segments[0].start, false);
  } else if (time < retained.start) seek(retained.start, false);
  try { await video.play(); updatePlayButton(); playbackRaf = requestAnimationFrame(playbackTick); }
  catch (error) { message(`Playback unavailable: ${errorMessage(error)}`, true); }
}

function seek(target: number, dragging: boolean): void {
  if (!session) return;
  pause();
  time = Math.max(0, Math.min(session.duration, target));
  $('current-time').textContent = formatTime(time);
  timeline.setTime(time);
  clearTimeout(seekTimer);
  if (fallback) {
    if (!dragging || performance.now() - lastSeek > 100) {
      lastSeek = performance.now(); void requestFrame(time, !dragging);
    }
    if (dragging) seekTimer = setTimeout(() => { void requestFrame(time, true); }, 100);
    return;
  }
  // While dragging, coalesce native seeks to one per frame. Finish with an accurate seek.
  if (!dragging) { video.currentTime = Math.min(time, Math.max(0, session.duration - 1 / (source?.fps || 30))); return; }
  if (!seeking) {
    seeking = true;
    requestAnimationFrame(() => {
      seeking = false;
      if (fallback || !session) return;
      const targetTime = Math.min(time, Math.max(0, session.duration - .001));
      if (typeof video.fastSeek === 'function') video.fastSeek(targetTime);
      else video.currentTime = targetTime;
    });
  }
  seekTimer = setTimeout(() => { if (session && !fallback) video.currentTime = Math.min(time, Math.max(0, session.duration - .001)); }, 100);
}

async function requestFrame(target: number, accurate: boolean): Promise<void> {
  if (!bridge.desktop || !sourcePath) return;
  const serial = ++previewSerial;
  const generation = openGeneration;
  const targetTime = Math.max(0, Math.min(target, (session?.duration ?? source?.duration ?? target + 1) - 1 / (source?.fps || 30)));
  const key = `${accurate ? 'a' : 'k'}:${targetTime.toFixed(3)}`;
  const cached = frameCache.get(key);
  if (cached) { previewPending = null; frame.src = cached; frame.hidden = false; return; }
  previewPending = { time: targetTime, accurate, generation, serial };
  if (previewBusy) return;
  previewBusy = true;
  try {
    while (previewPending) {
      const request = previewPending;
      previewPending = null;
      const path = sourcePath;
      try {
        const data = await bridge.extractFrame(path, request.time, request.accurate);
        if (request.generation !== openGeneration) continue;
        const uri = `data:image/jpeg;base64,${data}`;
        frameCache.set(`${request.accurate ? 'a' : 'k'}:${request.time.toFixed(3)}`, uri);
        while (frameCache.size > 20) frameCache.delete(frameCache.keys().next().value!);
        // A completed older request never replaces a newer requested preview.
        if (request.serial === previewSerial && !previewPending && (fallback || video.readyState < 2)) { frame.src = uri; frame.hidden = false; firstFrame(); }
      } catch (error) { if (request.generation === openGeneration && fallback) message(`Frame preview: ${errorMessage(error)}`, true); }
    }
  } finally { previewBusy = false; }
}
function firstFrame(): void {
  if (!metrics.firstFrameMs) {
    metrics.firstFrameMs = performance.now() - openingAt;
    performance.mark('quickcut:first-frame');
  }
  $('opening').hidden = true;
}
function createSession(duration: number): void {
  if (!session && Number.isFinite(duration) && duration > 0) session = new EditSession(duration);
  render();
}
function resetForOpen(name: string): number {
  if (dialog.open) dialog.close();
  pause(); clearTimeout(seekTimer);
  const generation = ++openGeneration;
  openingAt = performance.now(); metrics.firstFrameMs = 0; metrics.probeMs = 0;
  source = null; sourcePath = ''; session = null; selection = null; selectedId = null; time = 0; inPoint = null; outPoint = null; fallback = false;
  frameCache.clear(); previewPending = null;
  video.removeAttribute('src'); video.load(); video.hidden = true;
  frame.hidden = true; frame.removeAttribute('src');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  $('empty').hidden = true; $('opening').hidden = false; $('preview-notice').hidden = true;
  $('filename').textContent = name; $('filename').title = name;
  message('Opening video…'); render();
  return generation;
}
async function openPath(path: string): Promise<void> {
  const generation = resetForOpen(path.split(/[\\/]/).at(-1)!);
  sourcePath = path;
  try {
    // Grant only this file, then start native playback and ffprobe independently.
    const url = await bridge.grantMedia(path);
    if (generation !== openGeneration) return;
    video.src = url; video.hidden = false;
    const probeStart = performance.now();
    const probed = await bridge.probeMedia(path);
    if (generation !== openGeneration) return;
    source = probed;
    metrics.probeMs = performance.now() - probeStart;
    createSession(source.duration);
    message(`${source.width} × ${source.height} · ${source.codec.toUpperCase()} · ${source.fps.toFixed(2)} fps · Original quality`);
    // Native metadata/frame events usually arrive first. Decode one frame only if needed.
    if (fallback || video.readyState < 2) void requestFrame(0, true);
  } catch (error) {
    if (generation !== openGeneration) return;
    $('opening').hidden = true;
    message(errorMessage(error), true);
    if (!session) { $('empty').hidden = false; video.hidden = true; }
  }
}
function openBrowserFile(file: File): void {
  resetForOpen(file.name);
  objectUrl = URL.createObjectURL(file); video.src = objectUrl; video.hidden = false;
  message('Local preview · run the desktop app to export with FFmpeg');
}
async function openFile(): Promise<void> {
  if (!bridge.desktop) { fileInput.click(); return; }
  try { const path = await bridge.pickVideo(); if (path) await openPath(path); }
  catch (error) { message(errorMessage(error), true); }
}
video.addEventListener('loadedmetadata', () => {
  createSession(video.duration);
  if (!bridge.desktop && session) {
    source = { path: '', duration: video.duration, codec: 'video', container: '', width: video.videoWidth, height: video.videoHeight, fps: 30, timeBase: '', audio: [], size: 0 };
  }
});
video.addEventListener('loadeddata', () => { frame.hidden = true; firstFrame(); });
video.addEventListener('seeked', () => { if (!fallback && video.readyState >= 2) frame.hidden = true; });
video.addEventListener('ended', () => { pause(); render(); });
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  if (bridge.desktop) {
    fallback = true; video.hidden = true;
    $('preview-notice').textContent = 'Playback decoder unavailable for this codec. Scrub or step through frames; cutting and export still work.';
    $('preview-notice').hidden = false;
    void requestFrame(time, true); render();
  } else { $('opening').hidden = true; $('empty').hidden = false; message('This browser cannot play this video. Open it in the desktop app for FFmpeg frame preview.', true); }
});

function mark(which: 'in' | 'out'): void {
  if (!session) return;
  if (which === 'in') inPoint = time;
  else outPoint = time;
  selection = normalizeRange({ start: inPoint ?? 0, end: outPoint ?? session.duration }, session.duration);
  selectedId = null; render();
  message(`Marked ${which === 'in' ? 'start' : 'end'} at ${formatTime(time)}`);
}
function edit(operation: 'remove' | 'keep' | 'split'): void {
  if (!session) return;
  const before = performance.now();
  const changed = operation === 'split' ? session.split(time) : selection ? session[operation](selection) : false;
  metrics.lastEditMs = performance.now() - before;
  if (!changed) { message(operation === 'split' ? 'Move the playhead inside a retained clip to split it.' : 'Select a range first.'); return; }
  setSelection(null);
  message(operation === 'keep' ? 'Range kept · select another range and press K to add it' : operation === 'remove' ? 'Range removed · Ctrl / Cmd + Z to undo' : 'Clip split at playhead');
}
function history(redo: boolean): void {
  const name = redo ? session?.redo() : session?.undo();
  if (name) { setSelection(null); message(`${redo ? 'Redid' : 'Undid'} ${name.toLowerCase()}`); }
}
function compatibility(): void {
  const warnings: string[] = [];
  if (container.value === 'mp4' && source?.audio.some(a => a.codec.startsWith('pcm_'))) warnings.push('PCM audio needs MOV or MKV to preserve its codec.');
  if (container.value !== 'mkv' && source && !['h264', 'hevc', 'video'].includes(source.codec)) warnings.push('MKV is recommended for this video codec.');
  $('compatibility').textContent = warnings.join(' '); $('compatibility').hidden = !warnings.length;
}
function showExport(): void {
  if (!session?.segments.length || exportJob || exportStarting) return;
  if (!bridge.desktop) { message('FFmpeg export is available in the desktop app. Use npm run desktop.', true); return; }
  container.value = source?.audio.some(a => a.codec.startsWith('pcm_')) ? 'mov' : 'mp4';
  $('export-summary').textContent = `${session.segments.length} ${session.segments.length === 1 ? 'clip' : 'clips'} · ${formatTime(session.outputDuration, false)} retained`;
  compatibility(); dialog.showModal(); $<HTMLButtonElement>('confirm-export').focus();
}
async function startExport(): Promise<void> {
  if (!session || !sourcePath || exportJob || exportStarting) return;
  // Capture the edit before awaiting the native save dialog.
  const path = sourcePath, ranges = session.segments.filter(s => s.enabled).map(({ start, end }) => ({ start, end })), duration = session.duration, format = container.value;
  const jobId = crypto.randomUUID(); exportJob = jobId; exportStarting = true;
  $<HTMLProgressElement>('progress').value = 0;
  $('progress-percent').textContent = '0%';
  $('progress-detail').textContent = 'Preparing cuts';
  dialog.close(); render();
  try {
    if (await bridge.exportVideo(path, ranges, duration, format, jobId)) {
      if (exportJob === jobId) { $('export-progress').hidden = false; message('Exporting original streams…'); }
    } else exportJob = null;
  } catch (error) { exportJob = null; message(errorMessage(error), true); }
  finally { exportStarting = false; render(); }
}
function exportProgress(update: bridge.ExportProgress): void {
  if (update.jobId !== exportJob) return;
  $('export-progress').hidden = update.done;
  $<HTMLProgressElement>('progress').value = update.percent;
  $('progress-percent').textContent = `${Math.round(update.percent)}%`;
  $('progress-label').textContent = 'Exporting…';
  $('progress-detail').textContent = update.stage;
  if (update.done) {
    exportJob = null;
    message(update.error ?? (update.cancelled ? 'Export cancelled' : `Exported ${update.output?.split(/[\\/]/).at(-1)} · Original quality`), !!update.error);
    render();
  }
}

$('open').addEventListener('click', () => { void openFile(); });
$('empty').addEventListener('dblclick', () => { void openFile(); });
$('play').addEventListener('click', () => { void togglePlay(); });
$('previous-frame').addEventListener('click', () => seek(time - 1 / (source?.fps || 30), false));
$('next-frame').addEventListener('click', () => seek(time + 1 / (source?.fps || 30), false));
$('mark-in').addEventListener('click', () => mark('in'));
$('mark-out').addEventListener('click', () => mark('out'));
$('split').addEventListener('click', () => edit('split'));
$('remove').addEventListener('click', () => edit('remove'));
$('keep').addEventListener('click', () => edit('keep'));
$('clear-selection').addEventListener('click', () => setSelection(null));
$('undo').addEventListener('click', () => history(false));
$('redo').addEventListener('click', () => history(true));
$('fit').addEventListener('click', () => timeline.fit());
$('export').addEventListener('click', showExport);
$('close-export').addEventListener('click', () => dialog.close());
$('cancel-export-dialog').addEventListener('click', () => dialog.close());
$('export-form').addEventListener('submit', e => { e.preventDefault(); void startExport(); });
container.addEventListener('change', compatibility);
$('cancel-job').addEventListener('click', () => {
  if (exportJob) { $('progress-detail').textContent = 'Cancelling…'; void bridge.cancelExport(exportJob).catch(error => message(errorMessage(error), true)); }
});
fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) openBrowserFile(fileInput.files[0]); fileInput.value = ''; });

window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || dialog.open) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'o') { e.preventDefault(); void openFile(); return; }
  if (mod && key === 'e') { e.preventDefault(); showExport(); return; }
  if (mod && key === 'z') { e.preventDefault(); history(e.shiftKey); return; }
  if (mod && key === 'y') { e.preventDefault(); history(true); return; }
  if (!session || e.altKey || mod) return;
  // Global shortcuts also work while a toolbar button has focus.
  switch (key) {
    case ' ': e.preventDefault(); void togglePlay(); break;
    case 'arrowleft': e.preventDefault(); seek(time - (e.shiftKey ? 1 / (source?.fps || 30) : 5), false); break;
    case 'arrowright': e.preventDefault(); seek(time + (e.shiftKey ? 1 / (source?.fps || 30) : 5), false); break;
    case 'i': e.preventDefault(); mark('in'); break;
    case 'o': e.preventDefault(); mark('out'); break;
    case 's': e.preventDefault(); edit('split'); break;
    case 'delete': case 'backspace': e.preventDefault(); edit('remove'); break;
    case 'k': e.preventDefault(); edit('keep'); break;
    case 'escape': setSelection(null); break;
    case 'home': e.preventDefault(); seek(0, false); break;
    case 'end': e.preventDefault(); seek(session.duration, false); break;
    case '+': case '=': e.preventDefault(); timeline.zoom(1.5); break;
    case '-': e.preventDefault(); timeline.zoom(1 / 1.5); break;
    case 'f': timeline.fit(); break;
  }
});
window.addEventListener('dragover', e => { e.preventDefault(); if (!bridge.desktop) $('drop-overlay').hidden = false; });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) $('drop-overlay').hidden = true; });
window.addEventListener('drop', e => { e.preventDefault(); $('drop-overlay').hidden = true; if (!bridge.desktop && e.dataTransfer?.files[0]) openBrowserFile(e.dataTransfer.files[0]); });
render();
// Event listeners are cheap; FFmpeg is discovered only in response to opening media.
if (bridge.desktop) {
  requestAnimationFrame(() => requestAnimationFrame(() => { void bridge.reportShell(metrics.shellMs); }));
  void bridge.listenExport(exportProgress).catch(error => message(errorMessage(error), true));
  void bridge.listenOpen(path => { void openPath(path); }, error => message(errorMessage(error), true)).catch(error => message(errorMessage(error), true));
  void bridge.listenDrop((paths, hover) => {
    $('drop-overlay').hidden = !hover;
    if (paths?.[0]) void openPath(paths[0]);
  }).catch(error => message(errorMessage(error), true));
}
