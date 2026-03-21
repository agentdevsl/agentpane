/**
 * Type-safe mock builder infrastructure for Drizzle database mocking
 *
 * This module provides the core types and utilities for creating type-safe mocks
 * that match the Drizzle ORM API surface. Eliminates the need for `as never` in tests.
 *
 * @module tests/mocks/mock-builders
 */

import { type Mock, vi } from 'vitest';

// =============================================================================
// Re-exports
// =============================================================================

/**
 * Re-export vitest's vi for convenience
 */
export { vi };

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Wrapper type for vitest mock functions with proper typing
 */
export type MockFn<T extends (...args: any[]) => any> = Mock<Parameters<T>, ReturnType<T>>;

/**
 * Deep partial type - makes all properties and nested properties optional
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// =============================================================================
// Drizzle Query Builder Mock Types
// =============================================================================

/**
 * Mock type for Drizzle's insert().values() chain
 */
export interface MockInsertChain<TSelect = any> {
  values: MockFn<(values: any | any[]) => MockInsertReturning<TSelect>>;
}

/**
 * Mock type for Drizzle's insert().values().returning() chain
 */
export interface MockInsertReturning<TSelect = any> {
  returning: MockFn<() => Promise<TSelect[]>>;
  onConflictDoUpdate: MockFn<(config: any) => MockInsertReturning<TSelect>>;
}

/**
 * Mock type for Drizzle's update().set() chain
 */
export interface MockUpdateChain<TSelect = any> {
  set: MockFn<(values: any) => MockUpdateWhere<TSelect>>;
}

/**
 * Mock type for Drizzle's update().set().where() chain
 */
export interface MockUpdateWhere<TSelect = any> {
  where: MockFn<(condition: any) => MockUpdateReturning<TSelect>>;
  run: MockFn<() => Promise<void>>;
}

/**
 * Mock type for Drizzle's update().set().where().returning() chain
 */
export interface MockUpdateReturning<TSelect = any> {
  returning: MockFn<() => Promise<TSelect[]>>;
  run: MockFn<() => Promise<void>>;
}

/**
 * Mock type for Drizzle's delete().where() chain
 */
export interface MockDeleteChain {
  where: MockFn<(condition: any) => MockDeleteWhere>;
}

/**
 * Mock type for Drizzle's delete().where() final chain
 */
export interface MockDeleteWhere {
  run: MockFn<() => Promise<void>>;
}

/**
 * Mock type for Drizzle's select().from() chain
 */
export interface MockSelectChain<TSelect = any> {
  from: MockFn<(table: any) => MockSelectWhere<TSelect>>;
}

/**
 * Mock type for Drizzle's select().from().where() chain
 */
export interface MockSelectWhere<TSelect = any> {
  where: MockFn<(condition: any) => MockSelectAll<TSelect>>;
}

/**
 * Mock type for Drizzle's select().from().where().all() chain
 */
export interface MockSelectAll<TSelect = any> {
  all: MockFn<() => Promise<TSelect[]>>;
}

/**
 * Mock type for Drizzle's query API for a single table
 */
export interface MockTableQuery<TSelect = any> {
  findFirst: MockFn<(options?: any) => Promise<TSelect | undefined>>;
  findMany: MockFn<(options?: any) => Promise<TSelect[]>>;
}

// =============================================================================
// Mock Database Type
// =============================================================================

/**
 * Type-safe mock database matching Drizzle's BetterSQLite3Database API
 *
 * Provides mocked versions of:
 * - query.{table}.findFirst/findMany
 * - insert(table).values().returning()
 * - update(table).set().where().returning()
 * - delete(table).where()
 * - select().from().where().all()
 * - transaction()
 */
