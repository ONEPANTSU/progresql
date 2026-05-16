package steps

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

const ContextKeyCandidateStatuses = "candidate_statuses"

type CandidateStatus struct {
	SQL          string `json:"sql"`
	Valid        bool   `json:"valid"`
	Stage        string `json:"stage"`
	Error        string `json:"error,omitempty"`
	SyntaxOK     bool   `json:"syntax_ok"`
	SecurityOK   bool   `json:"security_ok"`
	ExplainOK    bool   `json:"explain_ok"`
	Repaired     bool   `json:"repaired"`
	RepairReason string `json:"repair_reason,omitempty"`
}

var placeholderPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\{\{[^}]+\}\}`),
	regexp.MustCompile(`<[^>\s]+>`),
	regexp.MustCompile(`:[A-Za-z_][A-Za-z0-9_]*`),
}

func postprocessCandidateSQL(raw string, schemaCtx *SchemaContext) (string, CandidateStatus) {
	sql := strings.TrimSpace(raw)
	sql = stripThinkingTags(sql)
	sql = stripCodeFences(sql)
	sql = strings.TrimRight(sql, "; \n\t")
	sql = strings.TrimSpace(sql)

	status := CandidateStatus{SQL: sql, Valid: true, Stage: "postprocess"}
	if sql == "" {
		status.Valid = false
		status.Error = "empty SQL candidate"
		return "", status
	}

	if placeholder := findUnresolvedPlaceholder(sql); placeholder != "" {
		status.Valid = false
		status.Error = fmt.Sprintf("unresolved placeholder %q", placeholder)
		return sql, status
	}

	if schemaCtx != nil {
		repaired, changed, reason := repairSchemaNames(sql, schemaCtx)
		if changed {
			sql = repaired
			status.SQL = repaired
			status.Repaired = true
			status.RepairReason = reason
		}
	}

	if err := ValidateSQLSyntax(sql); err != nil {
		status.Valid = false
		status.Error = err.Error()
		return sql, status
	}
	status.SyntaxOK = true
	status.SQL = sql
	return sql, status
}

func findUnresolvedPlaceholder(sql string) string {
	sanitized := maskSQLLiteralsCommentsAndQuotedIdentifiers(sql)
	for _, pattern := range placeholderPatterns {
		if loc := pattern.FindStringIndex(sanitized); loc != nil {
			match := sanitized[loc[0]:loc[1]]
			if strings.HasPrefix(match, ":") && loc[0] > 0 && sanitized[loc[0]-1] == ':' {
				continue
			}
			return strings.TrimSpace(match)
		}
	}
	return ""
}

func ValidateSQLSyntax(sql string) error {
	trimmed := strings.TrimSpace(sql)
	if trimmed == "" {
		return fmt.Errorf("empty SQL")
	}
	if err := balancedDelimiters(trimmed); err != nil {
		return err
	}
	first := strings.ToUpper(firstSQLCommand(trimmed))
	if first == "" {
		return fmt.Errorf("missing SQL command")
	}
	if first == "SELECT" && regexp.MustCompile(`(?i)\bSELECT\s+FROM\b`).MatchString(maskSQLLiteralsCommentsAndQuotedIdentifiers(trimmed)) {
		return fmt.Errorf("invalid SELECT syntax: missing select list")
	}
	return nil
}

func balancedDelimiters(sql string) error {
	sanitized := maskSQLLiteralsCommentsAndQuotedIdentifiers(sql)
	depth := 0
	for _, r := range sanitized {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return fmt.Errorf("unbalanced parentheses")
			}
		}
	}
	if depth != 0 {
		return fmt.Errorf("unbalanced parentheses")
	}
	return nil
}

func maskSQLLiteralsCommentsAndQuotedIdentifiers(sql string) string {
	var out strings.Builder
	out.Grow(len(sql))
	for i := 0; i < len(sql); i++ {
		ch := sql[i]
		if ch == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			out.WriteString("  ")
			i += 2
			for i < len(sql) && sql[i] != '\n' {
				out.WriteByte(' ')
				i++
			}
			if i < len(sql) {
				out.WriteByte('\n')
			}
			continue
		}
		if ch == '/' && i+1 < len(sql) && sql[i+1] == '*' {
			out.WriteString("  ")
			i += 2
			for i < len(sql) {
				if sql[i] == '*' && i+1 < len(sql) && sql[i+1] == '/' {
					out.WriteString("  ")
					i++
					break
				}
				if sql[i] == '\n' {
					out.WriteByte('\n')
				} else {
					out.WriteByte(' ')
				}
				i++
			}
			continue
		}
		if ch == '\'' || ch == '"' {
			quote := ch
			out.WriteByte(' ')
			for i++; i < len(sql); i++ {
				out.WriteByte(' ')
				if sql[i] == quote {
					if i+1 < len(sql) && sql[i+1] == quote {
						i++
						out.WriteByte(' ')
						continue
					}
					break
				}
			}
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func repairSchemaNames(sql string, schemaCtx *SchemaContext) (string, bool, string) {
	tables, columns, schemas := schemaIdentifierSets(schemaCtx)
	if len(tables) == 0 && len(columns) == 0 {
		return sql, false, ""
	}

	tokens := sqlTokens(sql)
	scope := buildSQLRepairScope(tokens, schemaCtx)
	var out strings.Builder
	changed := false
	var reasons []string
	for i, token := range tokens {
		replacement := token.text
		if token.kind == tokenWord {
			upper := strings.ToUpper(token.text)
			prevIdx := previousNonSpaceIndex(tokens, i-1)
			if prevIdx >= 0 && tokens[prevIdx].text == "." {
				prev := previousWord(tokens, prevIdx)
				prevLower := strings.ToLower(prev)
				if schemas[prevLower] && isSchemaQualifiedTableReference(tokens, i) {
					if nearest, ok := nearestIdentifier(token.text, tables); ok && nearest != token.text {
						replacement = nearest
						changed = true
						reasons = append(reasons, token.text+"->"+nearest)
					}
				} else if scope.qualifiers[prevLower] {
					if nearest, ok := nearestIdentifier(token.text, columns); ok && nearest != token.text {
						replacement = nearest
						changed = true
						reasons = append(reasons, token.text+"->"+nearest)
					}
				}
			} else if tableReferenceKeywords[previousWord(tokens, i)] && !sqlKeywords[upper] && !scope.ctes[strings.ToLower(token.text)] && !isSchemaQualifier(tokens, i, schemas) {
				if nearest, ok := nearestIdentifier(token.text, tables); ok && nearest != token.text {
					replacement = nearest
					changed = true
					reasons = append(reasons, token.text+"->"+nearest)
				}
			}
		}
		out.WriteString(replacement)
	}
	return out.String(), changed, strings.Join(reasons, ", ")
}

type sqlRepairScope struct {
	qualifiers map[string]bool
	ctes       map[string]bool
}

func buildSQLRepairScope(tokens []sqlToken, schemaCtx *SchemaContext) sqlRepairScope {
	scope := sqlRepairScope{
		qualifiers: make(map[string]bool),
		ctes:       make(map[string]bool),
	}
	if schemaCtx != nil {
		for _, table := range schemaCtx.Tables {
			if table.Table != "" {
				scope.qualifiers[strings.ToLower(table.Table)] = true
			}
		}
	}
	collectCTENames(tokens, scope.ctes)
	collectTableAliases(tokens, scope.qualifiers)
	return scope
}

func collectCTENames(tokens []sqlToken, ctes map[string]bool) {
	inWith := false
	expectName := false
	depth := 0
	for i, token := range tokens {
		if token.text == "(" {
			depth++
			continue
		}
		if token.text == ")" {
			if depth > 0 {
				depth--
			}
			continue
		}
		if token.kind == tokenWord {
			upper := strings.ToUpper(token.text)
			if upper == "WITH" {
				inWith = true
				expectName = true
				continue
			}
			if !inWith {
				continue
			}
			if depth == 0 && upper == "SELECT" {
				return
			}
			if depth == 0 && expectName {
				ctes[strings.ToLower(token.text)] = true
				expectName = false
				continue
			}
		}
		if inWith && depth == 0 && token.text == "," && i > 0 {
			expectName = true
		}
	}
}

func collectTableAliases(tokens []sqlToken, qualifiers map[string]bool) {
	for i, token := range tokens {
		if token.kind != tokenWord || !tableReferenceKeywords[strings.ToUpper(token.text)] {
			continue
		}
		tableIdx := nextNonSpaceIndex(tokens, i+1)
		if tableIdx < 0 || tokens[tableIdx].kind != tokenWord {
			continue
		}
		endIdx := tableIdx
		if dotIdx := nextNonSpaceIndex(tokens, tableIdx+1); dotIdx >= 0 && tokens[dotIdx].text == "." {
			if nameIdx := nextNonSpaceIndex(tokens, dotIdx+1); nameIdx >= 0 && tokens[nameIdx].kind == tokenWord {
				endIdx = nameIdx
			}
		}
		qualifiers[strings.ToLower(tokens[endIdx].text)] = true

		aliasIdx := nextNonSpaceIndex(tokens, endIdx+1)
		if aliasIdx >= 0 && tokens[aliasIdx].kind == tokenWord && strings.ToUpper(tokens[aliasIdx].text) == "AS" {
			aliasIdx = nextNonSpaceIndex(tokens, aliasIdx+1)
		}
		if aliasIdx >= 0 && tokens[aliasIdx].kind == tokenWord {
			upperAlias := strings.ToUpper(tokens[aliasIdx].text)
			if !sqlKeywords[upperAlias] && !joinClauseKeywords[upperAlias] {
				qualifiers[strings.ToLower(tokens[aliasIdx].text)] = true
			}
		}
	}
}

func isSchemaQualifiedTableReference(tokens []sqlToken, idx int) bool {
	dotIdx := previousNonSpaceIndex(tokens, idx-1)
	if dotIdx < 0 || tokens[dotIdx].text != "." {
		return false
	}
	schemaIdx := previousWordIndex(tokens, dotIdx)
	if schemaIdx < 0 {
		return false
	}
	return tableReferenceKeywords[previousWord(tokens, schemaIdx)]
}

func isSchemaQualifier(tokens []sqlToken, idx int, schemas map[string]bool) bool {
	if !schemas[strings.ToLower(tokens[idx].text)] {
		return false
	}
	dotIdx := nextNonSpaceIndex(tokens, idx+1)
	return dotIdx >= 0 && tokens[dotIdx].text == "."
}

func previousWord(tokens []sqlToken, idx int) string {
	wordIdx := previousWordIndex(tokens, idx)
	if wordIdx < 0 {
		return ""
	}
	return strings.ToUpper(tokens[wordIdx].text)
}

func previousWordIndex(tokens []sqlToken, idx int) int {
	for i := idx - 1; i >= 0; i-- {
		if tokens[i].kind == tokenWord {
			return i
		}
		if strings.TrimSpace(tokens[i].text) != "" {
			return -1
		}
	}
	return -1
}

func previousNonSpaceIndex(tokens []sqlToken, idx int) int {
	for i := idx; i >= 0; i-- {
		if strings.TrimSpace(tokens[i].text) != "" {
			return i
		}
	}
	return -1
}

func nextNonSpaceIndex(tokens []sqlToken, idx int) int {
	for i := idx; i < len(tokens); i++ {
		if strings.TrimSpace(tokens[i].text) != "" {
			return i
		}
	}
	return -1
}

var tableReferenceKeywords = map[string]bool{"FROM": true, "JOIN": true, "UPDATE": true, "INTO": true}

var joinClauseKeywords = map[string]bool{
	"ON": true, "USING": true, "WHERE": true, "JOIN": true, "LEFT": true, "RIGHT": true,
	"INNER": true, "OUTER": true, "FULL": true, "CROSS": true, "GROUP": true, "ORDER": true,
	"LIMIT": true, "OFFSET": true, "UNION": true,
}

func schemaIdentifierSets(schemaCtx *SchemaContext) (map[string]string, map[string]string, map[string]bool) {
	tables := make(map[string]string)
	columns := make(map[string]string)
	schemas := make(map[string]bool)
	for _, table := range schemaCtx.Tables {
		if table.Schema != "" {
			schemas[strings.ToLower(table.Schema)] = true
		}
		tables[strings.ToLower(table.Table)] = table.Table
		tables[strings.ToLower(table.Schema+"."+table.Table)] = table.Schema + "." + table.Table
		var details struct {
			Columns []any `json:"columns"`
		}
		if err := json.Unmarshal(table.Details, &details); err == nil {
			for _, raw := range details.Columns {
				switch col := raw.(type) {
				case string:
					columns[strings.ToLower(col)] = col
				case map[string]any:
					for _, key := range []string{"name", "column_name"} {
						if v, ok := col[key].(string); ok && v != "" {
							columns[strings.ToLower(v)] = v
						}
					}
				}
			}
		}
	}
	return tables, columns, schemas
}

type tokenKind int

const (
	tokenOther tokenKind = iota
	tokenWord
)

type sqlToken struct {
	text string
	kind tokenKind
}

func sqlTokens(sql string) []sqlToken {
	var tokens []sqlToken
	for i := 0; i < len(sql); {
		ch := rune(sql[i])
		if unicode.IsLetter(ch) || ch == '_' {
			start := i
			i++
			for i < len(sql) {
				r := rune(sql[i])
				if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
					break
				}
				i++
			}
			tokens = append(tokens, sqlToken{text: sql[start:i], kind: tokenWord})
			continue
		}
		if sql[i] == '\'' || sql[i] == '"' {
			start := i
			quote := sql[i]
			i++
			for i < len(sql) {
				if sql[i] == quote {
					i++
					if i < len(sql) && sql[i] == quote {
						i++
						continue
					}
					break
				}
				i++
			}
			tokens = append(tokens, sqlToken{text: sql[start:i], kind: tokenOther})
			continue
		}
		tokens = append(tokens, sqlToken{text: string(sql[i]), kind: tokenOther})
		i++
	}
	return tokens
}

func nearestIdentifier(word string, allowed map[string]string) (string, bool) {
	lower := strings.ToLower(word)
	if exact, ok := allowed[lower]; ok {
		return exact, false
	}
	bestDistance := 3
	best := ""
	for candidateLower, original := range allowed {
		dist := levenshtein(lower, candidateLower)
		if dist < bestDistance {
			bestDistance = dist
			best = original
		}
	}
	return best, best != ""
}

func levenshtein(a, b string) int {
	ar := []rune(a)
	br := []rune(b)
	dp := make([][]int, len(ar)+1)
	for i := range dp {
		dp[i] = make([]int, len(br)+1)
		dp[i][0] = i
	}
	for j := range br {
		dp[0][j+1] = j + 1
	}
	for i := 1; i <= len(ar); i++ {
		for j := 1; j <= len(br); j++ {
			cost := 0
			if ar[i-1] != br[j-1] {
				cost = 1
			}
			dp[i][j] = minInt(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost)
		}
	}
	return dp[len(ar)][len(br)]
}

func minInt(values ...int) int {
	min := values[0]
	for _, value := range values[1:] {
		if value < min {
			min = value
		}
	}
	return min
}

var sqlKeywords = map[string]bool{
	"SELECT": true, "FROM": true, "WHERE": true, "JOIN": true, "LEFT": true, "RIGHT": true,
	"INNER": true, "OUTER": true, "ON": true, "GROUP": true, "BY": true, "ORDER": true,
	"LIMIT": true, "OFFSET": true, "WITH": true, "AS": true, "AND": true, "OR": true,
	"NOT": true, "NULL": true, "COUNT": true, "SUM": true, "AVG": true, "MIN": true,
	"MAX": true, "CASE": true, "WHEN": true, "THEN": true, "ELSE": true, "END": true,
	"INSERT": true, "UPDATE": true, "DELETE": true, "CREATE": true, "ALTER": true, "DROP": true,
}
