Feature: Database metadata inspection

  Scenario: Retrieve schemas and tables
    Given MCP server is running
    And PostgreSQL connection is configured
    When client requests database schemas
    Then server returns list of schemas
    And each schema contains tables
    And no table data is returned

  Scenario: Retrieve table columns
    Given MCP server is running
    And a schema "public" exists
    When client requests table "users" structure
    Then server returns column names
    And column data types
    And nullability information
    And no row data

