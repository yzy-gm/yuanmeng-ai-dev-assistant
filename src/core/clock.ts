export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  readonly #epochMilliseconds: number;

  constructor(instant: string | Date) {
    const epochMilliseconds = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
    if (!Number.isFinite(epochMilliseconds)) {
      throw new RangeError('FixedClock requires a valid instant.');
    }
    this.#epochMilliseconds = epochMilliseconds;
  }

  now(): Date {
    return new Date(this.#epochMilliseconds);
  }
}
