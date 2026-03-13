package security

import (
	"testing"
)

func TestCheckSQL_AllowedStatements(t *testing.T) {
	tests := []struct {
		name string
		sql  string
	}{
		{"simple select", "SELECT * FROM users"},
		{"select with where", "SELECT id, name FROM users WHERE id = 1"},
		{"select with join", "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id"},
		{"select with limit", "SELECT * FROM users LIMIT 10"},
		{"explain select", "EXPLAIN SELECT * FROM users"},
		{"explain analyze", "EXPLAIN ANALYZE SELECT * FROM users WHERE id = 1"},
		{"with CTE", "WITH active AS (SELECT * FROM users WHERE active = true) SELECT * FROM active"},
		{"lowercase select", "select * from users"},
		{"mixed case", "Select * From users"},
		{"select with subquery", "SELECT * FROM (SELECT id FROM users) sub"},
		{"select with leading whitespace", "   SELECT 1"},
		{"select with newlines", "\n\nSELECT\n  *\nFROM users"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckSQL(tt.sql)
			if err != nil {
				t.Errorf("CheckSQL(%q) returned error: %v, want nil", tt.sql, err)
			}
		})
	}
}

func TestCheckSQL_BlockedStatements(t *testing.T) {
	tests := []struct {
		name        string
		sql         string
		wantCommand string
	}{
		{"drop table", "DROP TABLE users", "DROP"},
		{"delete from", "DELETE FROM users", "DELETE"},
		{"truncate", "TRUNCATE TABLE users", "TRUNCATE"},
		{"insert into", "INSERT INTO users (name) VALUES ('test')", "INSERT"},
		{"update", "UPDATE users SET name = 'test'", "UPDATE"},
		{"alter table", "ALTER TABLE users ADD COLUMN age int", "ALTER"},
		{"create table", "CREATE TABLE evil (id int)", "CREATE"},
		{"grant", "GRANT ALL ON users TO evil", "GRANT"},
		{"revoke", "REVOKE ALL ON users FROM user1", "REVOKE"},
		{"lowercase drop", "drop table users", "DROP"},
		{"mixed case delete", "Delete From users", "DELETE"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckSQL(tt.sql)
			if err == nil {
				t.Fatalf("CheckSQL(%q) returned nil, want error", tt.sql)
			}
			sqlErr, ok := err.(*SQLBlockedError)
			if !ok {
				t.Fatalf("expected *SQLBlockedError, got %T", err)
			}
			if sqlErr.Command != tt.wantCommand {
				t.Errorf("got command %q, want %q", sqlErr.Command, tt.wantCommand)
			}
		})
	}
}

func TestCheckSQL_MultiStatement(t *testing.T) {
	tests := []struct {
		name        string
		sql         string
		wantErr     bool
		wantCommand string
	}{
		{
			name:    "two selects",
			sql:     "SELECT 1; SELECT 2",
			wantErr: false,
		},
		{
			name:        "delete after select",
			sql:         "DELETE FROM users; SELECT 1",
			wantErr:     true,
			wantCommand: "DELETE",
		},
		{
			name:        "select then drop",
			sql:         "SELECT 1; DROP TABLE users",
			wantErr:     true,
			wantCommand: "DROP",
		},
		{
			name:    "trailing semicolon",
			sql:     "SELECT * FROM users;",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckSQL(tt.sql)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("CheckSQL(%q) returned nil, want error", tt.sql)
				}
				sqlErr, ok := err.(*SQLBlockedError)
				if !ok {
					t.Fatalf("expected *SQLBlockedError, got %T", err)
				}
				if sqlErr.Command != tt.wantCommand {
					t.Errorf("got command %q, want %q", sqlErr.Command, tt.wantCommand)
				}
			} else {
				if err != nil {
					t.Errorf("CheckSQL(%q) returned error: %v, want nil", tt.sql, err)
				}
			}
		})
	}
}

