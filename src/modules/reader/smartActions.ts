import { config } from "../../../package.json";
import { getLocaleID, getString } from "../../utils/locale";
import { buildPrompt, type SlashCommand } from "../context/builder";
import { streamChat } from "../llm/service";

type ActionType = "explain" | "summarize" | "translate" | "note";

const actionEmoji: Record<ActionType, string> = {
  explain: "💡",
  summarize: "📋",
  translate: "🌐",
  note: "📝",
};

const contextMenuActionMap: Record<string, SlashCommand> = {
  explain: "explain",
  summarize: "summarize",
  note: "note",
};

function escapeHTML(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setLastSelection(text: string, item: Zotero.Item) {
  addon.data.lastSelectionText = text;
  addon.data.lastSelectionItemID = item.id;
  addon.data.lastSelectionTimestamp = Date.now();
}

function getParentItem(reader: _ZoteroTypes.ReaderInstance): Zotero.Item {
  return reader._item.parentItem || reader._item;
}

function collectAnnotationText(
  reader: _ZoteroTypes.ReaderInstance,
  ids: string[],
) {
  const attachment = reader._item;
  const annotations = attachment.getAnnotations(false);
  const rows: string[] = [];
  for (const id of ids) {
    const annotation = annotations.find(
      (x: Zotero.Item) => x.key === id || x.id === Number(id),
    );
    if (!annotation) {
      continue;
    }
    const text = annotation.annotationText?.trim();
    const comment = annotation.annotationComment?.trim();
    if (text) {
      rows.push(text);
    }
    if (comment) {
      rows.push(`Note: ${comment}`);
    }
  }
  return rows.join("\n\n").trim();
}

function addController(controller: { abort: () => void }) {
  addon.data.activeAbortControllers.add(controller);
}

function removeController(controller: { abort: () => void }) {
  addon.data.activeAbortControllers.delete(controller);
}

function renderNoteHTML(
  action: SlashCommand,
  selectedText: string,
  responseText: string,
) {
  const escapedAction = escapeHTML(action);
  const escapedSelection = escapeHTML(selectedText).replace(/\n/g, "<br/>");
  const escapedResponse = escapeHTML(responseText).replace(/\n/g, "<br/>");
  return `<div class="zotero-note znv1"><h2>AI: ${escapedAction}</h2><blockquote><p>${escapedSelection}</p></blockquote><hr/><p>${escapedResponse}</p></div>`;
}

async function saveChildNote(
  parentItem: Zotero.Item,
  action: SlashCommand,
  selectedText: string,
  responseText: string,
) {
  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentItem.id;
  note.setNote(renderNoteHTML(action, selectedText, responseText));
  await note.saveTx();
}

function copyToClipboard(text: string) {
  new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
}

function runSelectionAction(options: {
  action: SlashCommand;
  selectedText: string;
  parentItem: Zotero.Item;
  onChunk: (text: string) => void;
  onDone: (text: string) => void;
  onError: (error: Error) => void;
}) {
  const messages = buildPrompt(
    options.action,
    options.selectedText,
    options.parentItem,
  );
  const controller = streamChat(messages, {
    onChunk: (text) => {
      options.onChunk(text);
    },
    onDone: (text) => {
      removeController(controller);
      addon.data.lastSelectionAction = options.action;
      addon.data.lastSelectionResponse = text;
      options.onDone(text);
    },
    onError: (error) => {
      removeController(controller);
      options.onError(error);
    },
  });
  addController(controller);
}

function createButton(doc: Document, label: string) {
  const button = doc.createElement("button");
  button.textContent = label;
  button.style.cssText =
    "padding:4px 8px;border:1px solid #c8ccd1;background:#ffffff;border-radius:6px;cursor:pointer;font-size:12px;";
  return button;
}

function createPopupContainer(
  doc: Document,
  reader: _ZoteroTypes.ReaderInstance,
  selectedText: string,
) {
  const parentItem = getParentItem(reader);
  setLastSelection(selectedText, parentItem);

  const container = doc.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;gap:8px;min-width:280px;max-width:420px;padding:8px;border-top:1px solid #e5e7eb;";

  const actionRow = doc.createElement("div");
  actionRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

  const result = doc.createElement("div");
  result.style.cssText =
    "display:none;white-space:pre-wrap;line-height:1.45;border:1px solid #d6d9df;border-radius:6px;padding:8px;background:#fff;font-size:12px;max-height:220px;overflow:auto;";

  const toolRow = doc.createElement("div");
  toolRow.style.cssText = "display:none;gap:6px;";

  let latestResponse = "";

  const copyButton = createButton(doc, `📋 ${getString("copy")}`);
  const insertButton = createButton(doc, `📝 ${getString("insert-note")}`);

  copyButton.addEventListener("click", () => {
    if (latestResponse) {
      copyToClipboard(latestResponse);
    }
  });

  insertButton.addEventListener("click", async () => {
    if (!latestResponse) {
      return;
    }
    try {
      await saveChildNote(parentItem, "note", selectedText, latestResponse);
    } catch (error) {
      result.textContent = `${getString("error-note-save")}: ${(error as Error).message}`;
    }
  });

  toolRow.append(copyButton, insertButton);

  const actions: ActionType[] = ["explain", "summarize", "translate", "note"];
  for (const action of actions) {
    const key = `smart-action-${action}` as const;
    const button = createButton(
      doc,
      `${actionEmoji[action]} ${getString(key as any)}`,
    );
    button.addEventListener("click", () => {
      result.style.display = "block";
      toolRow.style.display = "none";
      result.textContent = getString("thinking");
      runSelectionAction({
        action,
        selectedText,
        parentItem,
        onChunk: (text) => {
          latestResponse = text;
          result.textContent = text;
        },
        onDone: (text) => {
          latestResponse = text;
          result.textContent = text;
          toolRow.style.display = "flex";
        },
        onError: (error) => {
          result.textContent = `${getString("error-api")}: ${error.message}`;
        },
      });
    });
    actionRow.appendChild(button);
  }

  container.append(actionRow, result, toolRow);
  return container;
}

function handleSelectionPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const { reader, doc, params, append } = event;
  const selectedText = params.annotation?.text?.trim();
  if (!selectedText) {
    return;
  }
  const container = createPopupContainer(doc, reader, selectedText);
  append(container);
}

