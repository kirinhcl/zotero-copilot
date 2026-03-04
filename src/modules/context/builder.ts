import { getPref } from "../../utils/prefs";
import type { ChatMessage } from "../llm/service";

export type SlashCommand =
  | "explain"
  | "summarize"
  | "translate"
  | "note"
  | "critique"
  | "related"
  | "chat";

function safeText(value: string | number | undefined | null) {
  const text = String(value ?? "").trim();
  return text || "N/A";
}

function resolveParentItem(item: Zotero.Item) {
  return item.parentItem || item;
}

function toYear(dateValue: string) {
  const match = dateValue.match(/\d{4}/);
  return match ? match[0] : "N/A";
}

function getAuthorLine(item: Zotero.Item) {
  const creators = item.getCreators();
  if (!creators?.length) {
    return "N/A";
  }
  return creators
    .map((creator) => {
      const fullName = [creator.firstName, creator.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      return fullName || (creator as any).name || "Unknown";
    })
    .join("; ");
}

export function getPaperContext(item: Zotero.Item): string {
  const parentItem = resolveParentItem(item);
  const title = safeText(parentItem.getField("title") as string);
  const authors = safeText(getAuthorLine(parentItem));
  const abstract = safeText(parentItem.getField("abstractNote") as string);
  const year = safeText(toYear((parentItem.getField("date") as string) || ""));
  const doi = safeText(parentItem.getField("DOI") as string);

  return [
    `Title: ${title}`,
    `Authors: ${authors}`,
    `Abstract: ${abstract}`,
    `Year: ${year}`,
    `DOI: ${doi}`,
  ].join("\n");
}

export function getAnnotations(item: Zotero.Item): string {
  const parentItem = resolveParentItem(item);
  const attachments = parentItem.isPDFAttachment()
    ? [parentItem]
    : parentItem
        .getAttachments(false)
        .map((id) => Zotero.Items.get(id) as Zotero.Item)
        .filter((attachment) => attachment?.isPDFAttachment());

  const annotationRows: string[] = [];

  for (const attachment of attachments) {
    const annotations = attachment.getAnnotations(false);
    for (const annotation of annotations) {
      const text = annotation.annotationText?.trim();
      const comment = annotation.annotationComment?.trim();
      const pageLabel = annotation.annotationPageLabel?.trim() || "?";
      if (!text && !comment) {
        continue;
      }
      annotationRows.push(
        `- [p.${pageLabel}] ${text || "(no highlight text)"}${
          comment ? ` | note: ${comment}` : ""
        }`,
      );
    }
  }

  if (!annotationRows.length) {
    return "No annotations available.";
  }
  return annotationRows.join("\n");
}

function getSystemPrompt(action: SlashCommand): string {
  const targetLanguage = getPref("targetLanguage");
  const prompts: Record<SlashCommand, string> = {
    explain:
      "You are an academic assistant. Explain the following text in clear, accessible language. Use the paper context to provide accurate explanations.",
    summarize:
      "You are an academic assistant. Summarize the key points of the following text concisely.",
    translate: `You are a professional academic translator. Translate the following text to ${targetLanguage}. Maintain academic tone and terminology.`,
    note: "You are an academic note-taking assistant. Create structured notes from the following text. Include: key points, important terms, and questions for further exploration. Output in Markdown.",
    critique:
      "You are an academic reviewer. Provide a critical analysis of the following text. Identify assumptions, limitations, and potential issues.",
    related:
      "You are a research assistant. Based on the following text, suggest related research directions, keywords, and potential references to explore.",
    chat: "You are an academic research copilot. Answer the user based on the provided paper context.",
  };
  return prompts[action];
}

export function buildPrompt(
  action: SlashCommand,
  selectedText: string,
  item: Zotero.Item,
): ChatMessage[] {
  const context = getPaperContext(item);
  const annotations = getAnnotations(item);
  const systemPrompt = [
    getSystemPrompt(action),
    "",
    "Paper context:",
    context,
    "",
    "Paper annotations:",
    annotations,
  ].join("\n");

  const userPrompt = selectedText.trim() || "Use the paper context to continue.";
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
