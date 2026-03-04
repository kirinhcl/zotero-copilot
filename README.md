# Zotero Copilot

[![Zotero 7](https://img.shields.io/badge/Zotero-7-blue.svg)](https://www.zotero.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered research assistant for Zotero 7, inspired by VS Code Copilot.

### Smart Actions

Select text in the PDF reader to Explain, Summarize, Translate, or Take Note.

![Smart Actions](img/Screenshot%202026-03-04%20at%2020.04.07.png)

### Chat Panel

Sidebar panel for multi-turn AI conversations per paper with slash commands.

![Chat Panel](img/Screenshot%202026-03-04%20at%2020.04.34.png)

## Features

- Smart Actions: Select text in the PDF reader to Explain, Summarize, Translate, or Take Note via the selection popup.
- Chat Panel: Sidebar panel for multi-turn AI conversations per paper. Use slash commands: /explain, /summarize, /translate, /note.
- Multi-provider:
  - OpenAI (ChatGPT subscription via OAuth or API key)
  - Anthropic Claude (OAuth or API key)
  - Google Gemini (API key)
  - Custom OpenAI-compatible endpoints
- Keyboard Shortcut: Ctrl+I or Cmd+I.

## Installation

1. Download the latest .xpi file from the Releases page.
2. Open Zotero and go to Tools > Add-ons.
3. Click the gear icon and select Install Add-on From File.
4. Choose the downloaded .xpi file.

## Configuration

Open Zotero Settings and go to Zotero Copilot.

All four providers are listed there:
- OpenAI and Anthropic: Use OAuth with your ChatGPT or Claude subscription, or an API key.
- Gemini and Custom: Use an API key only.

## Supported Providers

| Provider | Auth Options |
|----------|-------------|
| OpenAI | ChatGPT subscription (OAuth) or API key |
| Anthropic | Claude subscription (OAuth) or API key |
| Google Gemini | API key |
| Custom | API key (any OpenAI-compatible endpoint) |

Model availability is determined by each provider and your account/subscription tier. You can enter any model name in the settings.

## Build from Source

1. git clone https://github.com/kirinhcl/zotero-copilot.git
2. npm install
3. npm run build
4. The .xpi file is generated in .scaffold/build/.

## License

MIT

## Acknowledgments

- Built on windingwind/zotero-plugin-template.
- OAuth approach inspired by OpenCode.
