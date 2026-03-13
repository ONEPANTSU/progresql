Feature: SQL safety enforcement

  Scenario: Reject data access query
    Given MCP server is running
    When client sends "SELECT * FROM users"
    Then server rejects request
    And returns error "Direct data access is forbidden"

