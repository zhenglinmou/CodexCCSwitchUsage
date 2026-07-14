import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

function loadSpec(code) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`"use strict"; (${code})`, {
    filename: 'ccswitch-usage-script.js',
  });
  return script.runInContext(context, { timeout: workerData.vmTimeoutMs });
}

let spec;
try {
  spec = loadSpec(workerData.code);
  if (!spec || typeof spec !== 'object') throw new Error('usage_script did not return an object');
  parentPort.postMessage({ type: 'ready', ok: true, value: spec.request });
} catch (error) {
  parentPort.postMessage({ type: 'ready', ok: false, error: error instanceof Error ? error.message : String(error) });
}

parentPort.on('message', message => {
  if (!spec || message.operation !== 'extract') return;
  try {
    if (typeof spec.extractor !== 'function') throw new Error('usage_script.extractor is missing');
    const value = spec.extractor(message.response);
    parentPort.postMessage({ id: message.id, ok: true, value: JSON.parse(JSON.stringify(value)) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
