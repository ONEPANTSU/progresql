package agent

import (
	"strings"
	"testing"
)

func TestSafeModeSystemPrompt_Safe(t *testing.T) {
	prompt := SafeModeSystemPrompt(true, "en")
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
	prompt := SafeModeSystemPrompt(true, "ru")
	if !strings.Contains(prompt, "Russian") {
		t.Error("safe mode prompt with 'ru' should instruct Russian")
	}
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("safe mode prompt should mention 'Safe Mode'")
	}
}

func TestSafeModeSystemPrompt_Unsafe(t *testing.T) {
	prompt := SafeModeSystemPrompt(false, "en")
	if !strings.Contains(prompt, "Full Access Mode") {
		t.Error("unsafe mode prompt should mention 'Full Access Mode'")
	}
	if !strings.Contains(prompt, "full access") {
		t.Error("unsafe mode prompt should mention full access")
	}
}

func TestMessagesWithHistory_IncludesSafeModePrompt(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SafeMode = true
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

func TestMessagesWithHistory_UnsafeMode(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SafeMode = false
	pctx.Language = "en"

	msgs := pctx.MessagesWithHistory()
	if len(msgs) == 0 {
		t.Fatal("expected at least 1 message (system prompt)")
	}
	if !strings.Contains(msgs[0].Content, "Full Access Mode") {
		t.Error("system prompt should mention Full Access Mode")
	}
}

func TestPipelineContext_SafeMode_DefaultTrue(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SafeMode = true
	if !pctx.SafeMode {
		t.Error("SafeMode should be settable to true")
	}
}
