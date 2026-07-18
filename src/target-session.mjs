import { CdpClient } from './cdp-client.mjs';
import { stripPageActionMarker } from './page-action-channel.mjs';

export function settleTargetOperations(targets, operation) {
  return Promise.allSettled(targets.map(operation));
}

export async function acknowledgePageAction(target, acknowledgedTitle, connect = CdpClient.connect) {
  if (!acknowledgedTitle) return false;
  const client = await connect(target.webSocketDebuggerUrl);
  const cleanTitle = stripPageActionMarker(acknowledgedTitle);
  try {
    return await client.evaluate(
      `(() => { if (document.title !== ${JSON.stringify(acknowledgedTitle)}) return false; document.title = ${JSON.stringify(cleanTitle)}; return true; })()`,
    ) === true;
  } finally {
    client.close();
  }
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
      mounted = await client.evaluate(injectorScript) === true;
      injected = true;
    } else if (!inspection?.mounted) {
      mounted = await client.evaluate(`${globalReference}?.mount?.() === true`) === true;
    } else {
      mounted = true;
    }

    const signature = JSON.stringify(payload) ?? 'null';
    const updated = await client.evaluate(`${globalReference}?.update(${signature}) === true`);
    if (updated !== true) throw new Error('Codex 用量脚本尚未注入');
    if (!mounted) mounted = await client.evaluate(`${globalReference}?.mount?.() === true`) === true;
    if (!mounted) {
      const editorSelector = '.ProseMirror[contenteditable="true"],[contenteditable="true"].ProseMirror,[contenteditable="true"][role="textbox"],[contenteditable="true"][data-lexical-editor="true"]';
      const hasVisibleComposer = await client.evaluate(
        `Array.from(document.querySelectorAll(${JSON.stringify(editorSelector)})).some(element => { const rect = element.getBoundingClientRect(); return element.isConnected && rect.width > 0 && rect.height > 0; })`,
      ) === true;
      if (hasVisibleComposer) throw new Error('Codex 用量界面找不到可挂载的输入框页脚');
    }

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
