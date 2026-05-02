package steps

import "strings"

// stripThinkingTags removes <think>...</think> blocks that reasoning models
// (e.g. Qwen, DeepSeek) prepend to their responses before the actual content.
// Handles both <think>...</think> and partial/unclosed <think> tags.
func stripThinkingTags(s string) string {
	s = strings.TrimSpace(s)
	for {
		openIdx := strings.Index(s, "<think>")
		if openIdx == -1 {
			break
		}
		closeIdx := strings.Index(s, "</think>")
		if closeIdx != -1 && closeIdx > openIdx {
			s = s[:openIdx] + s[closeIdx+len("</think>"):]
		} else {
			s = s[:openIdx]
		}
		s = strings.TrimSpace(s)
	}
	return strings.TrimSpace(s)
}

// stripCodeFences removes markdown code block fences from a string.
// Handles ```json, ```sql, ```<any-lang>, and bare ``` fences.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		idx := strings.Index(s, "\n")
		if idx != -1 {
			s = s[idx+1:]
		} else {
			s = strings.TrimPrefix(s, "```")
		}
	}
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}
