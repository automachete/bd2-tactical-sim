export const snapshotClone = <T>(value: T): T => {
  const snapshot: unknown = $state.snapshot(value);
  return structuredClone(snapshot) as T;
};