func TestCheckSQL_EmptySQL(t *testing.T) {
	err := CheckSQL("")
	if err == nil {
		t.Fatal("CheckSQL(\"\") returned nil, want error")
	}
	if !IsSQLBlocked(err) {
		t.Errorf("IsSQLBlocked returned false for empty SQL error")
	}
}

func TestCheckSQL_Comments(t *testing.T) {
	tests := []struct {
		name    string
		sql     string
		wantErr bool
	}{
		{
			name:    "single-line comment before select",
			sql:     "-- this is a comment\nSELECT * FROM users",
			wantErr: false,
		},
		{
			name:    "multi-line comment before select",
			sql:     "/* comment */ SELECT * FROM users",
			wantErr: false,
		},
		{
			name:    "comment before drop",
			sql:     "-- sneaky\nDROP TABLE users",
			wantErr: true,
		},
		{
			name:    "multi-line comment before delete",
			sql:     "/* hide */ DELETE FROM users",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckSQL(tt.sql)
			if tt.wantErr && err == nil {
				t.Fatalf("CheckSQL(%q) returned nil, want error", tt.sql)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("CheckSQL(%q) returned error: %v, want nil", tt.sql, err)
			}
		})
	}
}

func TestCheckSQL_SemicolonInString(t *testing.T) {
	// Semicolons inside quoted strings should not split statements
	err := CheckSQL("SELECT * FROM users WHERE name = 'foo;bar'")
	if err != nil {
		t.Errorf("semicolon in single-quoted string caused error: %v", err)
	}

	err = CheckSQL(`SELECT * FROM users WHERE name = "foo;bar"`)
	if err != nil {
		t.Errorf("semicolon in double-quoted string caused error: %v", err)
	}
}

func TestIsSQLBlocked(t *testing.T) {
	err := CheckSQL("DROP TABLE users")
	if !IsSQLBlocked(err) {
		t.Error("IsSQLBlocked returned false for blocked SQL")
	}

	err = CheckSQL("SELECT 1")
	if IsSQLBlocked(err) {
		t.Error("IsSQLBlocked returned true for allowed SQL")
	}
}

func TestSQLBlockedError_Error(t *testing.T) {
	err := CheckSQL("DROP TABLE users")
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if msg == "" {
		t.Error("error message is empty")
	}
	if !contains(msg, "DROP") {
		t.Errorf("error message %q does not mention the blocked command", msg)
	}
}

func TestCheckSQLWithMode_SafeMode(t *testing.T) {
	// Safe mode: same behavior as CheckSQL — only SELECT/EXPLAIN/WITH allowed.
	if err := CheckSQLWithMode("SELECT 1", true); err != nil {
		t.Errorf("safe mode SELECT: got error %v, want nil", err)
	}
	if err := CheckSQLWithMode("DROP TABLE users", true); err == nil {
		t.Error("safe mode DROP: got nil, want error")
	}
	if err := CheckSQLWithMode("INSERT INTO t VALUES (1)", true); err == nil {
		t.Error("safe mode INSERT: got nil, want error")
	}
	if err := CheckSQLWithMode("", true); err == nil {
		t.Error("safe mode empty SQL: got nil, want error")
	}
}

func TestCheckSQLWithMode_UnsafeMode(t *testing.T) {
	// Unsafe mode: all SQL commands allowed.
	tests := []string{
		"SELECT 1",
		"INSERT INTO users (name) VALUES ('test')",
		"UPDATE users SET name = 'new'",
		"DELETE FROM users WHERE id = 1",
		"DROP TABLE users",
		"CREATE TABLE foo (id int)",
		"ALTER TABLE users ADD COLUMN age int",
		"TRUNCATE TABLE users",
	}
	for _, sql := range tests {
		if err := CheckSQLWithMode(sql, false); err != nil {
			t.Errorf("unsafe mode %q: got error %v, want nil", sql, err)
		}
	}
	// Empty SQL still fails even in unsafe mode.
	if err := CheckSQLWithMode("", false); err == nil {
		t.Error("unsafe mode empty SQL: got nil, want error")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
