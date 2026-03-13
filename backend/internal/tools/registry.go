package tools

import (
	"encoding/json"
	"fmt"
	"sync"
)

// Tool name constants.
const (
	ToolListSchemas   = "list_schemas"
	ToolListTables    = "list_tables"
	ToolDescribeTable = "describe_table"
	ToolListIndexes   = "list_indexes"
	ToolExplainQuery  = "explain_query"
	ToolExecuteQuery  = "execute_query"
	ToolListFunctions = "list_functions"
)

// Registry stores definitions for all available tools.
type Registry struct {
	mu    sync.RWMutex
	tools map[string]ToolDefinition
}

// NewRegistry creates a Registry pre-populated with all 7 database tools.
func NewRegistry() *Registry {
	r := &Registry{
		tools: make(map[string]ToolDefinition),
	}
	r.registerDefaults()
	return r
}

// Get returns the ToolDefinition for the given name, or an error if not found.
func (r *Registry) Get(name string) (ToolDefinition, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	td, ok := r.tools[name]
	if !ok {
		return ToolDefinition{}, fmt.Errorf("unknown tool: %s", name)
	}
	return td, nil
}

// Validate checks whether a tool name is registered.
func (r *Registry) Validate(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.tools[name]
	return ok
}

// All returns all registered tool definitions.
func (r *Registry) All() []ToolDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()

	defs := make([]ToolDefinition, 0, len(r.tools))
	for _, td := range r.tools {
		defs = append(defs, td)
	}
	return defs
}

// Register adds or replaces a tool definition.
func (r *Registry) Register(td ToolDefinition) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[td.Name] = td
}

// mustJSON marshals v to json.RawMessage, panicking on error (only used at init).
func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("tools: failed to marshal parameters: %v", err))
	}
	return b
}

// paramSchema is a minimal JSON-Schema-like description of tool parameters.
type paramSchema struct {
	Type       string                `json:"type"`
	Properties map[string]propSchema `json:"properties,omitempty"`
	Required   []string              `json:"required,omitempty"`
}

type propSchema struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

func (r *Registry) registerDefaults() {
	r.tools[ToolListSchemas] = ToolDefinition{
		Name:        ToolListSchemas,
		Description: "List all schemas in the database",
		Parameters: mustJSON(paramSchema{
			Type: "object",
		}),
	}

	r.tools[ToolListTables] = ToolDefinition{
		Name:        ToolListTables,
		Description: "List all tables and views in a schema",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"schema": {Type: "string", Description: "Schema name"},
			},
			Required: []string{"schema"},
		}),
	}

	r.tools[ToolDescribeTable] = ToolDefinition{
		Name:        ToolDescribeTable,
		Description: "Describe a table's columns, indexes, and foreign keys",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"schema": {Type: "string", Description: "Schema name"},
				"table":  {Type: "string", Description: "Table name"},
			},
			Required: []string{"schema", "table"},
		}),
	}

	r.tools[ToolListIndexes] = ToolDefinition{
		Name:        ToolListIndexes,
		Description: "List indexes for a table",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"schema": {Type: "string", Description: "Schema name"},
				"table":  {Type: "string", Description: "Table name"},
			},
			Required: []string{"schema", "table"},
		}),
	}

	r.tools[ToolExplainQuery] = ToolDefinition{
		Name:        ToolExplainQuery,
		Description: "Run EXPLAIN on a SQL query and return the query plan",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"sql": {Type: "string", Description: "SQL query to explain"},
			},
			Required: []string{"sql"},
		}),
	}

	r.tools[ToolExecuteQuery] = ToolDefinition{
		Name:        ToolExecuteQuery,
		Description: "Execute a read-only SQL query (SELECT/EXPLAIN only)",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"sql":   {Type: "string", Description: "SQL query to execute"},
				"limit": {Type: "integer", Description: "Maximum number of rows to return"},
			},
			Required: []string{"sql"},
		}),
	}

	r.tools[ToolListFunctions] = ToolDefinition{
		Name:        ToolListFunctions,
		Description: "List functions and procedures in a schema",
		Parameters: mustJSON(paramSchema{
			Type: "object",
			Properties: map[string]propSchema{
				"schema": {Type: "string", Description: "Schema name"},
			},
			Required: []string{"schema"},
		}),
	}
}
