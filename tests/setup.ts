import 'fake-indexeddb/auto';
import { vi } from 'vitest';

const localStore: Record<string, unknown> = {};
const syncStore: Record<string, unknown> = {};

vi.mock('webextension-polyfill', () => {
  return {
    default: {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (!keys) return { ...localStore };
            if (typeof keys === 'string') return { [keys]: localStore[keys] };
            const res: Record<string, unknown> = {};
            for (const k of keys) res[k] = localStore[k];
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
          clear: vi.fn(async () => {
            for (const k of Object.keys(localStore)) delete localStore[k];
          }),
        },
        sync: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (!keys) return { ...syncStore };
            if (typeof keys === 'string') return { [keys]: syncStore[keys] };
            const res: Record<string, unknown> = {};
            for (const k of keys) res[k] = syncStore[k];
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(syncStore, items);
          }),
          clear: vi.fn(async () => {
            for (const k of Object.keys(syncStore)) delete syncStore[k];
          }),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => undefined),
        onMessage: {
          addListener: vi.fn(),
        },
      },
    },
  };
});
