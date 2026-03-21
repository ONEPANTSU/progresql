package steps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// vizLLMServer returns a mock LLM that responds with the given JSON classification.
func vizLLMServer(t *testing.T, response string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := llm.ChatResponse{
			ID:    "chatcmpl-viz",
			Model: "test-model",
			Choices: []llm.Choice{{
				Index:        0,
				Message:      llm.Message{Role: "assistant", Content: response},
				FinishReason: "stop",
			}},
			Usage: llm.Usage{PromptTokens: 50, CompletionTokens: 20, TotalTokens: 70},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
}

func buildVizContext(t *testing.T, session *websocket.Session, llmClient *llm.Client, userMsg string) *agent.PipelineContext {
	t.Helper()
	pctx := agent.NewPipelineContext()
	pctx.RequestID = "req-viz"
	pctx.Action = "generate_sql"
	pctx.UserMessage = userMsg
	pctx.Model = "test-model"
	pctx.Session = session
	pctx.ToolDispatcher = websocket.NewToolDispatcher(session)
	pctx.LLMClient = llmClient
	pctx.ToolRegistry = tools.NewRegistry()
	pctx.Logger = zap.NewNop()
	return pctx
}

func TestVisualization_BarChart(t *testing.T) {
	vizJSON := `{"chart_type":"bar","title":"Top users by orders","x_label":"user","y_label":"order_count"}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Покажи топ 10 пользователей по заказам")

	// Set query results (simulating AutoExecuteStep output).
	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"user", "order_count"},
		"rows": []map[string]any{
			{"user": "Alice", "order_count": 50},
			{"user": "Bob", "order_count": 30},
			{"user": "Charlie", "order_count": 20},
		},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT u.name AS user, COUNT(*) AS order_count FROM orders o JOIN users u ON o.user_id = u.id GROUP BY u.name ORDER BY order_count DESC LIMIT 10"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization == nil {
		t.Fatal("expected visualization to be set")
	}
	viz := pctx.Result.Visualization
	if viz.ChartType != "bar" {
		t.Errorf("expected chart_type=bar, got %s", viz.ChartType)
	}
	if viz.Title != "Top users by orders" {
		t.Errorf("expected title 'Top users by orders', got '%s'", viz.Title)
	}
	if len(viz.Data) != 3 {
		t.Errorf("expected 3 data points, got %d", len(viz.Data))
	}
	if viz.SQL == "" {
		t.Error("expected SQL to be set on visualization")
	}
	if pctx.TokensUsed != 70 {
		t.Errorf("expected 70 tokens, got %d", pctx.TokensUsed)
	}
}

func TestVisualization_MetricChart(t *testing.T) {
	vizJSON := `{"chart_type":"metric","title":"Всего пользователей","x_label":"","y_label":"count"}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Сколько всего пользователей?")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"count"},
		"rows":    []map[string]any{{"count": 1523}},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT COUNT(*) AS count FROM users"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization == nil {
		t.Fatal("expected visualization to be set")
	}
	if pctx.Result.Visualization.ChartType != "metric" {
		t.Errorf("expected chart_type=metric, got %s", pctx.Result.Visualization.ChartType)
	}
}

func TestVisualization_PieChart(t *testing.T) {
	vizJSON := `{"chart_type":"pie","title":"Orders by status","x_label":"status","y_label":"count"}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Распределение заказов по статусам")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"status", "count"},
		"rows": []map[string]any{
			{"status": "completed", "count": 120},
			{"status": "pending", "count": 45},
			{"status": "cancelled", "count": 15},
		},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT status, COUNT(*) AS count FROM orders GROUP BY status"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization == nil {
		t.Fatal("expected visualization to be set")
	}
	if pctx.Result.Visualization.ChartType != "pie" {
		t.Errorf("expected chart_type=pie, got %s", pctx.Result.Visualization.ChartType)
	}
}

func TestVisualization_LineChart(t *testing.T) {
	vizJSON := `{"chart_type":"line","title":"Revenue over 30 days","x_label":"date","y_label":"revenue"}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Динамика выручки за 30 дней")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"date", "revenue"},
		"rows": []map[string]any{
			{"date": "2026-03-01", "revenue": 1000},
			{"date": "2026-03-02", "revenue": 1200},
			{"date": "2026-03-03", "revenue": 900},
		},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT date_trunc('day', created_at)::date AS date, SUM(amount) AS revenue FROM orders WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization == nil {
		t.Fatal("expected visualization to be set")
	}
	if pctx.Result.Visualization.ChartType != "line" {
		t.Errorf("expected chart_type=line, got %s", pctx.Result.Visualization.ChartType)
	}
}

