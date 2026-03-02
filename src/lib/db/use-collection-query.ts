import { useLiveQuery } from '@tanstack/react-db';

/**
 * Typed wrapper for useLiveQuery that works around a type inference regression
 * in @tanstack/db v0.5.29 where Collection types are incompatible with
 * QueryBuilder.from()'s expected input type.
 *
 * Each call site specifies the expected element type via the generic parameter,
 * which is actually more explicit than the raw useLiveQuery inference.
 *
 * Remove this wrapper when upgrading to a TanStack DB version that fixes the
 * Collection ↔ CollectionImpl type mismatch.
 */
export function useCollectionQuery<T>(
  // biome-ignore lint/suspicious/noExplicitAny: TanStack DB v0.5.29 type regression
  queryFn: (q: any) => unknown,
  deps?: unknown[]
): { data: T[] | undefined } {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack DB v0.5.29 type regression
  return useLiveQuery(queryFn as any, deps as any) as { data: T[] | undefined };
}
