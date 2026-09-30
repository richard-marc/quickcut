# Verification — September 30, 2026

## Result

The Windows desktop MVP is implemented and verified. The native window appears immediately, range edits stay in memory, and exports copy original video/audio streams. Precise Cut remains phase 5.

## Functional checks

| Check | Result |
| --- | --- |
| TypeScript type check and production build | Pass |
| Rust native compile check and release build | Pass |
| Range operations, multiple Keep ranges, undo/redo, selection bounds | 6 passing TypeScript tests |
| Metadata, fractional frame rate, container checks, range validation | 3 passing Rust unit tests |
| Real MP4/MOV/MKV exports, open-GOP HEVC, PCM audio | Pass |
| Retained encoded video payload hashes unchanged | Pass |
| Complete exported files decode without FFmpeg errors | Pass |
| Source file unchanged and existing output protected | Pass |
| Cancellation interrupts work, publishes no output, removes temporary files | Pass |
| Direct single-clip export and multi-clip rotation preservation | Pass |
| Browser page identity, nonblank editor, no framework overlay or app console errors | Pass |
| Native file access, playback, frame stepping, global shortcuts, drag selection and clip selection | Pass |
| Native Ctrl/Cmd + E → Enter, actual FFmpeg progress and output | Pass |
| Bundled FFmpeg/ffprobe discovery with an empty process PATH | Pass |

Desktop automation used the real release executable and WebView2. Only the open/save dialog responses were stubbed in the test process; asset access, FFprobe, frame extraction, range edits, FFmpeg export, progress events, and final files were real. Actual native drag/drop integration is wired to Tauri window events; OS-level dragging from Explorer was not automated.

## Acceptance workflow

A generated 30-minute H.264/AAC MP4 was opened, then three ranges were drag-selected and deleted: 02:00–03:00, 10:00–12:00, and 23:20–24:00. Four retained clips were exported to a 26:20 MP4 without re-encoding. The entire result decoded successfully.

This synthetic, mostly static 640×360 file verifies a long duration and the edit/export workflow; it is not a throughput benchmark for a high-bitrate camera recording or a hundreds-of-GB source.

## Measurements

Measured on this Windows machine using the existing OS and WebView2 caches. The startup script records native window appearance and the editor's first painted shell separately. These are observational samples, not certified controlled cold-start results.

| Measurement | Observed |
| --- | --- |
| Native window appearance, five launches | 72.2, 35.3, 27.0, 35.6, 31.5 ms |
| Full shell paint, same launches | 399.9, 364.1, 370.6, 354.2, 357.6 ms |
| Frontend startup portion | 18.1–18.7 ms |
| First frame, 12-second 1280×720 H.264 sample | about 14–19 ms |
| First frame, 30-minute 640×360 H.264 sample | 61.4 ms |
| FFprobe on local sample | about 53–55 ms |
| Native two-range export from the 12-second sample | about 311–332 ms |
| 30-minute source → 26:20 export | about 1.17 s |
| Animation-frame callbacks during drag selection and export | 656 samples; 240 FPS average, 4.3 ms p95/max frame interval |
| Codec integration exports with three retained clips | about 0.64–0.69 s per fixture, including verification |
| Initial production JavaScript | about 22.3 KB uncompressed / 8.2 KB gzip |
| Main desktop executable | about 5 MB; FFmpeg binaries are separate |

The animation-frame sample used this machine's high-refresh display, a synthetic low-bitrate source, three drags with 120 pointer updates each, and an active export. It verifies that this workflow kept the UI event loop responsive; it does not measure decoded video frame rate or guarantee the same result on difficult media.

The sub-200-ms warm target is met for window appearance, but **not for the fully painted editor**: observed full-shell startup is roughly 350–400 ms. Controlled cold launch, sustained 60 FPS under difficult codecs, peak memory across giant files, VFR frame stepping, unusual media metadata, and macOS/Linux remain unverified. The architecture avoids full-file loading/indexing and unbounded preview work; these remaining performance targets should be profiled against representative real recordings before a wider release.

`window.__QUICKCUT_METRICS__` exposes read-only shell/open/edit timings in developer tools. `QUICKCUT_PERF_LOG` opts into a local startup JSONL log after the first paint. Neither adds network requests or startup media work.

## Visual verification

The frontend builder's generated empty-editor concept was compared with native desktop screenshots using `view_image`. The requested QuickCut name and lavender palette supersede the original concept’s branding. Layout and controls were checked against the original design in these five areas:

1. **Copy:** QuickCut, Untitled, Open video, Export, the empty-state instructions, control labels, and shortcut hints retain the concept’s control copy and use the requested QuickCut wordmark. No marketing or extra navigation was added.
2. **Layout:** one full-width preview, one transport row, one source timeline, and a thin bottom status rail; no sidebar or card grid.
3. **Typography:** system UI for controls and instructions, monospaced timestamps/shortcut keys, deliberate sizes throughout.
4. **Palette and containers:** charcoal shell, almost-black preview, lavender export/selection/playhead, subtle borders, small radii, flat rails.
5. **Icons and interaction states:** thin file/frame-step outlines, filled play icon, lavender range handles, deliberate disabled/hover/focus states.

Intentional functional additions are selection times/clear, retained clip duration, undo/redo/fit, and the requested export/progress/cancel surfaces. Empty-editor controls are disabled until a source/selection is available. Native screenshots used a real 1200×800 CSS window (1800×1200 pixels at this display's scale), rather than the concept's 1584×992 pixels. Viewport emulation interfered with WebView2 playback, so native interaction QA uses the real window size. The in-app browser was also checked at 1200 CSS pixels and a narrow layout; its screenshot viewport scaling was unreliable. Native screenshots provide the final visual evidence.

Concept: `C:/Users/richa/.codex/generated_images/01a0f40f-185b-7b91-abd1-be058ed758c1/exec-8530bbe6-8e9e-40bc-85c1-8e871711c9df.png`.

Evidence directory on the development machine: `C:/Users/richa/.codex/visualizations/2026/09/30/01a0f40f-185b-7b91-abd1-be058ed758c1/`. It contains the original `native-*` evidence and the current `quickcut-empty.png`, `quickcut-loaded.png`, and `quickcut-qa.json`. QA fixtures, scripts, and screenshots are outside the source tree and are not included in Git.
