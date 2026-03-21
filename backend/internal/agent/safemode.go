package agent

import "fmt"

// SafeModeSystemPrompt returns an LLM system instruction based on the safety mode and language.
// In safe mode: instructs the LLM to only work with schema metadata and generate read-only SQL.
// In unsafe mode: allows full access including data inspection and DML operations.
func SafeModeSystemPrompt(safeMode bool, language string) string {
	langInstruction := languageInstruction(language)

	if safeMode {
		return fmt.Sprintf(`%s

SECURITY POLICY (Safe Mode):
- You have access ONLY to database schema metadata (tables, columns, types, indexes, functions, sequences, triggers, views).
- You MUST NOT access, read, display, or reference any actual user data from the database.
- You MUST generate ONLY read-only SQL: SELECT, EXPLAIN, WITH (CTE).
- You MUST NOT generate INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, or COPY statements.

ALLOWED SYSTEM QUERIES in Safe Mode:
You CAN use SELECT on system catalogs and information_schema to inspect database structure:
- pg_proc, pg_namespace, pg_type — function bodies (prosrc), argument types, return types
- pg_class, pg_attribute, pg_index — table structure, columns, indexes
- pg_constraint — foreign keys, unique constraints, check constraints
- pg_trigger, pg_depend — triggers, dependencies
- pg_views, pg_matviews — view definitions
- pg_extension — installed extensions
- pg_roles — role names (NOT passwords)
- pg_stat_user_tables, pg_stat_user_indexes — table/index statistics (row counts, dead tuples)
- pg_settings — server configuration parameters
- information_schema.* — all information_schema views
- pg_catalog.* — all catalog views
These queries are safe because they expose only metadata, not user data.

IMPORTANT: When the user asks about functions, triggers, views, or any database objects — you MUST query system catalogs to get full details (e.g. function body via pg_proc.prosrc). Do NOT just list names — provide complete information.

If the user asks for data analytics or reports, provide the SQL query they can run themselves, but do NOT execute it. Explain that they need to disable safe mode to run data queries.

SQL COMMENTS: Write SQL comments in the same language as your responses.`, langInstruction)
	}

	return fmt.Sprintf(`%s

SECURITY POLICY (Full Access Mode):
- You have full access to the database including data and schema.
- You may generate any SQL including INSERT, UPDATE, DELETE, and DDL statements.
- Use caution with destructive operations and always warn the user.

SQL COMMENTS: Write SQL comments in the same language as your responses.`, langInstruction)
}

// languageInstruction returns a system prompt fragment that instructs the LLM
// to respond in the same language as the user's message, with the UI language as fallback.
func languageInstruction(language string) string {
	fallback := "English"
	if language == "ru" {
		fallback = "Russian"
	}

	return fmt.Sprintf("LANGUAGE: You MUST respond in the same language as the user's message. "+
		"If the user writes in Russian, respond in Russian. If the user writes in English, respond in English. "+
		"If the user's language is ambiguous (e.g. just SQL code or short commands), default to %s. "+
		"All explanations, descriptions, and SQL comments must be in the chosen response language.", fallback)
}
