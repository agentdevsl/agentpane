/**
 * @deprecated AR-018: This module is deprecated. Import from '../../server/shared.js' instead.
 * These types and helpers have been consolidated into src/server/shared.ts as the
 * canonical location for API response utilities.
 *
 * This file re-exports from shared.ts for backward compatibility.
 */

export type { ApiFailure, ApiResponse, ApiSuccess } from '../../server/shared.js';
export { failure, success } from '../../server/shared.js';
