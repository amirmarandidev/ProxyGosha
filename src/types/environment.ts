/**
 * Cloudflare Worker bindings consumed by the existing worker.js implementation.
 * All bindings are optional because the Worker intentionally serves a setup page
 * when it has not been configured yet.
 */
export interface DurableObjectStubLike { fetch(input: Request | string, init?: RequestInit): Promise<Response>; }
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface ProxyGoshaBindings {
  CONTROL_PLANE?: DurableObjectNamespaceLike;
  RATE_LIMIT_PER_MINUTE?: string;
  ADMIN_KEY?: string;
  SECRET?: string;
  AD_TAG?: string;
  HOSTNAME?: string;
  EXTRA_HOSTS?: string;
  DEBUG?: string;
  DECOY_URL?: string;
  MAX_STREAMS?: string;
  SESSION_PATH?: string;
  WS_PATH?: string;
  CARRIER?: string;
  GENERATOR_ENABLED?: string;
  GENERATOR_KEY?: string;
  ACCEPT_GENERATED?: string;
  /** Explicit local-only override used by the authenticated workerd TCP test harness. */
  E2E_TEST_MODE?: string;
  E2E_DC_HOST?: string;
  E2E_DC_PORT?: string;
  DC1?: string;
  DC2?: string;
  DC3?: string;
  DC4?: string;
  DC5?: string;
  DC203?: string;
  DC_PORTS?: string;
}
