// ABOUTME: Memoized dynamic importer for the Grok ACP runtime façade.
// ABOUTME: Shares one in-flight load, retries after rejection, and wraps load failures clearly.

export type GrokAcpRuntimeModule = {
  runSingleAgentGrokAcp: typeof import('./grok-acp-runtime.ts').runSingleAgentGrokAcp;
  createGrokAcpInteractiveTransport: typeof import('./grok-acp-runtime.ts').createGrokAcpInteractiveTransport;
};

export type GrokAcpRuntimeImporter = () => Promise<GrokAcpRuntimeModule>;

function wrapLoadFailure(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Grok ACP runtime failed to load: ${detail}`);
  if (cause instanceof Error && cause.stack) {
    error.cause = cause;
  }
  return error;
}

/**
 * Build a concurrency-safe loader that caches one in-flight/resolved promise and
 * resets after rejection so a later call can retry.
 */
export function createGrokAcpRuntimeLoader(
  importer: GrokAcpRuntimeImporter
): () => Promise<GrokAcpRuntimeModule> {
  let cached: Promise<GrokAcpRuntimeModule> | undefined;

  return async function loadGrokAcpRuntime(): Promise<GrokAcpRuntimeModule> {
    if (!cached) {
      cached = importer()
        .then((mod) => {
          if (
            typeof mod?.runSingleAgentGrokAcp !== 'function' ||
            typeof mod?.createGrokAcpInteractiveTransport !== 'function'
          ) {
            throw new Error('Grok ACP runtime module is missing required exports');
          }
          return mod;
        })
        .catch((err) => {
          cached = undefined;
          throw wrapLoadFailure(err);
        });
    }
    return cached;
  };
}

/** Production loader bound to the lazy Grok ACP runtime façade. */
export const loadGrokAcpRuntime = createGrokAcpRuntimeLoader(
  () => import('./grok-acp-runtime.ts') as Promise<GrokAcpRuntimeModule>
);
