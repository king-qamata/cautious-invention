export function createSingleFlight(asyncFn, options = {}) {
  const { keyResolver } = options;
  const pendingByKey = new Map();

  return async function singleFlightInvoker(...args) {
    const key = keyResolver ? keyResolver(args) : '__default__';
    if (pendingByKey.has(key)) {
      return pendingByKey.get(key);
    }

    const pending = Promise.resolve()
      .then(() => asyncFn(...args))
      .finally(() => {
        pendingByKey.delete(key);
      });

    pendingByKey.set(key, pending);
    return pending;
  };
}
