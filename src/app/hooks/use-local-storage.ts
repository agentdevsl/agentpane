import { useCallback, useState } from 'react';
import { useMountEffect } from './use-mount-effect';

/**
 * Sync a value with localStorage. Reads stored value on mount,
 * writes to localStorage on every update.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  // Hydrate from localStorage on mount (avoids SSR mismatch)
  useMountEffect(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item !== null) {
        setStoredValue(JSON.parse(item) as T);
      }
    } catch (error) {
      console.warn(`[useLocalStorage] Failed to read key "${key}":`, error);
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;
        try {
          window.localStorage.setItem(key, JSON.stringify(nextValue));
        } catch (error) {
          console.warn(`[useLocalStorage] Failed to write key "${key}":`, error);
        }
        return nextValue;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}
