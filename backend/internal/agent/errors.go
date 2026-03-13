package agent

import (
	"errors"
	"strings"
)

// DatabaseNotConnectedError indicates that a tool call failed because
// the client has no active database connection.
type DatabaseNotConnectedError struct {
	ToolName string
	Message  string
}

func (e *DatabaseNotConnectedError) Error() string {
	if e.ToolName != "" {
		return e.ToolName + ": database not connected"
	}
	return "database not connected"
}

// NewDatabaseNotConnectedError creates a DatabaseNotConnectedError for the given tool.
func NewDatabaseNotConnectedError(toolName string) *DatabaseNotConnectedError {
	return &DatabaseNotConnectedError{ToolName: toolName}
}

// IsDatabaseNotConnected checks whether err (or any wrapped error) is a
// DatabaseNotConnectedError.
func IsDatabaseNotConnected(err error) bool {
	var target *DatabaseNotConnectedError
	return errors.As(err, &target)
}

// IsDBNotConnectedMessage checks if a tool error message indicates the database
// is not connected. This is used to detect errors from the client-side tool handler.
func IsDBNotConnectedMessage(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "no database connection") ||
		strings.Contains(lower, "database not connected") ||
		strings.Contains(lower, "mcp server not available") ||
		strings.Contains(lower, "electron api not available")
}
