interface PendingResolver<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * 最小 async iterable 队列。
 * @remarks
 * provider run 事实流由宿主 raw event 驱动，这里只负责把异步 push
 * 变成 SDK 可消费的 `AsyncIterable`。
 */
export class AsyncIterableQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: PendingResolver<T>[] = [];
  private closed = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          const value = this.items.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
