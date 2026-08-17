import { DdevEnv, type CloneEnv } from './ddev.js';
import { FlyEnv, flyConfigFromEnv } from './fly.js';

/** Factory over the clone-substrate implementations. */
export function cloneEnv(kind: 'ddev' | 'fly'): CloneEnv {
  return kind === 'fly' ? new FlyEnv(flyConfigFromEnv(process.env)) : new DdevEnv();
}
