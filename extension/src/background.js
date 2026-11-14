import { ext, MSG, PORT_NAME } from "./shared/protocol.js";
import { createAPI } from "./bg/api.js";
import { createLive } from "./bg/live.js";
import { trustedSender } from "./bg/request.js";
import { createShot } from "./bg/shot.js";

const live = createLive();
const handlers = { [MSG.API]: createAPI({ live }), [MSG.SHOT]: createShot({ live }) };
const trusted = (sender) => trustedSender(sender, ext.runtime.id);

// Register synchronously so MV3 can dispatch the event that starts the worker.
ext.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender)) return false;
  if (Object.hasOwn(handlers, message?.t)) {
    void handlers[message.t](message).then(respond).catch(() => {}); // A tab may close before its response.
    return true;
  }
  if (message?.t === MSG.STATE) respond({ state: live.getState() });
  return false;
});

ext.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_NAME && trusted(port.sender)) live.addPort(port);
  else port.disconnect();
});

async function toggle(tab) {
  try {
    if (!Number.isInteger(tab?.id)) [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (Number.isInteger(tab?.id)) await ext.tabs.sendMessage(tab.id, { t: MSG.TOGGLE });
  } catch { /* The active tab may not have the content script. */ }
}

ext.commands.onCommand.addListener((command) => {
  if (command === "toggle-pins") void toggle();
});
ext.action.onClicked.addListener((tab) => { void toggle(tab); });
