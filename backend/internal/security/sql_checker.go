package security

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// SQLBlockedError is returned when a SQL command is blocked by the security checker.
type SQLBlockedError struct {
	SQL     string
	Command string
	Message string
}

func (e *SQLBlockedError) Error() string {
	return e.Message
}

// IsSQLBlocked checks whether the given error is a SQLBlockedError (supports wrapped errors).
func IsSQLBlocked(err error) bool {
	var sbe *SQLBlockedError
	return errors.As(err, &sbe)
}

// blockedCommands is the set of SQL commands that are not allowed in safe/data modes.
var blockedCommands = map[string]bool{
	"INSERT":     true,
	"UPDATE":     true,
	"DELETE":     true,
	"MERGE":      true,
	"DROP":       true,
	"TRUNCATE":   true,
	"ALTER":      true,
	"CREATE":     true,
	"GRANT":      true,
	"REVOKE":     true,
	"DENY":       true,
	"COPY":       true,
	"CALL":       true,
	"DO":         true,
	"EXECUTE":    true,
	"VACUUM":     true,
	"REFRESH":    true,
	"REINDEX":    true,
	"CLUSTER":    true,
	"COMMENT":    true,
	"SECURITY":   true,
	"DISCARD":    true,
	"LISTEN":     true,
	"NOTIFY":     true,
	"UNLISTEN":   true,
	"SET":        true,
	"RESET":      true,
	"LOCK":       true,
	"IMPORT":     true,
	"CREATEUSER": true,
}

// allowedCommands is the set of SQL commands that are permitted in safe/data modes.
var allowedCommands = map[string]bool{
	"SELECT":  true,
	"EXPLAIN": true,
	"WITH":    true,
}

// CheckSQLWithMode validates SQL based on the security mode.
// In safe mode (safeMode=true): only SELECT, EXPLAIN, and WITH are permitted.
// In unsafe mode (safeMode=false): all SQL commands are allowed (no restrictions).
// Deprecated: Use CheckSQLWithSecurityMode instead.
func CheckSQLWithMode(sql string, safeMode bool) error {
	if !safeMode {
		// Unsafe mode: all commands allowed; only check for empty SQL.
		if strings.TrimSpace(sql) == "" {
			return &SQLBlockedError{SQL: sql, Command: "", Message: "empty SQL statement"}
		}
		return nil
	}
	return CheckSQL(sql)
}

// CheckSQLWithSecurityMode validates SQL based on the three-tier security mode.
// "safe" mode: only SELECT, EXPLAIN, and WITH are permitted (schema inspection only).
// "data" mode: only SELECT, EXPLAIN, and WITH are permitted (read-only data access).
// "execute" mode: all SQL commands are allowed (no restrictions).
func CheckSQLWithSecurityMode(sql string, securityMode string) error {
	if securityMode == "execute" {
		// Execute mode: all commands allowed; only check for empty SQL.
		if strings.TrimSpace(sql) == "" {
			return &SQLBlockedError{SQL: sql, Command: "", Message: "empty SQL statement"}
		}
		return nil
	}
	// Both "safe" and "data" modes restrict to read-only commands.
	return CheckSQL(sql)
}

// CheckSQL validates that the given SQL string contains only allowed commands.
// Only SELECT, EXPLAIN, and WITH (CTE) statements are permitted.
// Returns nil if the SQL is safe, or a SQLBlockedError if it contains dangerous commands.
func CheckSQL(sql string) error {
	sql = strings.TrimSpace(sql)
	if sql == "" {
		return &SQLBlockedError{
			SQL:     sql,
			Command: "",
			Message: "empty SQL statement",
		}
	}

	if command := findBlockedCommand(sql); command != "" {
		return &SQLBlockedError{
			SQL:     sql,
			Command: command,
			Message: fmt.Sprintf("SQL command %s is not allowed; only SELECT and EXPLAIN are permitted", command),
		}
	}

	// Split by semicolons to handle multi-statement queries
	statements := splitStatements(sql)

	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}

		cmd := extractCommand(stmt)
		upper := strings.ToUpper(cmd)

		if blockedCommands[upper] {
			return &SQLBlockedError{
				SQL:     sql,
				Command: upper,
				Message: fmt.Sprintf("SQL command %s is not allowed; only SELECT and EXPLAIN are permitted", upper),
			}
		}

		if !allowedCommands[upper] {
			return &SQLBlockedError{
				SQL:     sql,
				Command: upper,
				Message: fmt.Sprintf("SQL command %q is not allowed; only SELECT and EXPLAIN are permitted", upper),
			}
		}
	}

	return nil
}

