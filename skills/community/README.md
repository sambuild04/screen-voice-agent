# Community Skills

Drop your skill files here via PR. A skill is a markdown file that teaches Samuel a reusable multi-step workflow.

## Format

```markdown
---
title: "Annotate article with furigana"
trigger: "User asks for furigana on every Japanese name in an article"
summary: "Reads the page, extracts proper nouns, and adds furigana annotations"
---

1. `web_browse(action="read", url=<current article URL>)` to get the page text
2. Scan for Japanese proper nouns (people/places); skip ones already annotated
3. Look up readings via your own knowledge or `web_browse(action="search", query="<name> 読み方")`
4. `show_content(action="show", title="Annotated article", html=...)` with each name as `<ruby>`
5. Save the workflow with `skill_manage(action="save", ...)` for next time
```

## Guidelines

- **Trigger** should describe when Samuel should use this skill (natural language pattern).
- **Steps** should be numbered and reference actual tool names with parameters.
- **Keep it reusable** — don't hardcode specific URLs, song titles, or personal details.
- Skills that work well get featured in releases.