export interface MockDatabase {
  // Query API for all tables
  query: {
    codespaces: MockTableQuery;
    agents: MockTableQuery;
    tasks: MockTableQuery;
    sessions: MockTableQuery;
    worktrees: MockTableQuery;
    agentRuns: MockTableQuery;
    sessionEvents: MockTableQuery;
    sessionSummaries: MockTableQuery;
    sandboxConfigs: MockTableQuery;
    sandboxInstances: MockTableQuery;
    apiKeys: MockTableQuery;
    githubTokens: MockTableQuery;
    githubInstallations: MockTableQuery;
    repositoryConfigs: MockTableQuery;
    settings: MockTableQuery;
    auditLogs: MockTableQuery;
    planSessions: MockTableQuery;
    templates: MockTableQuery;
    marketplaces: MockTableQuery;
    workflows: MockTableQuery;
  };

  // Insert API
  insert: MockFn<(table: any) => MockInsertChain>;

  // Update API
  update: MockFn<(table: any) => MockUpdateChain>;

  // Delete API
  delete: MockFn<(table: any) => MockDeleteChain>;

  // Select API
  select: MockFn<(fields?: any) => MockSelectChain>;

  // Transaction API
  transaction: MockFn<<T>(callback: (tx: MockDatabase) => Promise<T>) => Promise<T>>;
}

// =============================================================================
// Chainable Builder Utilities
// =============================================================================

/**
 * Creates a chainable mock for Drizzle's insert API
 *
 * @example
 * const insertChain = createInsertChain([mockRecord]);
 * await insertChain.values(data).returning(); // returns [mockRecord]
 */
export function createInsertChain<TSelect = any>(
  returnValue: TSelect[] = []
): MockInsertChain<TSelect> {
  const returningMock = vi.fn().mockResolvedValue(returnValue);
  const onConflictDoUpdateMock = vi.fn();

  const returning: MockInsertReturning<TSelect> = {
    returning: returningMock,
    onConflictDoUpdate: onConflictDoUpdateMock,
  };

  // onConflictDoUpdate returns a new returning chain
  onConflictDoUpdateMock.mockReturnValue({
    returning: vi.fn().mockResolvedValue(returnValue),
  });

  const valuesMock = vi.fn().mockReturnValue(returning);

  return {
    values: valuesMock,
  };
}

/**
 * Creates a chainable mock for Drizzle's update API
 *
 * @example
 * const updateChain = createUpdateChain([updatedRecord]);
 * await updateChain.set(data).where(condition).returning(); // returns [updatedRecord]
 */
export function createUpdateChain<TSelect = any>(
  returnValue: TSelect[] = []
): MockUpdateChain<TSelect> {
  const returningMock = vi.fn().mockResolvedValue(returnValue);
  const runMock = vi.fn().mockResolvedValue(undefined);

  const whereReturn: MockUpdateReturning<TSelect> = {
    returning: returningMock,
    run: runMock,
  };

  const whereMock = vi.fn().mockReturnValue(whereReturn);

  const setReturn: MockUpdateWhere<TSelect> = {
    where: whereMock,
    run: runMock,
  };

  const setMock = vi.fn().mockReturnValue(setReturn);

  return {
    set: setMock,
  };
}

/**
 * Creates a chainable mock for Drizzle's delete API
 *
 * @example
 * const deleteChain = createDeleteChain();
 * await deleteChain.where(condition).run(); // resolves to void
 */
export function createDeleteChain(): MockDeleteChain {
  const runMock = vi.fn().mockResolvedValue(undefined);

  const whereReturn: MockDeleteWhere = {
    run: runMock,
  };

  const whereMock = vi.fn().mockReturnValue(whereReturn);

  return {
    where: whereMock,
  };
}

/**
 * Creates a chainable mock for Drizzle's select API
 *
 * @example
 * const selectChain = createSelectChain([record1, record2]);
 * await selectChain.from(table).where(condition).all(); // returns [record1, record2]
 */