// findBlockedCommand scans the whole SQL text after replacing comments,
// string literals, and quoted identifiers with whitespace. This catches
// nested mutating statements such as WITH x AS (DELETE ... RETURNING ...)
// SELECT ... that would otherwise look like a harmless WITH statement.
func findBlockedCommand(sql string) string {
	sanitized := sanitizeSQLForKeywordScan(sql)
	var token strings.Builder

	flush := func() string {
		if token.Len() == 0 {
			return ""
		}
		word := strings.ToUpper(token.String())
		token.Reset()
		if blockedCommands[word] {
			return word
		}
		return ""
	}

	for _, r := range sanitized {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			token.WriteRune(r)
			continue
		}
		if command := flush(); command != "" {
			return command
		}
	}
	return flush()
}

func sanitizeSQLForKeywordScan(sql string) string {
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
				out.WriteByte(sql[i])
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

		if ch == '\'' {
			out.WriteByte(' ')
			for i++; i < len(sql); i++ {
				out.WriteByte(' ')
				if sql[i] == '\'' {
					if i+1 < len(sql) && sql[i+1] == '\'' {
						i++
						out.WriteByte(' ')
						continue
					}
					break
				}
			}
			continue
		}

		if ch == '"' {
			out.WriteByte(' ')
			for i++; i < len(sql); i++ {
				out.WriteByte(' ')
				if sql[i] == '"' {
					if i+1 < len(sql) && sql[i+1] == '"' {
						i++
						out.WriteByte(' ')
						continue
					}
					break
				}
			}
			continue
		}

		if ch == '$' {
			if end := readDollarQuoteTag(sql, i); end > i {
				tag := sql[i:end]
				out.WriteString(strings.Repeat(" ", len(tag)))
				i = end
				bodyStart := i
				closeIdx := strings.Index(sql[bodyStart:], tag)
				if closeIdx == -1 {
					out.WriteString(strings.Repeat(" ", len(sql)-bodyStart))
					return out.String()
				}
				for _, r := range sql[bodyStart : bodyStart+closeIdx] {
					if r == '\n' {
						out.WriteRune('\n')
					} else {
						out.WriteByte(' ')
					}
				}
				out.WriteString(strings.Repeat(" ", len(tag)))
				i = bodyStart + closeIdx + len(tag) - 1
				continue
			}
		}

		out.WriteByte(ch)
	}

	return out.String()
}

func readDollarQuoteTag(sql string, start int) int {
	if start >= len(sql) || sql[start] != '$' {
		return -1
	}
	for i := start + 1; i < len(sql); i++ {
		ch := sql[i]
		if ch == '$' {
			return i + 1
		}
		if !unicode.IsLetter(rune(ch)) && !unicode.IsDigit(rune(ch)) && ch != '_' {
			return -1
		}
	}
	return -1
}

// extractCommand returns the first SQL keyword from a statement,
// skipping leading whitespace and comments.
func extractCommand(stmt string) string {
	s := skipCommentsAndWhitespace(stmt)

	// Extract first word (the SQL command)
	var cmd strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || r == '_' {
			cmd.WriteRune(r)
		} else {
			break
		}
	}
	return cmd.String()
}

// skipCommentsAndWhitespace strips leading whitespace, single-line (--) and
// multi-line (/* */) comments from the input.
func skipCommentsAndWhitespace(s string) string {
	for {
		s = strings.TrimSpace(s)
		if s == "" {
			return s
		}

		// Skip single-line comments
		if strings.HasPrefix(s, "--") {
			idx := strings.Index(s, "\n")
			if idx == -1 {
				return ""
			}
			s = s[idx+1:]
			continue
		}

		// Skip multi-line comments
		if strings.HasPrefix(s, "/*") {
			idx := strings.Index(s, "*/")
			if idx == -1 {
				return ""
			}
			s = s[idx+2:]
			continue
		}

		return s
	}
}

// splitStatements splits SQL by semicolons, respecting single-quoted strings.
func splitStatements(sql string) []string {
	var stmts []string
	var current strings.Builder
	inSingleQuote := false
	inDoubleQuote := false

	for i := 0; i < len(sql); i++ {
		ch := sql[i]

		if ch == '\'' && !inDoubleQuote {
			// Handle escaped single quotes ''
			if inSingleQuote && i+1 < len(sql) && sql[i+1] == '\'' {
				current.WriteByte(ch)
				current.WriteByte(sql[i+1])
				i++
				continue
			}
			inSingleQuote = !inSingleQuote
			current.WriteByte(ch)
			continue
		}

		if ch == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			current.WriteByte(ch)
			continue
		}

		if ch == ';' && !inSingleQuote && !inDoubleQuote {
			stmts = append(stmts, current.String())
			current.Reset()
			continue
		}

		current.WriteByte(ch)
	}

	// Add the last statement if non-empty
	if s := strings.TrimSpace(current.String()); s != "" {
		stmts = append(stmts, current.String())
	}

	return stmts
}
