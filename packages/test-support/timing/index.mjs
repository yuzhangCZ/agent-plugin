export async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(condition, timeout = 5000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true;
    }
    await wait(interval);
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}