func TestVisualization_NoneDecision(t *testing.T) {
	vizJSON := `{"chart_type":"none","title":"","x_label":"","y_label":""}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Show me user details for Alice")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"id", "name", "email", "created_at"},
		"rows":    []map[string]any{{"id": 1, "name": "Alice", "email": "alice@test.com", "created_at": "2026-01-01"}},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT * FROM users WHERE name = 'Alice'"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization for non-chart data")
	}
}

func TestVisualization_NoQueryResults(t *testing.T) {
	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "some query")

	// No query result set.
	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization when no query results")
	}
}

func TestVisualization_EmptyRows(t *testing.T) {
	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "some query")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"id"},
		"rows":    []map[string]any{},
	})
	pctx.Result.QueryResult = queryResult

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization for empty rows")
	}
}

func TestVisualization_QueryError(t *testing.T) {
	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "some query")

	queryResult, _ := json.Marshal(map[string]any{
		"error": "relation does not exist",
	})
	pctx.Result.QueryResult = queryResult

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization for query error")
	}
}

func TestVisualization_LLMError(t *testing.T) {
	// LLM returns 500 error.
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Топ пользователей")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"user", "count"},
		"rows":    []map[string]any{{"user": "Alice", "count": 10}},
	})
	pctx.Result.QueryResult = queryResult

	step := &VisualizationStep{}
	// Should NOT return error — LLM failure is non-fatal.
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step should not fail on LLM error: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization on LLM error")
	}
}

func TestVisualization_InvalidLLMResponse(t *testing.T) {
	mockLLM := vizLLMServer(t, "This is not JSON at all")
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Покажи статистику")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"user", "count"},
		"rows":    []map[string]any{{"user": "Alice", "count": 10}},
	})
	pctx.Result.QueryResult = queryResult

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step should not fail on invalid LLM response: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization on invalid LLM response")
	}
}

func TestVisualization_CodeFencedResponse(t *testing.T) {
	vizJSON := "```json\n{\"chart_type\":\"bar\",\"title\":\"Users\",\"x_label\":\"name\",\"y_label\":\"count\"}\n```"
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Top users")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"name", "count"},
		"rows":    []map[string]any{{"name": "Alice", "count": 10}},
	})
	pctx.Result.QueryResult = queryResult
	pctx.Result.SQL = "SELECT name, COUNT(*) FROM users GROUP BY name"

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step failed: %v", err)
	}

	if pctx.Result.Visualization == nil {
		t.Fatal("expected visualization from code-fenced response")
	}
	if pctx.Result.Visualization.ChartType != "bar" {
		t.Errorf("expected bar, got %s", pctx.Result.Visualization.ChartType)
	}
}

func TestVisualization_StepName(t *testing.T) {
	step := &VisualizationStep{}
	if step.Name() != "visualization" {
		t.Errorf("expected name 'visualization', got '%s'", step.Name())
	}
}

func TestVisualization_InvalidChartType(t *testing.T) {
	vizJSON := `{"chart_type":"scatter","title":"Test","x_label":"x","y_label":"y"}`
	mockLLM := vizLLMServer(t, vizJSON)
	defer mockLLM.Close()

	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithBaseURL(mockLLM.URL), llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "Show chart")

	queryResult, _ := json.Marshal(map[string]any{
		"columns": []string{"x", "y"},
		"rows":    []map[string]any{{"x": 1, "y": 2}},
	})
	pctx.Result.QueryResult = queryResult

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step should not fail on invalid chart type: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization for invalid chart_type")
	}
}

func TestVisualization_UnparsableQueryResult(t *testing.T) {
	hub := websocket.NewHub()
	session, _ := wsDialer(t, hub)
	llmClient := llm.NewClient("test-key", llm.WithMaxRetries(0))
	pctx := buildVizContext(t, session, llmClient, "query")

	pctx.Result.QueryResult = json.RawMessage(`not valid json`)

	step := &VisualizationStep{}
	if err := step.Execute(context.Background(), pctx); err != nil {
		t.Fatalf("step should not fail on unparsable result: %v", err)
	}
	if pctx.Result.Visualization != nil {
		t.Error("expected no visualization for unparsable query result")
	}
}

// Ensure time import is used for test setup.
var _ = strings.TrimSpace
