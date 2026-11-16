import type { Store } from '@a16n/pact-client';
import { createContext, useContext } from 'react';
import type { LiveCache } from './liveCache';
import type { PactSync } from './syncHooks';

type PactContextValue = { store: Store<any>; cache: LiveCache; sync: PactSync };

export const PactContext = createContext<PactContextValue | null>(null);

export function usePactContext(): PactContextValue {
  const value = useContext(PactContext);
  if (!value) throw new Error('Pact hooks must be used inside <PactProvider>');
  return value;
}