function runContextMenuAction(
  reader: _ZoteroTypes.ReaderInstance,
  action: SlashCommand,
  selectedText: string,
) {
  const parentItem = getParentItem(reader);
  setLastSelection(selectedText, parentItem);

  const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("thinking"), progress: 30 })
    .show();

  runSelectionAction({
    action,
    selectedText,
    parentItem,
    onChunk: (text) => {
      popup.changeLine({ text: text.slice(-1500) || getString("thinking") });
    },
    onDone: async (text) => {
      popup.changeLine({ text: getString("done"), progress: 100 });
      popup.startCloseTimer(2500);
      if (action === "note") {
        await saveChildNote(parentItem, action, selectedText, text);
      }
    },
    onError: (error) => {
      popup.changeLine({
        text: `${getString("error-api")}: ${error.message}`,
        progress: 100,
      });
      popup.startCloseTimer(5000);
    },
  });
}

function handleAnnotationContextMenu(
  event: _ZoteroTypes.Reader.EventParams<"createAnnotationContextMenu">,
) {
  const { reader, params, append } = event;
  append({
    label: getString("annotation-action-explain"),
    onCommand: () => {
      const selectedText = collectAnnotationText(reader, params.ids);
      if (!selectedText) {
        return;
      }
      runContextMenuAction(reader, contextMenuActionMap.explain, selectedText);
    },
  });
  append({
    label: getString("annotation-action-summarize"),
    onCommand: () => {
      const selectedText = collectAnnotationText(reader, params.ids);
      if (!selectedText) {
        return;
      }
      runContextMenuAction(
        reader,
        contextMenuActionMap.summarize,
        selectedText,
      );
    },
  });
  append({
    label: getString("annotation-action-note"),
    onCommand: () => {
      const selectedText = collectAnnotationText(reader, params.ids);
      if (!selectedText) {
        return;
      }
      runContextMenuAction(reader, contextMenuActionMap.note, selectedText);
    },
  });
}

function getActiveReaderSelection() {
  const tabID = ztoolkit.getGlobal("Zotero_Tabs").selectedID;
  if (!tabID) {
    return null;
  }
  const reader = Zotero.Reader.getByTabID(tabID);
  if (!reader) {
    return null;
  }
  const selection = reader._iframeWindow?.getSelection?.()?.toString()?.trim();
  if (!selection) {
    return null;
  }
  return {
    reader,
    selection,
    parentItem: getParentItem(reader),
  };
}

function triggerInlineShortcut() {
  const selected = getActiveReaderSelection();
  if (!selected) {
    return;
  }
  setLastSelection(selected.selection, selected.parentItem);
  runContextMenuAction(selected.reader, "chat", selected.selection);
}

export function registerSmartActions() {
  if (addon.data.readerListenersRegistered) {
    return;
  }
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    handleSelectionPopup,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createAnnotationContextMenu",
    handleAnnotationContextMenu,
    config.addonID,
  );
  addon.data.readerListenersRegistered = true;
}

export function registerSmartActionsShortcut() {
  if (addon.data.shortcutRegistered) {
    return;
  }
  ztoolkit.Keyboard.register((event, keyOptions) => {
    if (keyOptions.type !== "keydown") {
      return;
    }
    const isCmdOrCtrl = Zotero.isMac ? event.metaKey : event.ctrlKey;
    if (!isCmdOrCtrl || event.key.toLowerCase() !== "i") {
      return;
    }
    event.preventDefault();
    triggerInlineShortcut();
  });
  addon.data.shortcutRegistered = true;
}

export function getSmartActionLocaleIDs() {
  return {
    header: getLocaleID("chat-panel-header"),
    sidenav: getLocaleID("chat-panel-sidenav"),
  };
}
