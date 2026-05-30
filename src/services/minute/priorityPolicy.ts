export interface PriorityPolicyOptions {
  targetDeltaPerSample: number;
  targetDeltaLower: number;
  targetDeltaUpper: number;
  minPositivePriority: number;
  maxPositivePriority: number;
}

export function getEffectiveTargetDelta(options: {
  targetDeltaPerSample: number;
  targetDeltaLower: number;
  targetDeltaUpper: number;
}): number {
  return Math.min(
    Math.max(options.targetDeltaPerSample, options.targetDeltaLower),
    options.targetDeltaUpper,
  );
}

export function calculateMinutePriority(
  dailyDeltaPerDay: number,
  options: PriorityPolicyOptions,
): number {
  if (dailyDeltaPerDay <= 0) return 0;

  const effectiveTarget = getEffectiveTargetDelta(options);
  const calculated = Math.round((effectiveTarget * 1440) / dailyDeltaPerDay);
  return Math.min(
    Math.max(calculated, options.minPositivePriority),
    options.maxPositivePriority,
  );
}
