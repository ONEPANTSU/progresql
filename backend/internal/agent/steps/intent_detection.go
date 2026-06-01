package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

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
	if isDocumentationWriteRequest(msg) || isDocumentationWriteFollowup(msg, pctx.ConversationHistory) {
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
	searchQuery := documentationUpdateSearchQuery(pctx.UserMessage, pctx.Database)
	args, _ := json.Marshal(map[string]any{
		"query":               pctx.UserMessage,
		"search_query":        searchQuery,
		"database":            pctx.Database,
		"disabled_source_ids": pctx.DisabledKnowledgeSourceIDs,
		"suggested_text":      proposalDraft.SuggestedText,
		"diff":                proposalDraft.Diff,
		"target_heading":      proposalDraft.TargetHeading,
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
		TargetHeading string `json:"target_heading"`
		CanApply      bool   `json:"can_apply"`
		Message       string `json:"message"`
	}
	if err := json.Unmarshal(result.Data, &proposal); err != nil {
		return fmt.Errorf("decode documentation proposal: %w", err)
	}

	message := formatDocumentationProposalMessage(pctx.UserMessage, proposal.ProposalID, proposal.SourceName, proposal.Title, proposal.URL, proposal.TargetHeading, proposal.SuggestedText, proposal.Diff, proposal.CanApply, proposal.Message)
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
	TargetHeading string
}

func (s *IntentDetectionStep) buildDocumentationProposalDraft(ctx context.Context, pctx *agent.PipelineContext) documentationProposalDraft {
	schemaSummary := s.collectDocumentationSchemaSummary(pctx)
	fallback := fallbackDocumentationProposalDraft(pctx.UserMessage, pctx.Database, schemaSummary)
	searchArgs, _ := json.Marshal(map[string]any{
		"query":               documentationUpdateSearchQuery(pctx.UserMessage, pctx.Database),
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
		"Return ONLY valid JSON with fields: as_is, to_be, target_heading, suggested_text, diff.\n" +
		"Rules:\n" +
		"- Do not claim the change was applied.\n" +
		"- Use the live PostgreSQL schema summary as the source of truth for tables, columns, keys, indexes, triggers, and constraints.\n" +
		"- Do not invent business rules. If a business rule is missing, say what must be confirmed.\n" +
		"- target_heading must be the existing documentation section heading that should be replaced. Prefer a database/schema documentation heading, not team rules.\n" +
		"- suggested_text must be the full replacement section for target_heading, including its markdown heading.\n" +
		"- suggested_text must contain only the final documentation section, not as-is/to-be analysis.\n" +
		"- diff must be a concise unified diff-style preview between the old section and the replacement section.\n" +
		"- If the request is vague, document the actual schema structure and explicitly list unknown business semantics.\n" +
		"- Answer in the same language as the user.\n\n" +
		"User request: " + pctx.UserMessage + "\n" +
		"Database: " + pctx.Database + "\n\n" +
		"Live PostgreSQL schema summary:\n" + schemaSummary + "\n\n" +
		"Current documentation excerpts:\n" + excerpts.String()

	req := llm.ChatRequest{
		Model: pctx.Model,
		Messages: pctx.MessagesWithHistory(
			llm.Message{Role: "user", Content: prompt},
		),
		Temperature: floatPtr(0.2),
	}
	pctx.EmitTrace("tool", "Preparing documentation update", "", tools.ToolKnowledgeProposeUpdate, "running")
	draftCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	resp, err := pctx.LLMClient.ChatCompletion(draftCtx, req)
	if err != nil || len(resp.Choices) == 0 {
		pctx.EmitTrace("tool", "Preparing documentation update", "Using fallback draft: "+toolErrorFromErr(err), tools.ToolKnowledgeProposeUpdate, "completed")
		return fallback
	}
	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model

	content := stripCodeFences(stripThinkingTags(strings.TrimSpace(resp.Choices[0].Message.Content)))
	var llmDraft struct {
		AsIs          string `json:"as_is"`
		ToBe          string `json:"to_be"`
		TargetHeading string `json:"target_heading"`
		SuggestedText string `json:"suggested_text"`
		Diff          string `json:"diff"`
	}
	if err := json.Unmarshal([]byte(content), &llmDraft); err != nil {
		pctx.EmitTrace("tool", "Preparing documentation update", "Using fallback draft: invalid JSON", tools.ToolKnowledgeProposeUpdate, "completed")
		return fallback
	}
	suggested := strings.TrimSpace(llmDraft.SuggestedText)
	if suggested == "" {
		pctx.EmitTrace("tool", "Preparing documentation update", "Using fallback draft: empty suggested text", tools.ToolKnowledgeProposeUpdate, "completed")
		return fallback
	}
	suggested = stripProposalAnalysisSections(suggested)
	diff := strings.TrimSpace(llmDraft.Diff)
	if diff == "" {
		diff = fallback.Diff
	}
	targetHeading := strings.TrimSpace(llmDraft.TargetHeading)
	if targetHeading == "" {
		targetHeading = firstMarkdownHeading(suggested)
	}
	pctx.EmitTrace("tool", "Preparing documentation update", "", tools.ToolKnowledgeProposeUpdate, "completed")
	return documentationProposalDraft{SuggestedText: suggested, Diff: diff, TargetHeading: targetHeading}
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

func (s *IntentDetectionStep) collectDocumentationSchemaSummary(pctx *agent.PipelineContext) string {
	if pctx.ToolDispatcher == nil {
		return "Schema is unavailable: no local tool dispatcher."
	}

	schemasResult, err := pctx.DispatchTool(tools.ToolListSchemas, json.RawMessage(`{}`))
	if err != nil || !schemasResult.Success {
		if err != nil {
			return "Schema is unavailable: " + err.Error()
		}
		return "Schema is unavailable: " + schemasResult.Error
	}

	schemas := parseSchemaNames(schemasResult.Data)
	if len(schemas) == 0 {
		schemas = []string{"public"}
	}

	const maxTables = 60
	var schemaCtx SchemaContext
	for _, schema := range schemas {
		if len(schemaCtx.Tables) >= maxTables {
			break
		}
		tablesArg, _ := json.Marshal(map[string]string{"schema": schema})
		tablesResult, err := pctx.DispatchTool(tools.ToolListTables, tablesArg)
		if err != nil || !tablesResult.Success {
			continue
		}
		tableNames, err := parseTableNames(tablesResult.Data)
		if err != nil {
			continue
		}
		for _, tableName := range tableNames {
			if len(schemaCtx.Tables) >= maxTables {
				break
			}
			descArg, _ := json.Marshal(map[string]string{"schema": schema, "table": tableName})
			descResult, err := pctx.DispatchTool(tools.ToolDescribeTable, descArg)
			if err != nil || !descResult.Success {
				continue
			}
			schemaCtx.Tables = append(schemaCtx.Tables, TableInfo{
				Schema:  schema,
				Table:   tableName,
				Details: descResult.Data,
			})
		}
	}

	if len(schemaCtx.Tables) == 0 {
		return "Schema has no described tables."
	}
	return buildSchemaDescription(&schemaCtx)
}

func documentationUpdateSearchQuery(message, database string) string {
	db := strings.TrimSpace(database)
	parts := []string{"database schema documentation tables columns relationships indexes triggers constraints entities"}
	if db != "" {
		parts = append(parts, db)
	}
	msg := strings.TrimSpace(message)
	if msg != "" {
		parts = append(parts, msg)
	}
	return strings.Join(parts, " ")
}

func stripProposalAnalysisSections(value string) string {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	markers := []string{"draft update:", "обновление документации", "## обновление документации", "## database schema", "## database documentation"}
	if strings.HasPrefix(lower, "as-is:") || strings.HasPrefix(lower, "as is:") || strings.HasPrefix(lower, "как есть:") {
		for _, marker := range markers {
			if idx := strings.Index(lower, marker); idx > 0 {
				return strings.TrimSpace(trimmed[idx:])
			}
		}
	}
	return trimmed
}

func isDocumentationWriteRequest(message string) bool {
	msg := strings.ToLower(strings.TrimSpace(message))
	if msg == "" {
		return false
	}

	hasWriteVerb := strings.Contains(msg, "актуализ") ||
		strings.Contains(msg, "добав") ||
		strings.Contains(msg, "обнов") ||
		strings.Contains(msg, "запиш") ||
		strings.Contains(msg, "запис") ||
		strings.Contains(msg, "дополни") ||
		strings.Contains(msg, "дополн") ||
		strings.Contains(msg, "write") ||
		strings.Contains(msg, "update") ||
		strings.Contains(msg, "add") ||
		strings.Contains(msg, "extend") ||
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

func isDocumentationWriteFollowup(message string, history []llm.Message) bool {
	msg := strings.ToLower(strings.TrimSpace(message))
	if msg == "" {
		return false
	}
	hasWriteVerb := strings.Contains(msg, "добав") ||
		strings.Contains(msg, "дополни") ||
		strings.Contains(msg, "дополн") ||
		strings.Contains(msg, "исправ") ||
		strings.Contains(msg, "перепиш") ||
		strings.Contains(msg, "опиши") ||
		strings.Contains(msg, "add") ||
		strings.Contains(msg, "extend") ||
		strings.Contains(msg, "rewrite") ||
		strings.Contains(msg, "describe")
	hasDocSubject := strings.Contains(msg, "таблиц") ||
		strings.Contains(msg, "сущност") ||
		strings.Contains(msg, "колон") ||
		strings.Contains(msg, "схем") ||
		strings.Contains(msg, "trigger") ||
		strings.Contains(msg, "триггер") ||
		strings.Contains(msg, "table") ||
		strings.Contains(msg, "entity") ||
		strings.Contains(msg, "schema") ||
		strings.Contains(msg, "column")
	if !hasWriteVerb || !hasDocSubject {
		return false
	}
	for i := len(history) - 1; i >= 0 && i >= len(history)-6; i-- {
		content := strings.ToLower(history[i].Content)
		if strings.Contains(content, "knowledge-proposal:") ||
			strings.Contains(content, "базу знаний") ||
			strings.Contains(content, "база знаний") ||
			strings.Contains(content, "knowledge base") ||
			strings.Contains(content, "документац") ||
			strings.Contains(content, "documentation") {
			return true
		}
	}
	return false
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

func fallbackDocumentationProposalDraft(query, database, schemaSummary string) documentationProposalDraft {
	db := strings.TrimSpace(database)
	if db == "" {
		db = "current database"
	}
	targetHeading := "Database schema documentation"
	suggested := buildSchemaDocumentationFallback(db, schemaSummary)
	diff := "--- documentation\n+++ documentation\n+\n" + diffLinesFromMarkdown(suggested, 80)
	return documentationProposalDraft{SuggestedText: suggested, Diff: diff, TargetHeading: targetHeading}
}

func buildSchemaDocumentationFallback(database, schemaSummary string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "## Database schema documentation\n\n")
	fmt.Fprintf(&b, "**Database:** `%s`\n\n", database)
	b.WriteString("### Tables and entities\n\n")
	tables := parseTablesFromSchemaSummary(schemaSummary)
	if len(tables) == 0 {
		b.WriteString("- Schema details are unavailable. Sync or connect the database and regenerate this proposal.\n")
		return b.String()
	}
	for _, table := range tables {
		fmt.Fprintf(&b, "#### `%s`\n\n", table.Name)
		b.WriteString("Purpose: _Confirm the business meaning before publishing._\n\n")
		if len(table.Columns) > 0 {
			b.WriteString("Columns:\n")
			for _, column := range table.Columns {
				fmt.Fprintf(&b, "- `%s`", column.Name)
				if column.Type != "" {
					fmt.Fprintf(&b, " (%s)", column.Type)
				}
				if !column.Nullable {
					b.WriteString(", required")
				}
				if column.Default != "" {
					fmt.Fprintf(&b, ", default `%s`", column.Default)
				}
				b.WriteString(" — _Describe business meaning._\n")
			}
			b.WriteString("\n")
		}
		if len(table.Indexes) > 0 {
			b.WriteString("Indexes:\n")
			for _, index := range table.Indexes {
				fmt.Fprintf(&b, "- `%s`", index.Name)
				if len(index.Columns) > 0 {
					fmt.Fprintf(&b, " on `%s`", strings.Join(index.Columns, "`, `"))
				}
				if index.Unique {
					b.WriteString(" (unique)")
				}
				b.WriteString("\n")
			}
			b.WriteString("\n")
		}
		if len(table.ForeignKeys) > 0 {
			b.WriteString("Relationships:\n")
			for _, fk := range table.ForeignKeys {
				fmt.Fprintf(&b, "- `%s` references `%s`\n", fk.Name, fk.ReferencedTable)
			}
			b.WriteString("\n")
		}
	}
	b.WriteString("### Notes requiring confirmation\n\n")
	b.WriteString("- Business rules, statuses, lifecycle definitions, and ownership semantics are not fully visible from the schema and must be confirmed by the team.\n")
	return b.String()
}

type fallbackTableDoc struct {
	Name        string
	Columns     []fallbackColumnDoc
	Indexes     []fallbackIndexDoc
	ForeignKeys []fallbackForeignKeyDoc
}

type fallbackColumnDoc struct {
	Name     string
	Type     string
	Nullable bool
	Default  string
}

type fallbackIndexDoc struct {
	Name    string
	Columns []string
	Unique  bool
}

type fallbackForeignKeyDoc struct {
	Name            string
	ReferencedTable string
}

func parseTablesFromSchemaSummary(schemaSummary string) []fallbackTableDoc {
	blocks := strings.Split(schemaSummary, "\n\n")
	tables := make([]fallbackTableDoc, 0)
	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) == 0 || !strings.HasPrefix(lines[0], "Table: ") {
			continue
		}
		table := fallbackTableDoc{Name: strings.TrimSpace(strings.TrimPrefix(lines[0], "Table: "))}
		table.Columns = parseFallbackColumns(extractSchemaSummaryJSON(block, "Columns"))
		table.Indexes = parseFallbackIndexes(extractSchemaSummaryJSON(block, "Indexes"))
		table.ForeignKeys = parseFallbackForeignKeys(extractSchemaSummaryJSON(block, "Foreign Keys"))
		tables = append(tables, table)
	}
	return tables
}

func extractSchemaSummaryJSON(block, label string) string {
	prefix := "  " + label + ": "
	start := strings.Index(block, prefix)
	if start < 0 {
		return ""
	}
	start += len(prefix)
	rest := block[start:]
	next := len(rest)
	for _, marker := range []string{
		"\n  Columns: ",
		"\n  Indexes: ",
		"\n  Foreign Keys: ",
		"\n  CHECK Constraints",
		"\n  Triggers: ",
		"\n  Key Constraints",
		"\n  ENUM Columns",
	} {
		if idx := strings.Index(rest, marker); idx >= 0 && idx < next {
			next = idx
		}
	}
	return strings.TrimSpace(rest[:next])
}

func parseFallbackColumns(raw string) []fallbackColumnDoc {
	var rows []struct {
		Name     string  `json:"name"`
		Type     string  `json:"type"`
		Nullable bool    `json:"nullable"`
		Default  *string `json:"default"`
	}
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	out := make([]fallbackColumnDoc, 0, len(rows))
	for _, row := range rows {
		def := ""
		if row.Default != nil {
			def = *row.Default
		}
		out = append(out, fallbackColumnDoc{Name: row.Name, Type: row.Type, Nullable: row.Nullable, Default: def})
	}
	return out
}

func parseFallbackIndexes(raw string) []fallbackIndexDoc {
	var rows []struct {
		Name    string   `json:"name"`
		Columns []string `json:"columns"`
		Unique  bool     `json:"unique"`
	}
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	out := make([]fallbackIndexDoc, 0, len(rows))
	for _, row := range rows {
		out = append(out, fallbackIndexDoc{Name: row.Name, Columns: row.Columns, Unique: row.Unique})
	}
	return out
}

func parseFallbackForeignKeys(raw string) []fallbackForeignKeyDoc {
	var rows []struct {
		Name            string `json:"name"`
		ReferencedTable string `json:"referenced_table"`
	}
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	out := make([]fallbackForeignKeyDoc, 0, len(rows))
	for _, row := range rows {
		out = append(out, fallbackForeignKeyDoc{Name: row.Name, ReferencedTable: row.ReferencedTable})
	}
	return out
}

func diffLinesFromMarkdown(markdown string, maxLines int) string {
	lines := strings.Split(strings.TrimSpace(markdown), "\n")
	if maxLines > 0 && len(lines) > maxLines {
		lines = append(lines[:maxLines], "...")
	}
	for i, line := range lines {
		lines[i] = "+" + line
	}
	return strings.Join(lines, "\n")
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

func formatDocumentationProposalMessage(message, proposalID, sourceName, title, url, targetHeading, suggestedText, diff string, canApply bool, note string) string {
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
		return "<!-- knowledge-proposal:" + proposalID + " -->\n" +
			"Подготовил обновление базы знаний. Автоматически не применял.\n\n" +
			"**Страница:** [" + title + "](" + url + ")\n\n" +
			optionalTargetHeadingRU(targetHeading) +
			"**Предлагаемый текст:**\n\n" + preview + "\n\n" +
			"**Что изменится:**\n```diff\n" + readableDiffPreview(diff) + "\n```\n\n" +
			applyText + optionalNoteRU(note)
	}

	applyText := "To write it, first enable `Allow manual write-back` for the knowledge source."
	if canApply {
		applyText = "I have not applied the changes yet. Review the diff and use the apply button in chat if it looks right."
	}
	return "<!-- knowledge-proposal:" + proposalID + " -->\n" +
		"I prepared a knowledge base update. I did not apply it automatically.\n\n" +
		"**Page:** [" + title + "](" + url + ")\n\n" +
		optionalTargetHeadingEN(targetHeading) +
		"**Proposed text:**\n\n" + preview + "\n\n" +
		"**What will change:**\n```diff\n" + readableDiffPreview(diff) + "\n```\n\n" +
		applyText + optionalNoteEN(note)
}

func optionalTargetHeadingRU(heading string) string {
	heading = strings.TrimSpace(heading)
	if heading == "" {
		return ""
	}
	return "**Раздел:** `" + heading + "`\n\n"
}

func optionalTargetHeadingEN(heading string) string {
	heading = strings.TrimSpace(heading)
	if heading == "" {
		return ""
	}
	return "**Section:** `" + heading + "`\n\n"
}

func readableDiffPreview(diff string) string {
	lines := strings.Split(strings.TrimSpace(diff), "\n")
	var out []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "---") || strings.HasPrefix(trimmed, "+++") || strings.HasPrefix(trimmed, "@@") {
			continue
		}
		if strings.HasPrefix(trimmed, "+") && !strings.HasPrefix(trimmed, "++") {
			value := strings.TrimSpace(strings.TrimPrefix(trimmed, "+"))
			if value != "" {
				out = append(out, "+ "+value)
			}
			continue
		}
		if strings.HasPrefix(trimmed, "-") && !strings.HasPrefix(trimmed, "--") {
			value := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
			if value != "" {
				out = append(out, "- "+value)
			}
		}
	}
	if len(out) == 0 {
		return strings.TrimSpace(diff)
	}
	if len(out) > 80 {
		out = append(out[:80], "...")
	}
	return strings.Join(out, "\n")
}

func formatDocumentationAppliedMessage(message, proposalID, title, url string, version int, note string) string {
	if looksRussian(message) {
		return "Готово, применил обновление к базе знаний.\n\n" +
			"**Страница:** [" + title + "](" + url + ")\n" +
			fmt.Sprintf("**Версия:** `%d`", version) + optionalNoteRU(note)
	}
	return "Done, I applied the update to the knowledge base.\n\n" +
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

func firstMarkdownHeading(markdown string) string {
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") {
			continue
		}
		heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
		if heading != "" {
			return heading
		}
	}
	return ""
}

func toolErrorFromErr(err error) string {
	if err == nil {
		return "empty response"
	}
	return err.Error()
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
