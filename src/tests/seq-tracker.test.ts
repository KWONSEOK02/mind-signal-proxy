import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeqTracker, SeqClassification } from '../services/seq-tracker';

describe('SeqTracker', () => {
  let tracker: SeqTracker;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tracker = new SeqTracker();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('classifies first seq as in-order and does not warn', () => {
    const result = tracker.track(0, 1);
    expect(result).toBe(SeqClassification.InOrder);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('classifies consecutive seqs as in-order and does not warn', () => {
    tracker.track(0, 1);
    const result = tracker.track(0, 2);
    expect(result).toBe(SeqClassification.InOrder);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('classifies out-of-order (seq goes backward) and emits WARN', () => {
    tracker.track(0, 5);
    const result = tracker.track(0, 3);
    expect(result).toBe(SeqClassification.OutOfOrder);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0] as [string];
    expect(msg).toContain('subject_idx=0');
    expect(msg).toContain('expected=6');
    expect(msg).toContain('got=3');
  });

  it('classifies duplicate (same seq) as out-of-order and emits WARN', () => {
    tracker.track(0, 7);
    const result = tracker.track(0, 7);
    expect(result).toBe(SeqClassification.OutOfOrder);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('classifies gap (seq skips more than 1) and emits WARN', () => {
    tracker.track(0, 1);
    const result = tracker.track(0, 5);
    expect(result).toBe(SeqClassification.Gap);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0] as [string];
    expect(msg).toContain('subject_idx=0');
    expect(msg).toContain('expected=2');
    expect(msg).toContain('got=5');
  });

  it('tracks different subject_idx independently', () => {
    tracker.track(0, 1);
    tracker.track(0, 2);
    // subject 1 starts fresh
    const result = tracker.track(1, 1);
    expect(result).toBe(SeqClassification.InOrder);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
