package steps

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"unicode"

	"go.uber.org/zap"
)

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

func sqlLogFields(sql string) []zap.Field {
	trimmed := strings.TrimSpace(sql)
	return []zap.Field{
		zap.Int("sql_length", len(trimmed)),
		zap.String("sql_hash", fmt.Sprintf("%x", sha256.Sum256([]byte(trimmed)))[:12]),
		zap.String("sql_command", firstSQLCommand(trimmed)),
	}
}

func firstSQLCommand(sql string) string {
	for _, field := range strings.Fields(sql) {
		var b strings.Builder
		for _, r := range field {
			if unicode.IsLetter(r) || r == '_' {
				b.WriteRune(unicode.ToUpper(r))
			} else if b.Len() > 0 {
				break
			}
		}
		if b.Len() > 0 {
			return b.String()
		}
	}
	return ""
}
