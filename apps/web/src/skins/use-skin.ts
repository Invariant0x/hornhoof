import { useSyncExternalStore } from 'react';
import type { WorldKind } from './roles';
import { activeWorld, mapGrain, skinsState, subscribeSkins } from './store';

/* Reactive React views over the skin store, kept apart from store.ts so skins-boot.js stays free of React. */
export const useSkins = () => useSyncExternalStore(subscribeSkins, skinsState);
export const useWorld = (): WorldKind => useSyncExternalStore(subscribeSkins, activeWorld);
export const useMapGrain = (): boolean => useSyncExternalStore(subscribeSkins, mapGrain);
