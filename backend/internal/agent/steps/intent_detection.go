package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
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
	if proposalID, ok := documentationApplyProposalID(msg); ok {
		pctx.Set(ContextKeyIntent, IntentKnowledge)
		pctx.Logger.Info("intent detected", zap.String("intent", IntentKnowledge), zap.String("reason", "documentation_apply_request"))
		return s.handleDocumentationApply(ctx, pctx, proposalID)
	}
	if isDocumentationWriteRequest(msg) {
		pctx.Set(ContextKeyIntent, IntentKnowledge)
		pctx.Logger.Info("intent detected", zap.String("intent", IntentKnowledge), zap.String("reason", "documentation_write_request"))
		return s.handleDocumentationProposal(ctx, pctx)
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
		return s.handleDocumentationProposal(ctx, pctx)
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

func (s *IntentDetectionStep) handleDocumentationProposal(ctx context.Context, pctx *agent.PipelineContext) error {
	if pctx.ToolDispatcher == nil || !pctx.KnowledgeEnabled {
		response := documentationWriteBackUnavailableMessage(pctx.UserMessage)
		if err := streamStaticAgentText(pctx, response); err != nil {
			return fmt.Errorf("documentation proposal response failed: %w", err)
		}
		pctx.Result.Explanation = response
		pctx.SkipRemaining = true
		return nil
	}

	proposalDraft := s.buildDocumentationProposalDraft(ctx, pctx)
	args, _ := json.Marshal(map[string]any{
		"query":               pctx.UserMessage,
		"database":            pctx.Database,
		"disabled_source_ids": pctx.DisabledKnowledgeSourceIDs,
		"suggested_text":      proposalDraft.SuggestedText,
		"diff":                proposalDraft.Diff,
	})
	result, err := pctx.DispatchTool(tools.ToolKnowledgeProposeUpdate, args)
	if err != nil || !result.Success {
		message := documentationProposalFailedMessage(pctx.UserMessage, toolErrorMessage(result, err))
		if streamErr := streamStaticAgentText(pctx, message); streamErr != nil {
			return fmt.Errorf("documentation proposal response failed: %w", streamErr)
		}
		pctx.Result.Explanation = message
		pctx.SkipRemaining = true
		return nil
	}

	var proposal struct {
		ProposalID    string `json:"proposal_id"`
		SourceName    string `json:"source_name"`
		Title         string `json:"title"`
		URL           string `json:"url"`
		SuggestedText string `json:"suggested_text"`
		Diff          string `json:"diff"`
		CanApply      bool   `json:"can_apply"`
		Message       string `json:"message"`
	}
	if err := json.Unmarshal(result.Data, &proposal); err != nil {
		return fmt.Errorf("decode documentation proposal: %w", err)
	}

	message := formatDocumentationProposalMessage(pctx.UserMessage, proposal.ProposalID, proposal.SourceName, proposal.Title, proposal.URL, proposal.SuggestedText, proposal.Diff, proposal.CanApply, proposal.Message)
	if err := streamStaticAgentText(pctx, message); err != nil {
		return fmt.Errorf("documentation proposal response failed: %w", err)
	}
	pctx.Result.Explanation = message
	pctx.SkipRemaining = true
	return nil
}

type documentationProposalDraft struct {
	SuggestedText string
	Diff          string
}

func (s *IntentDetectionStep) buildDocumentationProposalDraft(ctx context.Context, pctx *agent.PipelineContext) documentationProposalDraft {
	fallback := fallbackDocumentationProposalDraft(pctx.UserMessage, pctx.Database)
	searchArgs, _ := json.Marshal(map[string]any{
		"query":               pctx.UserMessage,
		"database":            pctx.Database,
		"limit":               4,
		"disabled_source_ids": pctx.DisabledKnowledgeSourceIDs,
	})
	searchResult, err := pctx.DispatchTool(tools.ToolKnowledgeSearch, searchArgs)
	if err != nil || !searchResult.Success {
		return fallback
	}

	var parsed struct {
		Chunks []struct {
			Text       string  `json:"text"`
			SourceName string  `json:"sourceName"`
			Title      string  `json:"title"`
			URL        string  `json:"url"`
			Score      float64 `json:"score"`
		} `json:"chunks"`
	}
	if err := json.Unmarshal(searchResult.Data, &parsed); err != nil || len(parsed.Chunks) == 0 {
		return fallback
	}

	var excerpts strings.Builder
	for i, chunk := range parsed.Chunks {
		fmt.Fprintf(&excerpts, "Excerpt %d\nSource: %s\nTitle: %s\nURL: %s\nText: %s\n\n", i+1, chunk.SourceName, chunk.Title, chunk.URL, chunk.Text)
	}

	prompt := "You prepare safe documentation update proposals for database knowledge sources.\n" +
		"Analyze the current documentation excerpts and the user's request.\n" +
		"Return ONLY valid JSON with fields: as_is, to_be, suggested_text, diff.\n" +
		"Rules:\n" +
		"- Do not claim the change was applied.\n" +
		"- suggested_text must be ready to append to a documentation page after human approval.\n" +
		"- diff must be a concise unified diff-style preview.\n" +
		"- If the request is too vague, propose a small useful documentation note and state what is missing.\n" +
		"- Answer in the same language as the user.\n\n" +
		"User request: " + pctx.UserMessage + "\n" +
		"Database: " + pctx.Database + "\n\n" +
		"Current documentation excerpts:\n" + excerpts.String()

	req := llm.ChatRequest{
		Model: pctx.Model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
		Temperature: floatPtr(0.2),
	}
	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil || len(resp.Choices) == 0 {
		return fallback
	}
	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model

	content := stripCodeFences(stripThinkingTags(strings.TrimSpace(resp.Choices[0].Message.Content)))
	var llmDraft struct {
		AsIs          string `json:"as_is"`
		ToBe          string `json:"to_be"`
		SuggestedText string `json:"suggested_text"`
		Diff          string `json:"diff"`
	}
	if err := json.Unmarshal([]byte(content), &llmDraft); err != nil {
		return fallback
	}
	suggested := strings.TrimSpace(llmDraft.SuggestedText)
	if suggested == "" {
		return fallback
	}
	asIs := strings.TrimSpace(llmDraft.AsIs)
	toBe := strings.TrimSpace(llmDraft.ToBe)
	if asIs != "" || toBe != "" {
		suggested = "As-is:\n" + emptyDash(asIs) + "\n\nTo-be:\n" + emptyDash(toBe) + "\n\n" + suggested
	}
	diff := strings.TrimSpace(llmDraft.Diff)
	if diff == "" {
		diff = fallback.Diff
	}
	return documentationProposalDraft{SuggestedText: suggested, Diff: diff}
}

func (s *IntentDetectionStep) handleDocumentationApply(ctx context.Context, pctx *agent.PipelineContext, proposalID string) error {
	if pctx.ToolDispatcher == nil || !pctx.KnowledgeEnabled {
		message := documentationWriteBackUnavailableMessage(pctx.UserMessage)
		if err := streamStaticAgentText(pctx, message); err != nil {
			return fmt.Errorf("documentation apply response failed: %w", err)
		}
		pctx.Result.Explanation = message
		pctx.SkipRemaining = true
		return nil
	}

	args, _ := json.Marshal(map[string]any{"proposal_id": proposalID})
	result, err := pctx.DispatchTool(tools.ToolKnowledgeApplyUpdate, args)
	if err != nil || !result.Success {
		message := documentationApplyFailedMessage(pctx.UserMessage, toolErrorMessage(result, err))
		if streamErr := streamStaticAgentText(pctx, message); streamErr != nil {
			return fmt.Errorf("documentation apply response failed: %w", streamErr)
		}
		pctx.Result.Explanation = message
		pctx.SkipRemaining = true
		return nil
	}

	var applied struct {
		ProposalID string `json:"proposal_id"`
		Title      string `json:"title"`
		URL        string `json:"url"`
		Version    int    `json:"version"`
		Message    string `json:"message"`
	}
	if err := json.Unmarshal(result.Data, &applied); err != nil {
		return fmt.Errorf("decode documentation apply result: %w", err)
	}

	message := formatDocumentationAppliedMessage(pctx.UserMessage, applied.ProposalID, applied.Title, applied.URL, applied.Version, applied.Message)
	if err := streamStaticAgentText(pctx, message); err != nil {
		return fmt.Errorf("documentation apply response failed: %w", err)
	}
	pctx.Result.Explanation = message
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

func documentationApplyProposalID(message string) (string, bool) {
	msg := strings.ToLower(strings.TrimSpace(message))
	if !strings.Contains(msg, "примен") && !strings.Contains(msg, "apply") {
		return "", false
	}
	parts := strings.Fields(strings.TrimSpace(message))
	for i, part := range parts {
		clean := strings.Trim(part, "`.,:; ")
		if strings.EqualFold(clean, "proposal") && i+1 < len(parts) {
			id := strings.Trim(parts[i+1], "`.,:; ")
			if id != "" {
				return id, true
			}
		}
		if strings.HasPrefix(clean, "kup-") {
			return clean, true
		}
	}
	return "", false
}

func fallbackDocumentationProposalDraft(query, database string) documentationProposalDraft {
	db := strings.TrimSpace(database)
	if db == "" {
		db = "current database"
	}
	suggested := "As-is:\n" +
		"- The documentation needs review for the requested update.\n\n" +
		"To-be:\n" +
		"- Add a reviewed note that explains the requested database rule or schema behavior.\n\n" +
		"Draft update:\n" +
		"- Request: " + query + "\n" +
		"- Database: " + db + "\n" +
		"- Replace this draft with the exact business rule, schema note, or operational detail after review."
	diff := "--- documentation\n+++ documentation\n+\n+## Proposed documentation update\n+Request: " + query + "\n+Database: " + db + "\n+Review and replace this draft before applying."
	return documentationProposalDraft{SuggestedText: suggested, Diff: diff}
}

func emptyDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

func documentationWriteBackUnavailableMessage(message string) string {
	if looksRussian(message) {
		return "Я могу подготовить proposal для обновления базы знаний, но сейчас не вижу подключённый источник знаний для этого чата.\n\n" +
			"Подключи Confluence source к текущей базе, синхронизируй его и включи источник в контексте чата. После этого я смогу подготовить proposal и дать `proposalId` для ручного применения."
	}

	return "I can prepare a knowledge base update proposal, but I don't see an attached knowledge source for this chat.\n\n" +
		"Attach and sync a Confluence source for the current database, then enable it in chat context. After that I can prepare a proposal and return a `proposalId` for manual application."
}

func documentationProposalFailedMessage(message, reason string) string {
	if looksRussian(message) {
		return "Не смог подготовить proposal для базы знаний.\n\nПричина: " + reason
	}
	return "I couldn't prepare a knowledge base update proposal.\n\nReason: " + reason
}

func documentationApplyFailedMessage(message, reason string) string {
	if looksRussian(message) {
		return "Не смог применить proposal к базе знаний.\n\nПричина: " + reason
	}
	return "I couldn't apply the proposal to the knowledge base.\n\nReason: " + reason
}

func formatDocumentationProposalMessage(message, proposalID, sourceName, title, url, suggestedText, diff string, canApply bool, note string) string {
	preview := strings.TrimSpace(suggestedText)
	if len([]rune(preview)) > 2200 {
		runes := []rune(preview)
		preview = string(runes[:2200]) + "\n..."
	}
	if looksRussian(message) {
		applyText := "Для записи сначала включи `Allow manual write-back` у источника знаний."
		if canApply {
			applyText = "Я пока не применил изменения. Проверь diff и нажми кнопку применения в чате, если всё ок."
		}
		return "Подготовил proposal для обновления базы знаний, но не применял его автоматически.\n\n" +
			"**Proposal ID:** `" + proposalID + "`\n" +
			"**Источник:** " + sourceName + "\n" +
			"**Страница:** [" + title + "](" + url + ")\n\n" +
			"**Предлагаемый текст:**\n\n" + preview + "\n\n" +
			"**Preview diff:**\n```diff\n" + diff + "\n```\n\n" +
			applyText + optionalNoteRU(note)
	}

	applyText := "To write it, first enable `Allow manual write-back` for the knowledge source."
	if canApply {
		applyText = "I have not applied the changes yet. Review the diff and use the apply button in chat if it looks right."
	}
	return "I prepared a knowledge base update proposal, but did not apply it automatically.\n\n" +
		"**Proposal ID:** `" + proposalID + "`\n" +
		"**Source:** " + sourceName + "\n" +
		"**Page:** [" + title + "](" + url + ")\n\n" +
		"**Proposed text:**\n\n" + preview + "\n\n" +
		"**Preview diff:**\n```diff\n" + diff + "\n```\n\n" +
		applyText + optionalNoteEN(note)
}

func formatDocumentationAppliedMessage(message, proposalID, title, url string, version int, note string) string {
	if looksRussian(message) {
		return "Готово, применил proposal `" + proposalID + "` к базе знаний.\n\n" +
			"**Страница:** [" + title + "](" + url + ")\n" +
			fmt.Sprintf("**Версия:** `%d`", version) + optionalNoteRU(note)
	}
	return "Done, I applied proposal `" + proposalID + "` to the knowledge base.\n\n" +
		"**Page:** [" + title + "](" + url + ")\n" +
		fmt.Sprintf("**Version:** `%d`", version) + optionalNoteEN(note)
}

func optionalNoteRU(note string) string {
	if strings.TrimSpace(note) == "" {
		return ""
	}
	return "\n\n" + note
}

func optionalNoteEN(note string) string {
	if strings.TrimSpace(note) == "" {
		return ""
	}
	return "\n\n" + note
}

func toolErrorMessage(result *websocket.ToolCallResult, err error) string {
	if err != nil {
		return err.Error()
	}
	if result != nil && result.Error != "" {
		return result.Error
	}
	return "unknown error"
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
