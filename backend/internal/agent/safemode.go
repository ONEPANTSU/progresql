package agent

// SafeModeSystemPrompt returns an LLM system instruction based on the safety mode.
// In safe mode: instructs the LLM to only work with schema metadata and generate read-only SQL.
// In unsafe mode: allows full access including data inspection and DML operations.
func SafeModeSystemPrompt(safeMode bool) string {
	if safeMode {
		return "SECURITY POLICY (Safe Mode):\n" +
			"- You have access ONLY to database schema metadata (tables, columns, types, indexes, functions, sequences).\n" +
			"- You MUST NOT access, read, display, or reference any actual data from the database.\n" +
			"- You MUST generate ONLY read-only SQL: SELECT, EXPLAIN, WITH (CTE).\n" +
			"- You MUST NOT generate INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, or COPY statements.\n" +
			"- If the user asks for data analytics or reports, provide the SQL query they can run themselves, " +
			"but do NOT execute it or show data. Explain: 'Due to the security policy, I cannot execute this query, but here is the SQL to build the report:'\n"
	}
	return "SECURITY POLICY (Unsafe Mode):\n" +
		"- You have full access to the database including data and schema.\n" +
		"- You may generate any SQL including INSERT, UPDATE, DELETE, and DDL statements.\n" +
		"- Use caution with destructive operations and always warn the user.\n"
}
