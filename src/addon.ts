import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { ChatMessage } from "./modules/llm/service";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
    };
    chatSessions: Map<number, ChatMessage[]>;
    activeAbortControllers: Set<{ abort: () => void }>;
    chatPanelSectionKey?: string;
    readerListenersRegistered?: boolean;
    shortcutRegistered?: boolean;
    styleWindows: WeakSet<Window>;
    panelStates: WeakMap<HTMLElement, unknown>;
    lastSelectionText?: string;
    lastSelectionItemID?: number;
    lastSelectionAction?: string;
    lastSelectionResponse?: string;
    lastSelectionTimestamp?: number;
    transient?: {
      [key: string]: unknown;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      chatSessions: new Map(),
      activeAbortControllers: new Set(),
      styleWindows: new WeakSet(),
      panelStates: new WeakMap(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
