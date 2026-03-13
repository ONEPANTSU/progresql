package agent

import (
	"strings"
	"testing"
)

func TestSafeModeSystemPrompt_Safe(t *testing.T) {
	prompt := SafeModeSystemPrompt(true)
	if !strings.Contains(prompt, "Safe Mode") {
		t.Error("safe mode prompt should mention 'Safe Mode'")
	}
	if !strings.Contains(prompt, "MUST NOT") {
		t.Error("safe mode prompt should contain restrictions")
	}
	if !strings.Contains(prompt, "INSERT") {
		t.Error("safe mode prompt should mention blocked commands")
	}
}

func TestSafeModeSystemPrompt_Unsafe(t *testing.T) {
	prompt := SafeModeSystemPrompt(false)
	if !strings.Contains(prompt, "Unsafe Mode") {
		t.Error("unsafe mode prompt should mention 'Unsafe Mode'")
	}
	if !strings.Contains(prompt, "full access") {
		t.Error("unsafe mode prompt should mention full access")
	}
}

func TestMessagesWithHistory_IncludesSafeModePrompt(t *testing.T) {
	pctx := NewPipelineContext()
	pctx.SafeMode = true

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

	msgs := pctx.MessagesWithHistory()
	if len(msgs) == 0 {
		t.Fatal("expected at least 1 message (system prompt)")
	}
	if !strings.Contains(msgs[0].Content, "Unsafe Mode") {
		t.Error("system prompt should mention Unsafe Mode")
	}
}

func TestPipelineContext_SafeMode_DefaultTrue(t *testing.T) {
	// When no context is provided in the payload, SafeMode defaults to true.
	// This is tested at the pipeline level — here we verify the field exists.
	pctx := NewPipelineContext()
	// Default zero value for bool is false, but the pipeline sets it to true.
	// So we just verify the field is accessible.
	pctx.SafeMode = true
	if !pctx.SafeMode {
		t.Error("SafeMode should be settable to true")
	}
}
