import { config } from "../../../package.json";
import {
  buildPrompt,
  type SlashCommand,
  getPaperContext,
} from "../context/builder";
import { type ChatMessage, streamChat } from "../llm/service";
import { getLocaleID, getString } from "../../utils/locale";

interface PanelState {
  root: HTMLDivElement;
  messages: HTMLDivElement;
  hints: HTMLDivElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  item: Zotero.Item | null;
  itemID: number | null;
  thinkingNode: HTMLDivElement | null;
}

const panelState = new WeakMap<HTMLDivElement, PanelState>();

const slashCommands: SlashCommand[] = [
  "explain",
  "summarize",
  "translate",
  "note",
  "critique",
  "related",
];

function escapeHTML(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHTML(text: string) {
  const escaped = escapeHTML(text);
  const fenced = escaped.replace(
    /```([\s\S]*?)```/g,
    "<pre><code>$1</code></pre>",
  );
  const inlineCode = fenced.replace(/`([^`]+)`/g, "<code>$1</code>");
  const bold = inlineCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const italic = bold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const quote = italic.replace(
    /^&gt;\s?(.*)$/gm,
    "<blockquote>$1</blockquote>",
  );
  const lists = quote.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
  const wrappedLists = lists.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  return wrappedLists.replace(/\n/g, "<br/>");
}

function getSession(itemID: number) {
  let session = addon.data.chatSessions.get(itemID);
  if (!session) {
    session = [];
    addon.data.chatSessions.set(itemID, session);
  }
  return session;
}

function pushMessage(itemID: number, message: ChatMessage) {
  const session = getSession(itemID);
  session.push(message);
}

function createMessageBubble(
  doc: Document,
  role: "user" | "assistant",
  content: string,
) {
  const row = doc.createElement("div");
  row.className = `zc-message-row ${role}`;

  const bubble = doc.createElement("div");
  bubble.className = `zc-message-bubble ${role}`;
  bubble.innerHTML =
    role === "assistant" ? markdownToHTML(content) : escapeHTML(content);
  row.appendChild(bubble);

  if (role === "assistant" && content.trim()) {
    const copyButton = doc.createElement("button");
    copyButton.className = "zc-copy-button";
    copyButton.textContent = `📋 ${getString("copy")}`;
    copyButton.addEventListener("click", () => {
      new ztoolkit.Clipboard().addText(content, "text/unicode").copy();
    });
    row.appendChild(copyButton);
  }

  return row;
}

function getPanelDocument(state: PanelState): Document {
  return state.root.ownerDocument!;
}

function renderSession(state: PanelState) {
  state.messages.replaceChildren();
  if (!state.itemID) {
    return;
  }
  const session = getSession(state.itemID);
  for (const message of session) {
    if (message.role === "system") {
      continue;
    }
    state.messages.appendChild(
      createMessageBubble(
        getPanelDocument(state),
        message.role,
        message.content,
      ),
    );
  }
  state.messages.scrollTop = state.messages.scrollHeight;
}

function parseInputCommand(input: string): {
  action: SlashCommand;
  userText: string;
  hasExplicitCommand: boolean;
} {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { action: "chat", userText: trimmed, hasExplicitCommand: false };
  }

  const [first, ...rest] = trimmed.slice(1).split(/\s+/);
  const action = first.toLowerCase() as SlashCommand;
  if (!slashCommands.includes(action) && action !== "chat") {
    return { action: "chat", userText: trimmed, hasExplicitCommand: false };
  }

  const userText = rest.join(" ").trim();
  return { action, userText, hasExplicitCommand: true };
}

function getSelectedTextForPanel(itemID: number | null) {
  if (
    addon.data.lastSelectionText &&
    itemID &&
    addon.data.lastSelectionItemID === itemID
  ) {
    return addon.data.lastSelectionText;
  }
  return "";
}

function updateHintVisibility(state: PanelState) {
  state.hints.style.display = state.input.value.trim().startsWith("/")
    ? "flex"
    : "none";
}

function addThinking(state: PanelState) {
  if (state.thinkingNode) {
    state.thinkingNode.remove();
  }
  const node = createMessageBubble(
    getPanelDocument(state),
    "assistant",
    getString("thinking"),
  );
  state.messages.appendChild(node);
  state.thinkingNode = node;
  state.messages.scrollTop = state.messages.scrollHeight;
}

function removeThinking(state: PanelState) {
  state.thinkingNode?.remove();
  state.thinkingNode = null;
}

function buildChatMessages(
  action: SlashCommand,
  userText: string,
  item: Zotero.Item,
  itemID: number,
): ChatMessage[] {
  if (action !== "chat") {
    return buildPrompt(action, userText, item);
  }

  const systemMessage: ChatMessage = {
    role: "system",
    content: `You are an academic research copilot. Keep answers grounded in the current paper.\n\nPaper context:\n${getPaperContext(item)}`,
  };
  const session = getSession(itemID).filter(
    (message) => message.role !== "system",
  );
  return [systemMessage, ...session, { role: "user", content: userText }];
}

function sendMessage(state: PanelState) {
  if (!state.item || !state.itemID) {
    return;
  }

  const parsed = parseInputCommand(state.input.value);
  const selectedText = getSelectedTextForPanel(state.itemID);
  const userText = parsed.userText || selectedText;
  if (!userText.trim()) {
    return;
  }

  state.input.value = "";
  updateHintVisibility(state);

  const outgoingText = parsed.hasExplicitCommand
    ? `/${parsed.action} ${userText}`.trim()
    : userText;
  pushMessage(state.itemID, { role: "user", content: outgoingText });
  state.messages.appendChild(
    createMessageBubble(getPanelDocument(state), "user", outgoingText),
  );

  addThinking(state);
  state.send.disabled = true;

  const messages = buildChatMessages(
    parsed.action,
    userText,
    state.item,
    state.itemID,
  );
  let latest = "";

  const controller = streamChat(messages, {
    onChunk: (text) => {
      latest = text;
      if (state.thinkingNode) {
        const bubble = state.thinkingNode.querySelector(
          ".zc-message-bubble",
        ) as HTMLDivElement;
        if (bubble) {
          bubble.innerHTML = markdownToHTML(text || getString("thinking"));
        }
      }
    },
    onDone: (text) => {
      addon.data.activeAbortControllers.delete(controller);
      removeThinking(state);
      pushMessage(state.itemID!, { role: "assistant", content: text });
      state.messages.appendChild(
        createMessageBubble(getPanelDocument(state), "assistant", text),
      );
      state.messages.scrollTop = state.messages.scrollHeight;
      state.send.disabled = false;
      addon.data.lastSelectionResponse = text || latest;
    },
    onError: (error) => {
      addon.data.activeAbortControllers.delete(controller);
      removeThinking(state);
      state.messages.appendChild(
        createMessageBubble(
          getPanelDocument(state),
          "assistant",
          `${getString("error-api")}: ${error.message}`,
        ),
      );
      state.messages.scrollTop = state.messages.scrollHeight;
      state.send.disabled = false;
    },
  });
  addon.data.activeAbortControllers.add(controller);
}

function buildPanelUI(body: HTMLDivElement): PanelState {
  const doc = body.ownerDocument!;
  body.replaceChildren();
  body.classList.add("zotero-copilot-panel-root");

  const root = doc.createElement("div");
  root.className = "zc-panel";

  const header = doc.createElement("div");
  header.className = "zc-header";

  const title = doc.createElement("div");
  title.className = "zc-title";
  title.textContent = "AI Copilot";

  const settingsButton = doc.createElement("button");
  settingsButton.className = "zc-settings";
  settingsButton.textContent = "⚙";
  settingsButton.title = getString("open-settings");
  settingsButton.addEventListener("click", () => {
    const el = Zotero.getMainWindow()?.document.getElementById(
      "menu_preferences",
    ) as any;
    el?.doCommand?.();
  });

  header.append(title, settingsButton);

  const messages = doc.createElement("div");
  messages.className = "zc-messages";

  const hints = doc.createElement("div");
  hints.className = "zc-hints";
  hints.style.display = "none";
  for (const cmd of slashCommands) {
    const tag = doc.createElement("button");
    tag.className = "zc-hint";
    tag.textContent = `/${cmd}`;
    tag.addEventListener("click", () => {
      state.input.value = `/${cmd} `;
      updateHintVisibility(state);
      state.input.focus();
    });
    hints.appendChild(tag);
  }

  const inputRow = doc.createElement("div");
  inputRow.className = "zc-input-row";

  const input = doc.createElement("textarea");
  input.className = "zc-input";
  input.placeholder = getString("chat-input-placeholder");
  input.addEventListener("input", () => updateHintVisibility(state));
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(state);
    }
  });

  const send = doc.createElement("button");
  send.className = "zc-send";
  send.textContent = "Send ▶";
  send.addEventListener("click", () => sendMessage(state));

  inputRow.append(input, send);
  root.append(header, messages, hints, inputRow);
  body.appendChild(root);

  const state: PanelState = {
    root,
    messages,
    hints,
    input,
    send,
    item: null,
    itemID: null,
    thinkingNode: null,
  };
  return state;
}

export function registerChatPanelSection() {
  if (addon.data.chatPanelSectionKey) {
    return addon.data.chatPanelSectionKey;
  }

  const key = Zotero.ItemPaneManager.registerSection({
    paneID: "copilot-chat",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("chat-panel-header"),
      icon: `chrome://${config.addonRef}/content/icons/chat-16.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("chat-panel-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/chat-20.svg`,
    },
    onInit: ({ body }) => {
      const state = buildPanelUI(body);
      panelState.set(body, state);
    },
    onDestroy: ({ body }) => {
      panelState.delete(body);
    },
    onItemChange: ({ item, body, setEnabled }) => {
      const state = panelState.get(body);
      if (!state) {
        return true;
      }

      const targetItem = item?.isRegularItem()
        ? item
        : item?.parentItem || item;
      if (!targetItem || !targetItem.id) {
        state.item = null;
        state.itemID = null;
        state.messages.replaceChildren();
        setEnabled(false);
        return true;
      }

      state.item = targetItem;
      state.itemID = targetItem.id;
      setEnabled(true);
      return true;
    },
    onRender: ({ body }) => {
      const state = panelState.get(body);
      if (!state) {
        return;
      }
      renderSession(state);
    },
    onAsyncRender: async ({ body }) => {
      const state = panelState.get(body);
      if (!state) {
        return;
      }
      renderSession(state);
    },
  });

  if (key) {
    addon.data.chatPanelSectionKey = key;
  }
  return key;
}

export function unregisterChatPanelSection() {
  if (!addon.data.chatPanelSectionKey) {
    return;
  }
  Zotero.ItemPaneManager.unregisterSection(addon.data.chatPanelSectionKey);
  addon.data.chatPanelSectionKey = undefined;
}
