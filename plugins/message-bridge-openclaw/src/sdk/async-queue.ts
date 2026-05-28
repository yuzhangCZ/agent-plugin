export interface AsyncQueueController<T> {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
}

export function createAsyncQueue<T>(): AsyncQueueController<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  let closed = false;
  let failure: unknown;

  const flush = () => {
    while (waiters.length > 0 && values.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      waiter.resolve({ value: values.shift() as T, done: false });
    }

    if (failure !== undefined) {
      while (waiters.length > 0) {
        waiters.shift()?.reject(failure);
      }
      return;
    }

    if (closed) {
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (values.length > 0) {
              return Promise.resolve({ value: values.shift() as T, done: false });
            }
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T>>((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
        };
      },
    },
    push(value: T) {
      if (closed || failure !== undefined) {
        return;
      }
      values.push(value);
      flush();
    },
    close() {
      if (failure !== undefined) {
        return;
      }
      closed = true;
      flush();
    },
    fail(error: unknown) {
      if (closed || failure !== undefined) {
        return;
      }
      failure = error;
      flush();
    },
  };
}
