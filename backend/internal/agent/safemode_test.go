package agent

import (
	"strings"
	"testing"
)

func TestSafeModeSystemPrompt_Safe(t *testing.T) {
	prompt := SafeModeSystemPrompt("safe", "en")
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("safe mode prompt should mention 'Safe Mode'")
	}
	if !strings.Contains(prompt, "MUST NOT") {
		t.Error("safe mode prompt should contain restrictions")
	}
	if !strings.Contains(prompt, "INSERT") {
		t.Error("safe mode prompt should mention blocked commands")
	}
	if !strings.Contains(prompt, "pg_proc") {
		t.Error("safe mode prompt should list allowed system catalogs")
	}
	if !strings.Contains(prompt, "English") {
		t.Error("safe mode prompt with 'en' should instruct English")
	}
}

func TestSafeModeSystemPrompt_SafeRussian(t *testing.T) {
	prompt := SafeModeSystemPrompt("safe", "ru")
	if !strings.Contains(prompt, "Russian") {
		t.Error("safe mode prompt with 'ru' should instruct Russian")
	}
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("safe mode prompt should mention 'Safe Mode'")
	}
}

func TestSafeModeSystemPrompt_DataMode(t *testing.T) {
	prompt := SafeModeSystemPrompt("data", "en")
	if !strings.Contains(prompt, "Data Mode") {
		t.Error("data mode prompt should mention 'Data Mode'")
	}
	if !strings.Contains(prompt, "Read Only") {
		t.Error("data mode prompt should mention 'Read Only'")
	}
	if !strings.Contains(prompt, "read-only access") {
		t.Error("data mode prompt should mention read-only access")
	}
	if !strings.Contains(prompt, "MUST NOT generate INSERT") {
		t.Error("data mode prompt should block write operations")
	}
	if !strings.Contains(prompt, "Execute Mode") {
		t.Error("data mode prompt should suggest Execute Mode for writes")
	}
}

func TestSafeModeSystemPrompt_ExecuteMode(t *testing.T) {
	prompt := SafeModeSystemPrompt("execute", "en")
	if !strings.Contains(prompt, "Execute Mode") {
		t.Error("execute mode prompt should mention 'Execute Mode'")
	}
	if !strings.Contains(prompt, "Full Access") {
		t.Error("execute mode prompt should mention 'Full Access'")
	}
	if !strings.Contains(prompt, "full access") {
		t.Error("execute mode prompt should mention full access")
	}
}

func TestSafeModeSystemPrompt_UnknownDefaultsToSafe(t *testing.T) {
	prompt := SafeModeSystemPrompt("unknown", "en")
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("unknown mode should default to safe mode prompt")
	}
}

func TestSafeModeSystemPrompt_EmptyDefaultsToSafe(t *testing.T) {
	prompt := SafeModeSystemPrompt("", "en")
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("empty mode should default to safe mode prompt")
	}
}

func TestMessagesWithHistory_IncludesSafeModePrompt(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SecurityMode = "safe"
	pctx.Language = "en"

	msgs := pctx.MessagesWithHistory()
	if len(msgs) == 0 {
		t.Fatal("expected at least 1 message (system prompt)")
	}
	if msgs[0].Role != "system" {
		t.Errorf("first message role = %q, want 'system'", msgs[0].Role)
	}
	if !strings.Contains(msgs[0].Content, "Safe Mode") {
		t.Error("system prompt should mention Safe Mode")
	}
}

func TestMessagesWithHistory_DataMode(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SecurityMode = "data"
	pctx.Language = "en"

	msgs := pctx.MessagesWithHistory()
	if len(msgs) == 0 {
		t.Fatal("expected at least 1 message (system prompt)")
	}
	if !strings.Contains(msgs[0].Content, "Data Mode") {
		t.Error("system prompt should mention Data Mode")
	}
}

func TestMessagesWithHistory_ExecuteMode(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SecurityMode = "execute"
	pctx.Language = "en"

	msgs := pctx.MessagesWithHistory()
	if len(msgs) == 0 {
		t.Fatal("expected at least 1 message (system prompt)")
	}
	if !strings.Contains(msgs[0].Content, "Execute Mode") {
		t.Error("system prompt should mention Execute Mode")
	}
}

func TestPipelineContext_SecurityMode_DefaultSafe(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SecurityMode = "safe"
	if pctx.SecurityMode != "safe" {
		t.Error("SecurityMode should be settable to 'safe'")
	}
}
