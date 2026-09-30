export interface Range { start: number; end: number }
export interface Segment extends Range { id: number; enabled: boolean }
export interface EditState { segments: Segment[]; keepMode: boolean }
interface EditCommand { name: string; before: EditState; after: EditState }

const EPSILON = 0.000001;
let nextId = 1;
const segment = (start: number, end: number): Segment => ({ id: nextId++, start, end, enabled: true });
const copy = (state: EditState): EditState => ({ keepMode: state.keepMode, segments: state.segments.map(s => ({ ...s })) });

export function normalizeRange(range: Range, duration: number): Range {
  return { start: Math.max(0, Math.min(duration, Math.min(range.start, range.end))), end: Math.max(0, Math.min(duration, Math.max(range.start, range.end))) };
}

export function removeRange(segments: Segment[], range: Range): Segment[] {
  return segments.flatMap(s => {
    if (range.end <= s.start || range.start >= s.end) return [{ ...s }];
    const result: Segment[] = [];
    if (range.start - s.start > EPSILON) result.push({ ...s, end: range.start });
    if (s.end - range.end > EPSILON) result.push(segment(range.end, s.end));
    return result;
  });
}

export function addRange(segments: Segment[], range: Range): Segment[] {
  const sorted = [...segments.map(s => ({ ...s })), segment(range.start, range.end)].sort((a, b) => a.start - b.start);
  const result: Segment[] = [];
  for (const s of sorted) {
    const last = result.at(-1);
    if (last && s.start <= last.end + EPSILON) last.end = Math.max(last.end, s.end);
    else result.push(s);
  }
  return result;
}

export class EditSession {
  readonly duration: number;
  state: EditState;
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  constructor(duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration must be positive.');
    this.duration = duration;
    this.state = { segments: [segment(0, duration)], keepMode: false };
  }
  get segments(): Segment[] { return this.state.segments; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get outputDuration(): number { return this.segments.filter(s => s.enabled).reduce((sum, s) => sum + s.end - s.start, 0); }

  private commit(name: string, after: EditState): boolean {
    if (JSON.stringify(this.state) === JSON.stringify(after)) return false;
    this.undoStack.push({ name, before: copy(this.state), after: copy(after) });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.state = after;
    return true;
  }
  remove(range: Range): boolean {
    const bounded = normalizeRange(range, this.duration);
    if (bounded.end - bounded.start <= EPSILON) return false;
    return this.commit('Remove range', { ...this.state, segments: removeRange(this.segments, bounded) });
  }
  keep(range: Range): boolean {
    const bounded = normalizeRange(range, this.duration);
    if (bounded.end - bounded.start <= EPSILON) return false;
    return this.commit('Keep range', { keepMode: true, segments: addRange(this.state.keepMode ? this.segments : [], bounded) });
  }
  split(time: number): boolean {
    const index = this.segments.findIndex(s => time > s.start + EPSILON && time < s.end - EPSILON);
    if (index < 0) return false;
    const original = this.segments[index];
    const segments = this.segments.map(s => ({ ...s }));
    segments.splice(index, 1, { ...original, end: time }, segment(time, original.end));
    return this.commit('Split clip', { ...this.state, segments });
  }
  undo(): string | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.redoStack.push(command);
    this.state = copy(command.before);
    return command.name;
  }
  redo(): string | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.undoStack.push(command);
    this.state = copy(command.after);
    return command.name;
  }
}

export function formatTime(seconds: number, milliseconds = true): string {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${p(hours)}:${p(minutes)}:${p(secs)}${milliseconds ? '.' + p(ms % 1000, 3) : ''}`;
}
