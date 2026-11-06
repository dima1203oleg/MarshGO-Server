export interface PgClientErrorSource {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface PgPoolConnectSource {
  on(event: 'connect', listener: (client: PgClientErrorSource) => void): unknown;
}

/**
 * pg-pool only handles client errors itself while a client is idle in the pool.
 * Attach one listener when each physical connection is created so a connection
 * loss while that client is checked out cannot become an unhandled EventEmitter
 * error and terminate the API process.
 */
export function observePgPoolClientErrors(
  pool: PgPoolConnectSource,
  log: (event: Readonly<{ level: 'error'; event: 'database.client_error'; name: string }>) => void = (entry) => {
    console.error(JSON.stringify(entry));
  },
): void {
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      // Avoid logging database URLs, query text, or provider/user data.
      log({ level: 'error', event: 'database.client_error', name: error.name });
    });
  });
}
