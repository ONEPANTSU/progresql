package steps

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/agent"
	"github.com/onepantsu/progressql/backend/internal/tools"
)

const (
	ContextKeyVotingResult      = "candidate_execution_voting"
	ContextKeySkipSeedExpansion = "skip_seed_expansion"
)

type VotingResult struct {
	WinnerSQL      string         `json:"winner_sql"`
	WinnerGroupKey string         `json:"winner_group_key"`
	GroupSizes     map[string]int `json:"group_sizes"`
	Consensus      bool           `json:"consensus"`
}

type CandidateExecutionVotingStep struct{}

func (s *CandidateExecutionVotingStep) Name() string { return "candidate_execution_voting" }

func (s *CandidateExecutionVotingStep) Execute(_ context.Context, pctx *agent.PipelineContext) error {
	if pctx.SecurityMode != agent.SecurityModeData {
		pctx.Logger.Info("candidate execution voting skipped: not data mode",
			zap.String("security_mode", pctx.SecurityMode))
		return nil
	}
	val, ok := pctx.Get(ContextKeySQLCandidates)
	if !ok {
		return nil
	}
	candidates, ok := val.([]string)
	if !ok || len(candidates) < 2 {
		return nil
	}

	groups := make(map[string][]string)
	groupSizes := make(map[string]int)
	for _, sql := range candidates {
		args, _ := json.Marshal(map[string]any{"sql": sql, "limit": 100, "security_mode": agent.SecurityModeData})
		result, err := pctx.DispatchTool(tools.ToolExecuteQuery, args)
		if err != nil || !result.Success {
			fields := append(sqlLogFields(sql), zap.Error(err))
			if result != nil {
				fields = append(fields, zap.String("tool_error", result.Error))
			}
			pctx.Logger.Warn("candidate voting execution failed", fields...)
			continue
		}
		signature := resultSignature(result.Data)
		groups[signature] = append(groups[signature], sql)
		groupSizes[signature] = len(groups[signature])
	}

	bestKey := ""
	bestSize := 0
	for key, group := range groups {
		if len(group) > bestSize {
			bestKey = key
			bestSize = len(group)
		}
	}
	if bestSize == 0 {
		return nil
	}

	winner := groups[bestKey][0]
	consensus := bestSize >= 3 || bestSize > len(candidates)/2
	voting := VotingResult{
		WinnerSQL:      winner,
		WinnerGroupKey: bestKey,
		GroupSizes:     groupSizes,
		Consensus:      consensus,
	}
	pctx.Set(ContextKeyVotingResult, voting)
	if consensus {
		pctx.Set(ContextKeySkipSeedExpansion, true)
		pctx.Set(ContextKeySQLCandidates, groups[bestKey])
		pctx.Set(ContextKeySQLCandidate, winner)
		pctx.Result.SQL = winner
		pctx.Result.Candidates = groups[bestKey]
		pctx.Logger.Info("candidate voting consensus reached",
			zap.Int("group_size", bestSize),
			zap.Int("total_candidates", len(candidates)),
			zap.String("signature", bestKey),
		)
	}
	return nil
}

func resultSignature(raw json.RawMessage) string {
	var parsed struct {
		Rows    []map[string]any `json:"rows"`
		Columns []string         `json:"columns"`
	}
	_ = json.Unmarshal(raw, &parsed)
	columns := append([]string(nil), parsed.Columns...)
	sort.Strings(columns)
	rowStrings := make([]string, 0, len(parsed.Rows))
	for _, row := range parsed.Rows {
		keys := make([]string, 0, len(row))
		for key := range row {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var parts []string
		for _, key := range keys {
			parts = append(parts, fmt.Sprintf("%s=%v", key, row[key]))
		}
		rowStrings = append(rowStrings, strings.Join(parts, "|"))
	}
	sort.Strings(rowStrings)
	sum := sha256.Sum256([]byte(strings.Join(columns, ",") + "\n" + strings.Join(rowStrings, "\n")))
	return fmt.Sprintf("%x", sum)[:16]
}
