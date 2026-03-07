/**
 * Structured help for tools and capabilities. Inspired by OpenClaw's
 * buildHelpMessage / tool summaries in system prompt.
 */

export const TOOL_SUMMARIES: Record<string, string> = {
  read: "Capture the current page as a screenshot and return it for reading.",
  read_pages: "Read multiple pages via OCR. Automatically stops at chapter boundaries.",
  next_page: "Flip one page forward.",
  prev_page: "Flip one page backward.",
  scroll_down: "Scroll down (for PDF-style books).",
  go_to_chapter: "Navigate to a specific chapter by number. Turns pages until the chapter heading is found.",
  search_book: "Search for keywords or text in the book (Cmd+F).",
};

export function buildHelpMessage(): string {
  return (
    "I read from Apple Books via screenshots. I can jump to any chapter, read pages or entire chapters, and search for keywords. " +
    "Say \"go to chapter 4,\" \"read chapter 3,\" \"next chapter,\" \"read next page,\" or \"find the part about marketing.\" " +
    "After reading, ask \"what does that mean?\" or \"summarize that.\" Open a book and tell me what you need, sir."
  );
}

export function buildToolAvailabilityPrompt(): string {
  const toolLines = Object.entries(TOOL_SUMMARIES).map(
    ([name, summary]) => `- ${name}: ${summary}`,
  );
  return [
    "## Tool availability",
    "Call tools exactly as listed. Use the right tool for the request:",
    ...toolLines,
    "",
    "If the user asks for something you cannot do (e.g. read from the web, access other apps), say so and list what you can do.",
  ].join("\n");
}
