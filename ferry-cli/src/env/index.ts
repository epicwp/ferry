import { DdevEnv, type CloneEnv } from './ddev.js';

/** Factory over the clone-substrate implementations. The 'fly' branch lands with FlyEnv. */
export function cloneEnv(kind: 'ddev' | 'fly'): CloneEnv {
  if (kind === 'fly') throw new Error('FlyEnv arrives in a later task');
  return new DdevEnv();
}
