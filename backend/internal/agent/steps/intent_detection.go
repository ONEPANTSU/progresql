package steps

import (
	"context"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// ContextKeyIntent is the key used to store the detected intent in PipelineContext.
const ContextKeyIntent = "intent"

// Intent values.
const (
	IntentSQL            = "sql"
	IntentConversational = "conversational"
	IntentKnowledge      = "knowledge"
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
	if isDocumentationWriteRequest(msg) {
		pctx.Set(ContextKeyIntent, IntentKnowledge)
		pctx.Logger.Info("intent detected", zap.String("intent", IntentKnowledge), zap.String("reason", "documentation_write_request"))
		return s.handleKnowledge(ctx, pctx, model)
	}

	// Classify intent via a fast LLM call.
	classifyPrompt := "You are an intent classifier for a PostgreSQL database assistant.\n" +
		"Classify the following user message as \"sql\", \"knowledge\", or \"conversational\".\n\n" +
		"Rules:\n" +
		"- \"sql\" — the user wants to generate SQL, query data, explore/analyze the database structure, " +
		"list tables, describe entities, or anything that requires executing a query against the database.\n" +
		"- \"knowledge\" — the user asks a conceptual, theoretical, or educational question about databases, " +
		"PostgreSQL, SQL syntax, data types, best practices, comparisons, or explanations that can be " +
		"answered with plain text WITHOUT generating or executing SQL.\n" +
		"- \"conversational\" — ONLY pure greetings, thanks, and chitchat that do NOT require database knowledge.\n\n" +
		"IMPORTANT: \"knowledge\" is for questions that need a TEXT explanation, not a SQL query.\n" +
		"IMPORTANT: When in doubt between sql and knowledge, classify as \"sql\".\n\n" +
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
		"Examples classified as \"knowledge\":\n" +
		"- \"чем отличается домен от перечисления?\" → knowledge\n" +
		"- \"what is the difference between a view and a materialized view?\" → knowledge\n" +
		"- \"зачем нужны индексы?\" → knowledge\n" +
		"- \"explain ACID properties\" → knowledge\n" +
		"- \"что такое нормализация?\" → knowledge\n" +
		"- \"when should I use JSONB vs JSON?\" → knowledge\n" +
		"- \"в чём разница между INNER JOIN и LEFT JOIN?\" → knowledge\n" +
		"- \"what are PostgreSQL isolation levels?\" → knowledge\n" +
		"- \"как работает MVCC?\" → knowledge\n" +
		"- \"что лучше — UUID или SERIAL для первичного ключа?\" → knowledge\n" +
		"- \"а чем отличаются эти понятия в принципе?\" → knowledge\n" +
		"- \"расскажи про типы данных в PostgreSQL\" → knowledge\n" +
		"- \"what is a CTE?\" → knowledge\n" +
		"- \"как правильно писать миграции?\" → knowledge\n\n" +
		"Examples classified as \"conversational\":\n" +
		"- \"hello\" → conversational\n" +
		"- \"привет\" → conversational\n" +
		"- \"thanks\" → conversational\n" +
		"- \"спасибо\" → conversational\n" +
		"- \"who are you\" → conversational\n" +
		"- \"расскажи о себе\" → conversational\n\n" +
		"Respond with ONLY one word: sql, knowledge, or conversational\n\n" +
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

	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model

	intent := IntentSQL
	if len(resp.Choices) > 0 {
		raw := strings.TrimSpace(strings.ToLower(stripThinkingTags(resp.Choices[0].Message.Content)))
		switch raw {
		case "conversational":
			intent = IntentConversational
		case "knowledge":
			intent = IntentKnowledge
		}
	}

	pctx.Set(ContextKeyIntent, intent)
	pctx.Logger.Info("intent detected", zap.String("intent", intent))

	switch intent {
	case IntentConversational:
		return s.handleConversational(ctx, pctx, model)
	case IntentKnowledge:
		return s.handleKnowledge(ctx, pctx, model)
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

// handleKnowledge streams a direct LLM response for conceptual/educational questions.
// Unlike conversational, this uses schema context and database expertise to give
// rich, well-structured text answers (markdown tables, examples) WITHOUT generating SQL queries.
func (s *IntentDetectionStep) handleKnowledge(ctx context.Context, pctx *agent.PipelineContext, model string) error {
	if isDocumentationWriteRequest(pctx.UserMessage) {
		response := documentationWriteBackUnavailableMessage(pctx.UserMessage)
		if err := streamStaticAgentText(pctx, response); err != nil {
			return fmt.Errorf("documentation write-back response failed: %w", err)
		}
		pctx.Result.Explanation = response
		pctx.SkipRemaining = true
		return nil
	}

	prompt := "You are an expert PostgreSQL database assistant and teacher.\n" +
		"The user asked a conceptual or educational question about databases, SQL, or PostgreSQL.\n\n" +
		"RULES:\n" +
		"- Answer with clear, well-structured TEXT — use markdown formatting (headers, bullet points, tables).\n" +
		"- Use markdown tables for comparisons instead of SQL queries.\n" +
		"- You MAY include short SQL snippets as EXAMPLES to illustrate concepts, but ONLY if they add value.\n" +
		"- Do NOT generate runnable queries against the user's database. This is a teaching response, not a query.\n" +
		"- Be concise but thorough. Prefer practical advice over dry theory.\n" +
		"- If relevant, mention PostgreSQL-specific features and best practices.\n\n" +
		"Documentation updates:\n" +
		"- If the user asks to update, actualize, or write documentation, explain that direct write-back to external knowledge sources is not enabled yet.\n" +
		"- Offer to prepare a reviewed documentation proposal, text, or diff that the user can apply manually.\n" +
		"- Do not claim that you can automatically write to Confluence, Notion, Git docs, or another knowledge source.\n\n" +
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
		return fmt.Errorf("knowledge response failed: %w", err)
	}

	if len(resp.Choices) > 0 {
		pctx.Result.Explanation = resp.Choices[0].Message.Content
	}

	pctx.SkipRemaining = true
	return nil
}

func isDocumentationWriteRequest(message string) bool {
	msg := strings.ToLower(strings.TrimSpace(message))
	if msg == "" {
		return false
	}

	hasWriteVerb := strings.Contains(msg, "актуализ") ||
		strings.Contains(msg, "обнов") ||
		strings.Contains(msg, "запиш") ||
		strings.Contains(msg, "запис") ||
		strings.Contains(msg, "write") ||
		strings.Contains(msg, "update") ||
		strings.Contains(msg, "actualize")
	hasKnowledgeTarget := strings.Contains(msg, "баз") ||
		strings.Contains(msg, "бз") ||
		strings.Contains(msg, "документац") ||
		strings.Contains(msg, "доки") ||
		strings.Contains(msg, "knowledge") ||
		strings.Contains(msg, "documentation") ||
		strings.Contains(msg, "docs") ||
		strings.Contains(msg, "confluence") ||
		strings.Contains(msg, "wiki")

	return hasWriteVerb && hasKnowledgeTarget
}

func documentationWriteBackUnavailableMessage(message string) string {
	if looksRussian(message) {
		return "Пока я не могу напрямую обновить базу знаний: write-back в Confluence/Notion/Git docs ещё не включён. Сейчас доступны чтение, поиск по источникам знаний и цитаты.\n\n" +
			"Могу подготовить proposal для обновления: текст, структуру раздела или diff для конкретной страницы. Чтобы реально записывать изменения в БЗ, нужен отдельный безопасный flow: выбор страницы, preview diff и ручное подтверждение перед записью."
	}

	return "I can't update the knowledge base directly yet: write-back to Confluence, Notion, or Git docs is not enabled. Read, search, and citations are available now.\n\n" +
		"I can prepare an update proposal: text, section structure, or a diff for a specific page. Applying it to the knowledge source needs a separate safe flow with page selection, diff preview, and manual confirmation."
}

func looksRussian(message string) bool {
	for _, r := range message {
		if r >= 'А' && r <= 'я' || r == 'ё' || r == 'Ё' {
			return true
		}
	}
	return false
}

func streamStaticAgentText(pctx *agent.PipelineContext, text string) error {
	if pctx.Session == nil || pctx.RequestID == "" {
		return nil
	}
	payload := websocket.AgentStreamPayload{Delta: text}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentStream, pctx.RequestID, "", payload)
	if err != nil {
		return err
	}
	return pctx.Session.SendEnvelope(env)
}

func floatPtr(f float64) *float64 { return &f }
