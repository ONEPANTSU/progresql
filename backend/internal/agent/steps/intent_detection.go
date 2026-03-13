package steps

import (
	"context"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
)

// ContextKeyIntent is the key used to store the detected intent in PipelineContext.
const ContextKeyIntent = "intent"

// Intent values.
const (
	IntentSQL            = "sql"
	IntentConversational = "conversational"
)

// IntentDetectionStep classifies user messages as SQL-related or conversational.
// For conversational messages ("hello", "thanks"), it streams a direct LLM response
// and sets SkipRemaining to bypass schema grounding and SQL generation.
type IntentDetectionStep struct{}

func (s *IntentDetectionStep) Name() string { return "intent_detection" }

func (s *IntentDetectionStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	msg := strings.TrimSpace(pctx.UserMessage)
	if msg == "" {
		return fmt.Errorf("user_message is required for generate_sql action")
	}

	model := pctx.Model

	// Classify intent via a fast LLM call.
	classifyPrompt := "You are an intent classifier for a PostgreSQL database assistant.\n" +
		"Classify the following user message as either \"sql\" or \"conversational\".\n\n" +
		"Rules:\n" +
		"- \"sql\" — the user wants to generate SQL, query data, explore/analyze database, " +
		"learn about database structure, list tables, describe entities, or anything that requires accessing the database.\n" +
		"- \"conversational\" — ONLY pure greetings, thanks, and chitchat that do NOT require database access.\n\n" +
		"IMPORTANT: When in doubt, classify as \"sql\". Any message that mentions the database, tables, " +
		"data, entities, schema, or asks to show/explain/describe anything in the database is \"sql\".\n\n" +
		"Examples classified as \"sql\":\n" +
		"- \"show all users\" → sql\n" +
		"- \"покажи все заказы за вчера\" → sql\n" +
		"- \"write a query for orders\" → sql\n" +
		"- \"напиши запрос для поиска пользователей\" → sql\n" +
		"- \"SELECT * FROM users\" → sql\n" +
		"- \"покажи все таблицы\" → sql\n" +
		"- \"найди дубликаты в таблице products\" → sql\n" +
		"- \"how many orders were placed last month\" → sql\n" +
		"- \"add WHERE active = true\" → sql\n" +
		"- \"join users with orders\" → sql\n" +
		"- \"объясни текущую бд\" → sql\n" +
		"- \"что это за бд?\" → sql\n" +
		"- \"какие сущности есть\" → sql\n" +
		"- \"объясни основные сущности\" → sql\n" +
		"- \"расскажи про базу данных\" → sql\n" +
		"- \"describe the database\" → sql\n" +
		"- \"what tables do I have\" → sql\n" +
		"- \"давай начнём\" → sql\n" +
		"- \"начни\" → sql\n" +
		"- \"go\" → sql\n" +
		"- \"давай\" → sql\n\n" +
		"Examples classified as \"conversational\":\n" +
		"- \"hello\" → conversational\n" +
		"- \"привет\" → conversational\n" +
		"- \"thanks\" → conversational\n" +
		"- \"спасибо\" → conversational\n" +
		"- \"who are you\" → conversational\n" +
		"- \"расскажи о себе\" → conversational\n\n" +
		"Respond with ONLY one word: sql or conversational\n\n" +
		"User message: " + msg

	classifyReq := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: classifyPrompt},
		),
		Temperature: floatPtr(0.0),
	}

	pctx.Logger.Info("classifying intent", zap.String("model", model))

	resp, err := pctx.LLMClient.ChatCompletion(ctx, classifyReq)
	if err != nil {
		// On classification failure, assume SQL intent and continue pipeline.
		pctx.Logger.Warn("intent classification failed, defaulting to sql", zap.Error(err))
		pctx.Set(ContextKeyIntent, IntentSQL)
		return nil
	}

	pctx.AddTokens(resp.Usage.TotalTokens)
	pctx.ModelUsed = resp.Model

	intent := IntentSQL
	if len(resp.Choices) > 0 {
		raw := strings.TrimSpace(strings.ToLower(stripThinkingTags(resp.Choices[0].Message.Content)))
		if raw == "conversational" {
			intent = IntentConversational
		}
	}

	pctx.Set(ContextKeyIntent, intent)
	pctx.Logger.Info("intent detected", zap.String("intent", intent))

	if intent == IntentConversational {
		return s.handleConversational(ctx, pctx, model)
	}

	return nil
}

// handleConversational streams a direct LLM response for non-SQL messages.
func (s *IntentDetectionStep) handleConversational(ctx context.Context, pctx *agent.PipelineContext, model string) error {
	prompt := "You are a friendly PostgreSQL database assistant. " +
		"The user sent a conversational message (not a SQL request). " +
		"Respond naturally and briefly. If appropriate, mention that you can help with SQL queries, " +
		"schema analysis, and database tasks.\n\n" +
		"IMPORTANT: Always respond in the same language as the user's message. " +
		"If the user writes in Russian, respond in Russian. If in English, respond in English.\n\n" +
		"User message: " + pctx.UserMessage

	req := llm.ChatRequest{
		Model: model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
	}

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		return fmt.Errorf("conversational response failed: %w", err)
	}

	if len(resp.Choices) > 0 {
		pctx.Result.Explanation = resp.Choices[0].Message.Content
	}

	pctx.SkipRemaining = true
	return nil
}

func floatPtr(f float64) *float64 { return &f }
