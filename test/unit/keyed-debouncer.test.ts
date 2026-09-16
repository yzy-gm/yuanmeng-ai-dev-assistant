import { describe, expect, it, vi } from 'vitest';

import { KeyedDebouncer } from '../../src/core/async/keyed-debouncer.js';

describe('keyed debouncer', () => {
  it('coalesces repeated document refreshes and cancels pending work on dispose', () => {
    vi.useFakeTimers();
    try {
      const debouncer = new KeyedDebouncer();
      const run = vi.fn();
      debouncer.schedule('file.lua', run, 250);
      debouncer.schedule('file.lua', run, 250);
      vi.advanceTimersByTime(249);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
      debouncer.schedule('file.lua', run, 250);
      debouncer.dispose();
      vi.advanceTimersByTime(250);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
