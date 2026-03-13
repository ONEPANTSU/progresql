package agent

import (
	"context"
	"fmt"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// StreamLLM sends a streaming LLM request and forwards each delta chunk
// to the WebSocket client as an agent.stream message.
// It returns the aggregated ChatResponse after the stream completes.
func (pc *PipelineContext) StreamLLM(ctx context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	pc.Logger.Info("starting LLM stream",
		zap.String("model", req.Model),
		zap.Int("messages", len(req.Messages)),
	)

	resp, err := pc.LLMClient.ChatCompletionStream(ctx, req, func(chunk llm.StreamChunk) error {
		// Extract delta content from the first choice.
		if len(chunk.Choices) == 0 {
			return nil
		}
		delta := chunk.Choices[0].Delta.Content
		if delta == "" {
			return nil
		}

		// Send agent.stream envelope to client.
		payload := websocket.AgentStreamPayload{Delta: delta}
		env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentStream, pc.RequestID, "", payload)
		if err != nil {
			return fmt.Errorf("marshal agent.stream: %w", err)
		}

		if err := pc.Session.SendEnvelope(env); err != nil {
			return fmt.Errorf("send agent.stream: %w", err)
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("LLM streaming failed: %w", err)
	}

	pc.AddTokensDetailed(resp.Usage)
	pc.ModelUsed = resp.Model

	pc.Logger.Info("LLM stream completed",
		zap.String("model", resp.Model),
		zap.Int("tokens", resp.Usage.TotalTokens),
	)

	return resp, nil
}
