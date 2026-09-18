interface ShutdownResources {
  stop(force?: boolean): Promise<void>;
  idle(): Promise<unknown>;
  close(): void | Promise<void>;
}

/** Keep the database available until requests and jobs drain, with one overall deadline. */
export async function drainServer(resources: ShutdownResources, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await Promise.all([resources.stop(), resources.idle()]);
        await resources.close();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`BunBase: shutdown exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    // Do not wait for stuck work or close its database underneath it. The signal
    // handler exits nonzero after terminating remaining network connections.
    void resources.stop(true).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
