import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import type { Range } from './model.ts';

export const desktop = isTauri();
export function reportShell(frontendMs: number): Promise<void> { return invoke('shell_ready', { frontendMs }); }
export interface AudioStream { index: number; codec: string; channels: number; sampleRate: number; language: string | null }
export interface MediaInfo {
  path: string; duration: number; codec: string; container: string; width: number; height: number;
  fps: number; timeBase: string; audio: AudioStream[]; size: number;
}
export interface ExportProgress { jobId: string; percent: number; stage: string; done: boolean; cancelled: boolean; error: string | null; output: string | null; actualRanges?: Range[] }

export async function pickVideo(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ title: 'Open video', multiple: false, directory: false, filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v'] }] });
  return typeof path === 'string' ? path : null;
}
export async function grantMedia(path: string): Promise<string> {
  const canonical = await invoke<string>('grant_media', { path });
  return convertFileSrc(canonical);
}
export async function probeMedia(path: string): Promise<MediaInfo> { return invoke('probe_media', { path }); }
export async function extractFrame(path: string, time: number, accurate: boolean): Promise<string> { return invoke('extract_frame', { path, time, accurate }); }
export async function exportVideo(path: string, ranges: Range[], duration: number, container: string, jobId: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const stem = path.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, '');
  const output = await save({ title: 'Export video', defaultPath: path.replace(/[^\\/]+$/, `${stem}-cut.${container}`), filters: [{ name: container.toUpperCase(), extensions: [container] }] });
  if (!output) return false;
  await invoke('start_export', { path, output, ranges, duration, jobId });
  return true;
}
export async function cancelExport(jobId: string): Promise<void> { await invoke('cancel_export', { jobId }); }
export async function listenExport(callback: (progress: ExportProgress) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<ExportProgress>('export-progress', e => callback(e.payload));
}
export async function listenDrop(callback: (paths: string[] | null, hover: boolean) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ paths: string[] | null; hover: boolean }>('media-drop', e => callback(e.payload.paths, e.payload.hover));
}
export async function listenOpen(callback: (path: string) => void, onError: (error: unknown) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  let draining = false, requested = false, active = true;
  const drain = async () => {
    requested = true;
    if (draining) return;
    draining = true;
    try {
      while (requested && active) {
        requested = false;
        const path = await invoke<string | null>('take_open_file');
        if (path && active) callback(path);
      }
    } finally { draining = false; }
  };
  // Listen before taking the startup path, so launches during initialization are kept.
  const unlisten = await listen('media-open-request', () => { void drain().catch(onError); });
  try { await drain(); }
  catch (error) { active = false; unlisten(); throw error; }
  return () => { active = false; unlisten(); };
}
