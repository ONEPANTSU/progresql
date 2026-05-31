package tools

import "encoding/json"

// ToolDefinition describes a tool that can be invoked via the WebSocket protocol.
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// --- Argument types for each tool ---

// ListSchemasArgs contains arguments for the list_schemas tool.
type ListSchemasArgs struct{}

// ListTablesArgs contains arguments for the list_tables tool.
type ListTablesArgs struct {
	Schema string `json:"schema"`
}

// DescribeTableArgs contains arguments for the describe_table tool.
type DescribeTableArgs struct {
	Schema string `json:"schema"`
	Table  string `json:"table"`
}

// ListIndexesArgs contains arguments for the list_indexes tool.
type ListIndexesArgs struct {
	Schema string `json:"schema"`
	Table  string `json:"table"`
}

// ExplainQueryArgs contains arguments for the explain_query tool.
type ExplainQueryArgs struct {
	SQL string `json:"sql"`
}

// ExecuteQueryArgs contains arguments for the execute_query tool.
type ExecuteQueryArgs struct {
	SQL   string `json:"sql"`
	Limit int    `json:"limit"`
}

// ListFunctionsArgs contains arguments for the list_functions tool.
type ListFunctionsArgs struct {
	Schema string `json:"schema"`
}

// KnowledgeSearchArgs contains arguments for the knowledge_search tool.
type KnowledgeSearchArgs struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

// --- Result types ---

// ListSchemasResult is the result of list_schemas.
type ListSchemasResult struct {
	Schemas []string `json:"schemas"`
}

// TableEntry describes a table or view.
type TableEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// ListTablesResult is the result of list_tables.
type ListTablesResult struct {
	Tables []TableEntry `json:"tables"`
}

// ColumnInfo describes a table column.
type ColumnInfo struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default,omitempty"`
}

// IndexInfo describes a table index.
type IndexInfo struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
}

// ForeignKeyInfo describes a foreign key constraint.
type ForeignKeyInfo struct {
	Name            string   `json:"name"`
	Columns         []string `json:"columns"`
	ReferencedTable string   `json:"referenced_table"`
	ReferencedCols  []string `json:"referenced_columns"`
}

// DescribeTableResult is the result of describe_table.
type DescribeTableResult struct {
	Columns     []ColumnInfo     `json:"columns"`
	Indexes     []IndexInfo      `json:"indexes"`
	ForeignKeys []ForeignKeyInfo `json:"foreign_keys"`
}

// ListIndexesResult is the result of list_indexes.
type ListIndexesResult struct {
	Indexes []IndexInfo `json:"indexes"`
}

// ExplainQueryResult is the result of explain_query.
type ExplainQueryResult struct {
	Plan  string `json:"plan"`
	Error string `json:"error,omitempty"`
}

// ExecuteQueryResult is the result of execute_query.
type ExecuteQueryResult struct {
	Rows    []map[string]any `json:"rows"`
	Columns []string         `json:"columns"`
	Error   string           `json:"error,omitempty"`
}

// FunctionInfo describes a database function.
type FunctionInfo struct {
	Name       string `json:"name"`
	Args       string `json:"args"`
	ReturnType string `json:"return_type"`
}

// ListFunctionsResult is the result of list_functions.
type ListFunctionsResult struct {
	Functions []FunctionInfo `json:"functions"`
}

// KnowledgeChunk describes a documentation excerpt returned by knowledge_search.
type KnowledgeChunk struct {
	Text       string  `json:"text"`
	Source     string  `json:"source"`
	SourceName string  `json:"sourceName,omitempty"`
	Title      string  `json:"title"`
	URL        string  `json:"url"`
	Score      float64 `json:"score,omitempty"`
}

// KnowledgeSearchResult is the result of knowledge_search.
type KnowledgeSearchResult struct {
	Chunks []KnowledgeChunk `json:"chunks"`
}

// KnowledgeUpdateProposalResult describes a staged documentation update.
type KnowledgeUpdateProposalResult struct {
	ProposalID    string `json:"proposal_id"`
	SourceName    string `json:"source_name"`
	DocumentID    string `json:"document_id"`
	Title         string `json:"title"`
	URL           string `json:"url"`
	Diff          string `json:"diff"`
	TargetHeading string `json:"target_heading,omitempty"`
	CanApply      bool   `json:"can_apply"`
	Message       string `json:"message,omitempty"`
}

// KnowledgeApplyUpdateResult describes an applied documentation update.
type KnowledgeApplyUpdateResult struct {
	ProposalID    string `json:"proposal_id"`
	Title         string `json:"title"`
	URL           string `json:"url"`
	Version       int    `json:"version"`
	EditMode      string `json:"edit_mode,omitempty"`
	TargetHeading string `json:"target_heading,omitempty"`
	Message       string `json:"message,omitempty"`
}
