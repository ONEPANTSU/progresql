Feature: Query plan analysis

  Scenario: Explain analyze select query
    Given MCP server is running
    When client sends EXPLAIN ANALYZE for SELECT query
    Then server executes EXPLAIN ANALYZE
    And returns query plan
    And does not return any table data

