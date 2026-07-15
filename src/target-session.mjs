import { CdpClient } from './cdp-client.mjs';
import { stripPageActionMarker } from './page-action-channel.mjs';

export function settleTargetOperations(targets, operation) {
  return Promise.allSettled(targets.map(operation));
}

export async function installTargetOnce(target, {
  globalName,
  injectorVersion,
  injectorScript,
  payload,
  acknowledgedTitle = '',
}, connect = CdpClient.connect) {
  const client = await connect(target.webSocketDebuggerUrl);
  const globalReference = `window[${JSON.stringify(globalName)}]`;
  let injected = false;
  let mounted = false;
  try {
    const inspection = await client.evaluate(
      `({ version: ${globalReference}?.version || 0, mounted: Boolean(${globalReference}?.root?.isConnected && ${globalReference}?.footer?.isConnected) })`,
    );
    if (Number(inspection?.version || 0) !== injectorVersion) {
      await client.evaluate(injectorScript);
      injected = true;
      mounted = true;
    } else if (!inspection?.mounted) {
      mounted = await client.evaluate(`${globalReference}?.mount?.() === true`) === true;
    } else {
      mounted = true;
    }

    const signature = JSON.stringify(payload) ?? 'null';
    const updated = await client.evaluate(`${globalReference}?.update(${signature}) === true`);
    if (updated !== true) throw new Error('Codex 用量脚本尚未注入');

    if (acknowledgedTitle) {
      const cleanTitle = stripPageActionMarker(acknowledgedTitle);
      await client.evaluate(
        `if (document.title === ${JSON.stringify(acknowledgedTitle)}) document.title = ${JSON.stringify(cleanTitle)}; true`,
      );
    }
    return { injected, mounted };
  } finally {
    client.close();
  }
}
