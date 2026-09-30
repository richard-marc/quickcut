import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditSession, formatTime, normalizeRange } from '../src/model.ts';

const ranges = (s: EditSession) => s.segments.map(({ start, end }) => [start, end]);
test('three deletes from a thirty minute source produce four retained clips', () => {
  const session = new EditSession(1800);
  session.remove({ start: 120, end: 180 });
  session.remove({ start: 600, end: 720 });
  session.remove({ start: 1400, end: 1440 });
  assert.deepEqual(ranges(session), [[0, 120], [180, 600], [720, 1400], [1440, 1800]]);
  assert.equal(session.outputDuration, 1580);
});
test('a deletion spanning split clips removes every intersecting portion', () => {
  const session = new EditSession(100);
  session.split(25); session.split(50); session.split(75);
  session.remove({ start: 20, end: 80 });
  assert.deepEqual(ranges(session), [[0, 20], [80, 100]]);
  session.undo(); assert.equal(session.segments.length, 4);
  session.redo(); assert.deepEqual(ranges(session), [[0, 20], [80, 100]]);
});
test('Keep replaces the original range then adds further retained ranges', () => {
  const session = new EditSession(100);
  session.keep({ start: 10, end: 20 }); session.keep({ start: 50, end: 60 });
  assert.deepEqual(ranges(session), [[10, 20], [50, 60]]);
  session.keep({ start: 15, end: 55 });
  assert.deepEqual(ranges(session), [[10, 60]]);
  session.undo(); assert.deepEqual(ranges(session), [[10, 20], [50, 60]]);
  session.undo(); session.undo(); assert.deepEqual(ranges(session), [[0, 100]]);
  assert.equal(session.state.keepMode, false);
});
test('new commands discard redo and snapshots do not mutate', () => {
  const session = new EditSession(100);
  session.split(40); session.undo(); session.remove({ start: 20, end: 30 });
  assert.equal(session.canRedo, false);
  session.undo(); assert.deepEqual(ranges(session), [[0, 100]]);
});
test('bounds, zero-length edits, removed playhead and complete deletion', () => {
  const session = new EditSession(10);
  assert.equal(session.split(0), false); assert.equal(session.split(10), false);
  assert.equal(session.remove({ start: 2, end: 2 }), false);
  session.remove({ start: 3, end: 6 }); assert.equal(session.split(4), false);
  session.remove({ start: -1, end: 20 }); assert.deepEqual(ranges(session), []);
  session.undo(); assert.deepEqual(ranges(session), [[0, 3], [6, 10]]);
  assert.deepEqual(normalizeRange({ start: 20, end: -2 }, 10), { start: 0, end: 10 });
  assert.throws(() => new EditSession(Infinity));
});
test('time display carries milliseconds and supports long files', () => {
  assert.equal(formatTime(59.9999), '00:01:00.000');
  assert.equal(formatTime(36000.123), '10:00:00.123');
});
