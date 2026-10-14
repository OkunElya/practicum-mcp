// Read or replace the Monaco editor content on a trainer page.
// Usage: node editor.mjs get | node editor.mjs set "<code>"
import { withPage } from './lib.mjs';
const [cmd = 'get', code] = process.argv.slice(2);
const out = await withPage((page) =>
  page.evaluate((cmd, code) => {
    const models = window.monaco?.editor?.getModels?.() ?? [];
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (!models.length) return { error: 'no monaco model' };
    const m = models[0];
    // Go through the editor (pushEditOperations) when possible so undo/change events fire like typing.
    if (cmd === 'set') {
      const ed = editors.find((e) => e.getModel() === m);
      if (ed) {
        ed.executeEdits('probe', [{ range: m.getFullModelRange(), text: code }]);
        ed.pushUndoStop();
      } else m.setValue(code);
    }
    return { uri: String(m.uri), language: m.getLanguageId(), editors: editors.length, value: m.getValue() };
  }, cmd, code),
);
console.log(JSON.stringify(out, null, 1));
