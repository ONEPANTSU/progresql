package steps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// VisualizationStep analyzes query results and user intent to produce
// a chart visualization when appropriate. It runs after AutoExecuteStep.
type VisualizationStep struct{}

func (s *VisualizationStep) Name() string { return "visualization" }

func (s *VisualizationStep) Execute(ctx context.Context, pctx *agent.PipelineContext) error {
	// No query results — nothing to visualize.
	if len(pctx.Result.QueryResult) == 0 {
		pctx.Logger.Info("visualization skipped: no query results")
		return nil
	}

	// Parse the query result to check if it has data rows.
	var queryData struct {
		Rows    []map[string]interface{} `json:"rows"`
		Columns []string                `json:"columns"`
		Error   string                  `json:"error"`
	}
	if err := json.Unmarshal(pctx.Result.QueryResult, &queryData); err != nil {
		pctx.Logger.Info("visualization skipped: cannot parse query result", zap.Error(err))
		return nil
	}
	if queryData.Error != "" || len(queryData.Rows) == 0 {
		pctx.Logger.Info("visualization skipped: query error or empty results")
		return nil
	}

	// Ask LLM to decide if visualization is appropriate and choose chart type.
	vizConfig, err := s.classifyVisualization(ctx, pctx, queryData.Rows, queryData.Columns)
	if err != nil {
		pctx.Logger.Warn("visualization classification failed", zap.Error(err))
		return nil // Non-fatal: skip visualization.
	}

	if vizConfig == nil || vizConfig.ChartType == "none" {
		pctx.Logger.Info("visualization skipped: LLM decided no chart needed")
		return nil
	}

	// Build the Visualization struct.
	viz := &websocket.Visualization{
		ChartType: vizConfig.ChartType,
		Title:     vizConfig.Title,
		Data:      queryData.Rows,
		XLabel:    vizConfig.XLabel,
		YLabel:    vizConfig.YLabel,
		SQL:       pctx.Result.SQL,
	}

	pctx.Result.Visualization = viz
	pctx.Logger.Info("visualization generated",
		zap.String("chart_type", viz.ChartType),
		zap.String("title", viz.Title),
		zap.Int("data_points", len(viz.Data)),
	)

	return nil
}

// vizClassification is the LLM's structured response for chart type selection.
type vizClassification struct {
	ChartType string `json:"chart_type"`
	Title     string `json:"title"`
	XLabel    string `json:"x_label"`
	YLabel    string `json:"y_label"`
}

// classifyVisualization asks the LLM whether a visualization is appropriate
// and which chart type to use based on the user's message and query results.
func (s *VisualizationStep) classifyVisualization(
	ctx context.Context,
	pctx *agent.PipelineContext,
	rows []map[string]interface{},
	columns []string,
) (*vizClassification, error) {
	// Truncate rows for prompt (avoid token overflow).
	sampleRows := rows
	if len(sampleRows) > 10 {
		sampleRows = sampleRows[:10]
	}
	sampleJSON, _ := json.Marshal(sampleRows)
	sampleStr := string(sampleJSON)
	if len(sampleStr) > 2000 {
		sampleStr = sampleStr[:2000] + "..."
	}

	prompt := fmt.Sprintf(`You are a data visualization expert. Analyze the user's question and query results to decide if a chart visualization would be helpful.

User question: %s

SQL query: %s

Columns: %s
Total rows: %d
Sample data (first %d rows): %s

RULES:
1. Return a JSON object with: chart_type, title, x_label, y_label
2. chart_type must be one of: "bar", "line", "pie", "area", "metric", "none"
3. Use "none" if the data is NOT suitable for visualization (e.g., single text result, schema info, etc.)
4. Choose chart type based on data shape:
   - "metric": single numeric value (1 row, 1 numeric column) — e.g., COUNT(*), SUM, AVG
   - "bar": categorical comparison (names/categories with numeric values) — e.g., top N, group by
   - "line": time series or sequential data (dates/timestamps with numeric values)
   - "area": same as line but for cumulative/stacked data
   - "pie": distribution/proportions (categories with counts/percentages, ideally ≤10 categories)
   - "none": text data, schema descriptions, single row with many columns, etc.
5. title should be concise and describe the chart content
6. x_label and y_label should match the data columns
7. Respond ONLY with the JSON object, no other text

IMPORTANT: Respond in the same language as the user's message for the title field.`,
		pctx.UserMessage,
		pctx.Result.SQL,
		strings.Join(columns, ", "),
		len(rows),
		len(sampleRows),
		sampleStr,
	)

	req := llm.ChatRequest{
		Model: pctx.Model,
		Messages: []llm.Message{
			{Role: "user", Content: prompt},
		},
	}

	resp, err := pctx.LLMClient.ChatCompletion(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("LLM classification failed: %w", err)
	}

	pctx.AddTokensDetailed(resp.Usage)
	pctx.ModelUsed = resp.Model

	if len(resp.Choices) == 0 || resp.Choices[0].Message.Content == "" {
		return nil, fmt.Errorf("empty LLM response")
	}

	content := resp.Choices[0].Message.Content
	content = stripCodeFences(content)
	content = strings.TrimSpace(content)

	var result vizClassification
	if err := json.Unmarshal([]byte(content), &result); err != nil {
		pctx.Logger.Warn("failed to parse visualization classification",
			zap.String("raw_response", content),
			zap.Error(err),
		)
		return nil, fmt.Errorf("failed to parse LLM response: %w", err)
	}

	// Validate chart type.
	switch result.ChartType {
	case websocket.ChartTypeBar, websocket.ChartTypeLine, websocket.ChartTypePie,
		websocket.ChartTypeArea, websocket.ChartTypeMetric, "none":
		// Valid.
	default:
		pctx.Logger.Warn("invalid chart_type from LLM", zap.String("chart_type", result.ChartType))
		return nil, fmt.Errorf("invalid chart_type: %s", result.ChartType)
	}

	return &result, nil
}
