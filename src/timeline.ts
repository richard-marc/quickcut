import { formatTime, type Range, type Segment } from './model.ts';

interface TimelineState { duration: number; time: number; segments: Segment[]; selection: Range | null; selectedId: number | null }
interface TimelineCallbacks { seek(time: number, dragging: boolean): void; select(range: Range | null, id?: number): void }
type SelectionEdge = 'start' | 'end';
interface TimelinePointer { id: number; x: number; time: number; moved: boolean; ruler: boolean; resize: { edge: SelectionEdge; range: Range } | null }

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private state: TimelineState = { duration: 0, time: 0, segments: [], selection: null, selectedId: null };
  private viewport = { start: 0, span: 0 };
  private width = 0;
  private height = 0;
  private drawPending = false;
  private pointer: TimelinePointer | null = null;
  private colors: Record<'background' | 'surface' | 'border' | 'tick' | 'muted' | 'clip' | 'clipSelected' | 'clipEdge' | 'clipLabel' | 'selection' | 'accent', string>;

  constructor(private canvas: HTMLCanvasElement, private callbacks: TimelineCallbacks) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    // Read theme tokens once; canvas painting never needs a computed-style lookup.
    const style = getComputedStyle(canvas);
    const color = (token: string) => style.getPropertyValue(token).trim();
    this.colors = { background: color('--bg'), surface: color('--surface'), border: color('--border'), tick: color('--timeline-tick'), muted: color('--muted'), clip: color('--clip'), clipSelected: color('--clip-selected'), clipEdge: color('--clip-edge'), clipLabel: color('--clip-label'), selection: color('--selection'), accent: color('--accent') };
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    canvas.addEventListener('pointermove', e => this.pointerMove(e));
    canvas.addEventListener('pointerup', e => this.pointerUp(e));
    canvas.addEventListener('pointercancel', () => { this.pointer = null; canvas.style.cursor = ''; });
    canvas.addEventListener('lostpointercapture', () => { this.pointer = null; canvas.style.cursor = ''; });
    canvas.addEventListener('pointerleave', () => { if (!this.pointer) canvas.style.cursor = ''; });
    canvas.addEventListener('wheel', e => {
      if (!this.state.duration) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.3 : 1 / 1.3, this.xTime(e.offsetX));
      else {
        this.viewport.start = Math.max(0, Math.min(this.state.duration - this.viewport.span, this.viewport.start + (e.deltaX || e.deltaY) / this.width * this.viewport.span));
        this.invalidate();
      }
    }, { passive: false });
  }
  update(state: TimelineState): void {
    if (state.duration !== this.state.duration) this.viewport = { start: 0, span: state.duration };
    this.state = state;
    this.canvas.setAttribute('aria-valuemax', state.duration.toFixed(3));
    this.canvas.setAttribute('aria-valuenow', state.time.toFixed(3));
    this.canvas.setAttribute('aria-valuetext', formatTime(state.time));
    this.invalidate();
  }
  setTime(time: number): void {
    this.state.time = time;
    // Playback follows the playhead only when the timeline is zoomed in.
    if (!this.pointer && this.viewport.span < this.state.duration && (time < this.viewport.start || time > this.viewport.start + this.viewport.span)) {
      this.viewport.start = Math.max(0, Math.min(this.state.duration - this.viewport.span, time - this.viewport.span * .1));
    }
    this.invalidate();
  }
  fit(): void { this.viewport = { start: 0, span: this.state.duration }; this.invalidate(); }
  zoom(factor: number, anchor = this.state.time): void {
    const before = this.viewport.span;
    if (!before) return;
    const fraction = (anchor - this.viewport.start) / before;
    const span = Math.max(Math.min(1, this.state.duration), Math.min(this.state.duration, before / factor));
    this.viewport = { start: Math.max(0, Math.min(this.state.duration - span, anchor - fraction * span)), span };
    this.invalidate();
  }
  private resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = bounds.width;
    this.height = bounds.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.invalidate();
  }
  private xTime(x: number): number { return Math.max(0, Math.min(this.state.duration, this.viewport.start + x / this.width * this.viewport.span)); }
  private timeX(time: number): number { return (time - this.viewport.start) / (this.viewport.span || 1) * this.width; }
  private selectionEdge(x: number, y: number): SelectionEdge | null {
    const selection = this.state.selection;
    if (!selection || y < 48 || y > this.height - 8) return null;
    const start = this.timeX(selection.start), end = this.timeX(selection.end);
    const startDistance = start >= 0 && start <= this.width ? Math.abs(x - start) : Infinity;
    const endDistance = end >= 0 && end <= this.width ? Math.abs(x - end) : Infinity;
    if (Math.min(startDistance, endDistance) > 10) return null;
    return startDistance <= endDistance ? 'start' : 'end';
  }
  private resizeSelection(pointer: TimelinePointer, x: number, dragging: boolean): void {
    const { edge, range } = pointer.resize!;
    // Keep the grab offset and opposite edge fixed, even when dragging past it.
    const target = range[edge] + (x - pointer.x) / this.width * this.viewport.span;
    const minimumSpan = Math.min(.001, range.end - range.start);
    const next = edge === 'start'
      ? { start: Math.max(0, Math.min(range.end - minimumSpan, target)), end: range.end }
      : { start: range.start, end: Math.min(this.state.duration, Math.max(range.start + minimumSpan, target)) };
    this.callbacks.select(next);
    this.callbacks.seek(next[edge], dragging);
  }
  private pointerDown(e: PointerEvent): void {
    if (!this.state.duration || e.button !== 0 || this.pointer) return;
    const bounds = this.canvas.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const time = this.xTime(x);
    const edge = this.selectionEdge(x, e.clientY - bounds.top);
    this.pointer = { id: e.pointerId, x, time, moved: false, ruler: e.clientY - bounds.top < 40, resize: edge ? { edge, range: { ...this.state.selection! } } : null };
    this.canvas.style.cursor = edge ? 'ew-resize' : '';
    this.canvas.setPointerCapture(e.pointerId);
    this.callbacks.seek(edge ? this.state.selection![edge] : time, true);
  }
  private pointerMove(e: PointerEvent): void {
    const pointer = this.pointer;
    const bounds = this.canvas.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    if (!pointer) { this.canvas.style.cursor = this.selectionEdge(x, e.clientY - bounds.top) ? 'ew-resize' : ''; return; }
    if (pointer.id !== e.pointerId) return;
    if (pointer.resize) {
      if (x !== pointer.x) pointer.moved = true;
      if (pointer.moved) this.resizeSelection(pointer, x, true);
      return;
    }
    if (Math.abs(x - pointer.x) > 4) pointer.moved = true;
    const time = this.xTime(x);
    if (pointer.moved && !pointer.ruler) this.callbacks.select({ start: Math.min(time, pointer.time), end: Math.max(time, pointer.time) });
    this.callbacks.seek(time, true);
  }
  private pointerUp(e: PointerEvent): void {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== e.pointerId) return;
    const bounds = this.canvas.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const time = this.xTime(x);
    this.pointer = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (pointer.resize) {
      if (pointer.moved) this.resizeSelection(pointer, x, false);
      else this.callbacks.seek(pointer.resize.range[pointer.resize.edge], false);
    } else {
      if (!pointer.moved && !pointer.ruler) {
        const segment = this.state.segments.find(s => time >= s.start && time < s.end);
        this.callbacks.select(segment ? { start: segment.start, end: segment.end } : null, segment?.id);
      }
      this.callbacks.seek(time, false);
    }
    this.canvas.style.cursor = this.selectionEdge(x, e.clientY - bounds.top) ? 'ew-resize' : '';
  }
  private invalidate(): void {
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => { this.drawPending = false; this.draw(); });
  }
  private draw(): void {
    const { ctx, width: w, height: h, state, colors } = this;
    if (!w || !h) return;
    ctx.fillStyle = colors.background; ctx.fillRect(0, 0, w, h);
    const top = 48, bottom = h - 8, trackHeight = bottom - top;
    ctx.fillStyle = colors.surface; ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(.5, top + .5, w - 1, trackHeight - 1, 5); ctx.fill(); ctx.stroke();
    ctx.font = '11px Consolas, monospace'; ctx.textBaseline = 'top';
    const desired = (this.viewport.span || 60) / Math.max(2, w / 110);
    const power = 10 ** Math.floor(Math.log10(desired));
    const tick = [1, 2, 5, 10].find(n => n * power >= desired)! * power;
    const minor = tick / 5;
    ctx.strokeStyle = colors.tick; ctx.fillStyle = colors.muted;
    for (let t = Math.ceil(this.viewport.start / minor) * minor; t <= this.viewport.start + (this.viewport.span || 60); t += minor) {
      const x = state.duration ? this.timeX(t) : t / 60 * w;
      const major = Math.abs(t / tick - Math.round(t / tick)) < .001;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 36); ctx.lineTo(Math.round(x) + .5, major ? 25 : 30); ctx.stroke();
      if (major && (state.duration || t === 0)) {
        const label = formatTime(t, tick < 1).replace(/^00:/, '');
        ctx.fillText(label, Math.min(w - ctx.measureText(label).width - 2, Math.max(2, x)), 8);
      }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(1, top + 1, w - 2, trackHeight - 2); ctx.clip();
    for (const s of state.segments) {
      if (!s.enabled || s.end < this.viewport.start || s.start > this.viewport.start + this.viewport.span) continue;
      const x = this.timeX(s.start), end = this.timeX(s.end);
      ctx.fillStyle = s.id === state.selectedId ? colors.clipSelected : colors.clip;
      ctx.fillRect(x + 1, top + 1, Math.max(1, end - x - 2), trackHeight - 2);
      ctx.fillStyle = colors.clipEdge; ctx.fillRect(x + 1, top + 1, Math.max(1, end - x - 2), 2);
      ctx.fillStyle = colors.clipLabel;
      if (end - x > 90) ctx.fillText(formatTime(s.end - s.start, false).replace(/^00:/, ''), Math.max(8, x + 12), top + 17);
    }
    if (state.selection) {
      const x = this.timeX(state.selection.start), end = this.timeX(state.selection.end);
      ctx.fillStyle = colors.selection; ctx.fillRect(x, top, end - x, trackHeight);
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.5; ctx.strokeRect(x + .75, top + .75, Math.max(1, end - x - 1.5), trackHeight - 1.5);
      ctx.fillStyle = colors.accent; ctx.fillRect(x, top + trackHeight / 2 - 8, 3, 16); ctx.fillRect(end - 3, top + trackHeight / 2 - 8, 3, 16);
    }
    ctx.restore();
    const px = Math.max(1, Math.min(w - 1, this.timeX(state.time)));
    if (state.time >= this.viewport.start && state.time <= this.viewport.start + this.viewport.span) {
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px + .5, 34); ctx.lineTo(px + .5, bottom); ctx.stroke();
      ctx.fillStyle = colors.accent; ctx.beginPath(); ctx.moveTo(px - 5, 25); ctx.lineTo(px + 5, 25); ctx.lineTo(px + 5, 32); ctx.lineTo(px, 37); ctx.lineTo(px - 5, 32); ctx.closePath(); ctx.fill();
    }
  }
}
