---
description: Search past knowledge in the graph memory
argument-hint: "[query]"
allowed-tools: ["mcp__plugin_laqrumcode_laqrumcode__recall"]
---

Search the LaqrumCode memory graph for past knowledge matching the user's query.

If $ARGUMENTS is provided, use it as the search query. If empty, ask the user what they want to search for.

Call the `recall` tool with the query. Display results clearly with source type tags, dates, and relevance scores. If no results are found, suggest narrowing or broadening the scope.
