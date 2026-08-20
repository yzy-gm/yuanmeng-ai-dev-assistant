export type EvidenceLevel =
  | 'STATIC_LOCAL'
  | 'UNIT_E2E'
  | 'EXTENSION_HOST'
  | 'OFFICIAL_EDITOR_SINGLE'
  | 'OFFICIAL_EDITOR_MULTI'
  | 'USER_ATTESTED';

export type ErrorCode =
  | 'OK'
  | 'OFFLINE'
  | 'STALE'
  | 'AMBIGUOUS'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'USAGE_ERROR'
  | 'INTERNAL_ERROR'
  | 'ATOMIC_WRITE_FAILED'
  | 'UNSAFE_LUA_NODE'
  | 'LUA_LIMIT_EXCEEDED'
  | 'DUPLICATE_LUA_KEY'
  | 'NON_FINITE_NUMBER'
  | 'INVALID_LUA_SYNTAX'
  | 'INVALID_UTF8'
  | 'OFFICIAL_SCHEMA_UNVERIFIED'
  | 'UNSUPPORTED_UI_SCHEMA'
  | 'DUPLICATE_UI_ID'
  | 'OFFICIAL_COMMAND_MISSING'
  | 'EXPORT_TIMEOUT'
  | 'SOURCE_NOT_STABLE'
  | 'API_NOT_FOUND'
  | 'PLAYER_ROUTING_UNCONFIRMED'
  | 'GENERATED_FILE_PROTECTED'
  | 'CONFIRMATION_REQUIRED'
  | 'HASH_CONFLICT';

export interface ProductError extends Error {
  readonly code: ErrorCode;
  readonly nextActions: readonly string[];
  readonly evidence: EvidenceLevel;
  readonly cause?: unknown;
}

export interface ProductErrorConstructor {
  new (
    code: ErrorCode,
    message: string,
    nextActions: readonly string[],
    evidence: EvidenceLevel,
    cause?: unknown,
  ): ProductError;
}

export const ProductError: ProductErrorConstructor = class ProductErrorImplementation extends Error {
  readonly code: ErrorCode;
  readonly nextActions: readonly string[];
  readonly evidence: EvidenceLevel;

  constructor(
    code: ErrorCode,
    message: string,
    nextActions: readonly string[],
    evidence: EvidenceLevel,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProductError';
    this.code = code;
    this.nextActions = nextActions;
    this.evidence = evidence;
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
};
