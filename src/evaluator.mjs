import { Worker } from 'node:worker_threads';

function createWorker(code, timeoutMs) {
  return new Worker(new URL('./evaluator-worker.mjs', import.meta.url), {
    workerData: {
      code,
      vmTimeoutMs: Math.max(50, Math.min(timeoutMs, 2_000)),
    },
    resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 },
  });
}

export function createUsageEvaluator(code, timeoutMs = 2_000) {
  const worker = createWorker(code, timeoutMs);
  let closed = false;
  let sequence = 1;
  const pending = new Map();

  const close = error => {
    if (closed) return;
    closed = true;
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(error || new Error('usage_script evaluator closed'));
    }
    pending.clear();
    worker.terminate();
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('usage_script timed out'));
      close();
    }, timeoutMs);
    pending.set(0, { resolve, reject, timer });
  });

  worker.on('message', message => {
    const id = message.type === 'ready' ? 0 : message.id;
    const operation = pending.get(id);
    if (!operation) return;
    pending.delete(id);
    clearTimeout(operation.timer);
    message.ok ? operation.resolve(message.value) : operation.reject(new Error(message.error));
  });
  worker.once('error', error => close(error));
  worker.once('exit', codeValue => {
    if (!closed && codeValue !== 0) close(new Error(`usage_script evaluator exited with code ${codeValue}`));
  });

  return {
    ready,
    async extract(response, operationTimeoutMs = timeoutMs) {
      await ready;
      if (closed) throw new Error('usage_script evaluator closed');
      const id = sequence++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('usage_script timed out'));
          close();
        }, operationTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, operation: 'extract', response });
      });
    },
    close: () => close(),
  };
}

export async function evaluateRequest(code, timeoutMs = 2_000) {
  const evaluator = createUsageEvaluator(code, timeoutMs);
  try {
    return await evaluator.ready;
  } finally {
    evaluator.close();
  }
}

export async function evaluateExtractor(code, response, timeoutMs = 2_000) {
  const evaluator = createUsageEvaluator(code, timeoutMs);
  try {
    return await evaluator.extract(response, timeoutMs);
  } finally {
    evaluator.close();
  }
}