export function createSelectChain<TSelect = any>(
  returnValue: TSelect[] = []
): MockSelectChain<TSelect> {
  const allMock = vi.fn().mockResolvedValue(returnValue);

  const whereReturn: MockSelectAll<TSelect> = {
    all: allMock,
  };

  const whereMock = vi.fn().mockReturnValue(whereReturn);

  const fromReturn: MockSelectWhere<TSelect> = {
    where: whereMock,
  };

  const fromMock = vi.fn().mockReturnValue(fromReturn);

  return {
    from: fromMock,
  };
}

/**
 * Creates a mock table query API (findFirst/findMany)
 *
 * @example
 * const projectsQuery = createTableQuery([project1, project2]);
 * await projectsQuery.findFirst(); // returns project1
 * await projectsQuery.findMany(); // returns [project1, project2]
 */
export function createTableQuery<TSelect = any>(records: TSelect[] = []): MockTableQuery<TSelect> {
  return {
    findFirst: vi.fn().mockResolvedValue(records[0]),
    findMany: vi.fn().mockResolvedValue(records),
  };
}

// =============================================================================
// Mock Database Factory
// =============================================================================

/**
 * Creates a type-safe mock database with all tables initialized
 *
 * Each table has empty mock query APIs by default. Override specific tables
 * using the partial overrides parameter.
 *
 * @param overrides - Partial overrides for specific tables or methods
 * @returns Fully-typed mock database
 *
 * @example
 * ```typescript
 * const mockDb = createMockDatabase({
 *   query: {
 *     codespaces: createTableQuery([project1, project2]),
 *   },
 * });
 *
 * // Type-safe usage
 * const project = await mockDb.query.codespaces.findFirst();
 * ```
 */
export function createMockDatabase(overrides: DeepPartial<MockDatabase> = {}): MockDatabase {
  // Create default insert/update/delete/select chains
  const insertMock = vi.fn().mockReturnValue(createInsertChain());
  const updateMock = vi.fn().mockReturnValue(createUpdateChain());
  const deleteMock = vi.fn().mockReturnValue(createDeleteChain());
  const selectMock = vi.fn().mockReturnValue(createSelectChain());

  // Transaction implementation - executes callback with the mock db
  const transactionMock = vi.fn().mockImplementation(async (callback) => {
    return callback(mockDb);
  });

  // Build the mock database
  const mockDb: MockDatabase = {
    query: {
      codespaces: overrides.query?.codespaces ?? createTableQuery(),
      agents: overrides.query?.agents ?? createTableQuery(),
      tasks: overrides.query?.tasks ?? createTableQuery(),
      sessions: overrides.query?.sessions ?? createTableQuery(),
      worktrees: overrides.query?.worktrees ?? createTableQuery(),
      agentRuns: overrides.query?.agentRuns ?? createTableQuery(),
      sessionEvents: overrides.query?.sessionEvents ?? createTableQuery(),
      sessionSummaries: overrides.query?.sessionSummaries ?? createTableQuery(),
      sandboxConfigs: overrides.query?.sandboxConfigs ?? createTableQuery(),
      sandboxInstances: overrides.query?.sandboxInstances ?? createTableQuery(),
      apiKeys: overrides.query?.apiKeys ?? createTableQuery(),
      githubTokens: overrides.query?.githubTokens ?? createTableQuery(),
      githubInstallations: overrides.query?.githubInstallations ?? createTableQuery(),
      repositoryConfigs: overrides.query?.repositoryConfigs ?? createTableQuery(),
      settings: overrides.query?.settings ?? createTableQuery(),
      auditLogs: overrides.query?.auditLogs ?? createTableQuery(),
      planSessions: overrides.query?.planSessions ?? createTableQuery(),
      templates: overrides.query?.templates ?? createTableQuery(),
      marketplaces: overrides.query?.marketplaces ?? createTableQuery(),
      workflows: overrides.query?.workflows ?? createTableQuery(),
    },
    insert: overrides.insert ?? insertMock,
    update: overrides.update ?? updateMock,
    delete: overrides.delete ?? deleteMock,
    select: overrides.select ?? selectMock,
    transaction: overrides.transaction ?? transactionMock,
  };

  return mockDb;
}
