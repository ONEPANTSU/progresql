# ProgreSQL Bug Reports

This document tracks known bugs, their severity, current status, and resolution details.

---

## Summary

| Bug ID | Title | Severity | Status |
|--------|-------|----------|--------|
| BUG-001 | Password strength indicator shows "strong" prematurely | Medium | Fixed |
| BUG-002 | Payment modal legal consent checkbox blocks payment | High | Fixed |
| BUG-003 | AI assistant responds in Russian regardless of system language | High | Fixed |
| BUG-004 | [CURSOR] marker appears in SQL autocomplete hints | Medium | Fixed |
| BUG-005 | "Select Top 100" switches to wrong connection | High | Fixed |
| BUG-006 | Cell editing in query results has no batch save | Medium | Fixed |
| BUG-007 | "System" theme label clipped in Russian locale | Low | Fixed |
| BUG-008 | Schema browser icons misaligned | Low | Fixed |
| BUG-009 | Markdown paragraph spacing too large in chat responses | Low | Fixed |
| BUG-010 | SQL autocomplete hallucinates column names not in schema | High | Fixed |
| BUG-011 | SQL Templates button present but unused in editor toolbar | Low | Fixed |
| BUG-012 | Crypto payment option present in pricing | Medium | Fixed |
| BUG-013 | "Fix in Chat" duplicates "Error" prefix in message | Medium | Open |
| BUG-014 | Reset password email uses wrong accent color | Low | Open |
| BUG-015 | Migration editor does not wrap migrations in transactions | High | Open |
| BUG-016 | "Fix in Chat" rate limiting shows generic error message | Medium | Open |
| BUG-017 | AuthProvider stale closure — plan changes not reflected live | High | Open |
| BUG-018 | Memory leak in useChat scroll/resize listeners | High | Open |
| BUG-019 | Message ID collision when two messages sent within 1ms | High | Open |
| BUG-020 | ChatPanel missing ErrorBoundary — crash kills entire panel | Medium | Open |
| BUG-021 | In-flight agent request uses old connectionId after switch | Medium | Open (Questionable) |
| BUG-022 | NotificationContext ID counter overflow in long sessions | Low | Open (Questionable) |
| BUG-023 | SQLBlock EXPLAIN state update after unmount | Medium | Open |
| BUG-024 | ChartBlock silently fails for JSON/timestamp column types | Medium | Open |
| BUG-025 | Empty query result shows confusing empty column headers | Low | Open (Questionable) |
| BUG-026 | Stale DOM ref in useChat scrollIntoView | Low | Open (Questionable) |
| BUG-027 | dangerouslySetInnerHTML in ChatMessage — XSS vector | Medium | Open |
| BUG-028 | SQL action buttons not disabled during verification | Low | Open |
| BUG-029 | WebSocket reconnect orphans all pending requests silently | High | Open |
| BUG-030 | JWT refresh fires after logout if timer not cleared in time | Medium | Open |
| BUG-031 | ChatInput sends message to errored connection with no feedback | Medium | Open |
| BUG-032 | Markdown table cells not escaped — rendering glitches | Medium | Open |
| BUG-033 | QueryResults column resize listeners may leak on unmount | Medium | Open (Questionable) |
| BUG-034 | Date.now() message IDs — collision on fast CPU | Medium | Open |
| BUG-035 | SecurityMode accepts invalid string values | Low | Open (Questionable) |
| BUG-036 | Chat message list missing role="log" — screen reader silent | Low | Open |
| BUG-037 | ToolHandler silent failure causes cascading agent tool errors | High | Open |
| BUG-038 | Streaming race: deltas after finishStreaming() lost | High | Open |
| BUG-039 | ChatInput loses focus after removing attached SQL | Low | Open |
| BUG-040 | Clear chat history has no confirmation dialog | Low | Open |
| BUG-041 | SQLBlock EXPLAIN runs against wrong connection after switch | High | Open |
| BUG-042 | Notification queue gap (100ms) causes missed interaction target | Low | Open (Questionable) |

---

## Fixed Bugs

---

### BUG-001

**Title:** Password strength indicator shows "strong" prematurely

**Severity:** Medium | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The password strength indicator turned green and displayed "Strong" when 4 out of 5 strength criteria were met. The indicator should only reach "Strong" state when all 5 criteria are satisfied.

---

### BUG-002

**Title:** Payment modal legal consent checkbox blocks payment

**Severity:** High | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
A legal consent checkbox inside the payment modal required explicit user interaction before allowing the payment to proceed. Checkbox was removed; consent text relocated to the bottom of the modal.

---

### BUG-003

**Title:** AI assistant responds in Russian regardless of system language

**Severity:** High | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The AI assistant system prompt was hardcoded to instruct the model to respond in Russian. Now the prompt uses the user's selected interface language.

---

### BUG-004

**Title:** [CURSOR] marker appears in SQL autocomplete hints

**Severity:** Medium | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The literal string `[CURSOR]` used as a cursor position marker in autocomplete prompts was being surfaced in ghost-text suggestions visible to the user.

---

### BUG-005

**Title:** "Select Top 100" switches to wrong connection

**Severity:** High | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The "Select Top 100 Rows" context menu action was using the globally active connection instead of the connection associated with the schema browser node being right-clicked.

---

### BUG-006

**Title:** Cell editing in query results has no batch save

**Severity:** Medium | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
Each cell edit in query results immediately triggered a separate UPDATE statement. Multiple consecutive edits now accumulate into a batch before committing.

---

### BUG-007

**Title:** "System" theme label clipped in Russian locale

**Severity:** Low | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The Russian translation for the "System" theme option was too long for its container, causing the label to be clipped. Container width adjusted.

---

### BUG-008

**Title:** Schema browser icons misaligned

**Severity:** Low | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
Table, view, and function icons in the schema browser were vertically misaligned relative to their text labels due to incorrect flex alignment.

---

### BUG-009

**Title:** Markdown paragraph spacing too large in chat responses

**Severity:** Low | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
AI chat responses with multiple paragraphs had excessive vertical spacing between them, causing the user to scroll more than necessary.

---

### BUG-010

**Title:** SQL autocomplete hallucinates column names not in schema

**Severity:** High | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The autocomplete model was generating column names that did not exist in the actual table schema because the schema context was not injected into the prompt reliably.

---

### BUG-011

**Title:** SQL Templates button present but unused in editor toolbar

**Severity:** Low | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The SQL editor toolbar contained a "SQL Templates" button with no implementation. Removed.

---

### BUG-012

**Title:** Crypto payment option present in pricing

**Severity:** Medium | **Status:** Fixed | **Fix Version:** v1.0.66

**Description:**
The pricing page offered a cryptocurrency payment option that was no longer supported. Removed in favor of card and SBP.

---

## Open Bugs

---

### BUG-013

**Title:** "Fix in Chat" duplicates "Error" prefix in message

**Severity:** Medium | **Status:** Open

**Description:**
When using "Fix in Chat", the resulting message shows the error prefix twice: "Error: Error: query failed". The error string already contains the "Error:" prefix.

**Steps to Reproduce:**
1. Run a SQL query that produces an error.
2. Click "Fix in Chat" on the error result.
3. Observe duplicated "Error:" prefix in the chat message.

---

### BUG-014

**Title:** Reset password email uses wrong accent color

**Severity:** Low | **Status:** Open

**Description:**
The password reset email template uses red as the accent color. Brand accent is purple.

**Steps to Reproduce:**
1. Click "Forgot password" on the login screen.
2. Submit a valid registered email.
3. Open the received email — accent colors are red, not purple.

---

### BUG-015

**Title:** Migration editor does not wrap migrations in transactions

**Severity:** High | **Status:** Open

**Description:**
Migrations executed in the migration editor are not wrapped in BEGIN/COMMIT. A mid-migration failure leaves the database in a partially migrated state with no automatic ROLLBACK.

**Steps to Reproduce:**
1. Write a multi-statement migration where a later statement will fail.
2. Run the migration.
3. Observe that statements before the failure are committed.

---

### BUG-016

**Title:** "Fix in Chat" rate limiting shows generic error message

**Severity:** Medium | **Status:** Open

**Description:**
When the "Fix in Chat" rate limit is hit, the user sees a generic technical error instead of a friendly "please wait" message.

**Steps to Reproduce:**
1. Rapidly click "Fix in Chat" multiple times.
2. Observe generic error instead of friendly rate-limit message.

---

### BUG-017

**Title:** AuthProvider stale closure — plan changes not reflected live

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/providers/AuthProvider.tsx:35`

**Description:**
The periodic user refresh effect uses `[!!user]` as its dependency. When the `user` object changes but the boolean stays `true`, the interval is not recreated and the closure captures stale user data. If the server updates the user's plan, the change won't reflect until the app restarts.

**Steps to Reproduce:**
1. Login and stay active for 5+ minutes.
2. Change user's plan on the server side.
3. Observe that the client doesn't reflect the plan change without a restart.

---

### BUG-018

**Title:** Memory leak in useChat scroll/resize listeners

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/hooks/useChat.ts:89-94`

**Description:**
The scroll and resize listeners attached to `tabsContainerRef` may not be removed if the component unmounts during a race condition where the ref becomes null before cleanup runs.

**Steps to Reproduce:**
1. Open the chat panel with multiple tabs.
2. Rapidly close and reopen the panel while scrolling.
3. Monitor memory — event listeners accumulate.

---

### BUG-019

**Title:** Message ID collision when two messages sent within 1ms

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/hooks/useAgentMessages.ts:329`

**Description:**
User and bot messages use `Date.now()` and `Date.now() + 1` as IDs. On fast CPUs, two messages created within 1ms get the same ID and one silently overwrites the other in the messages array.

**Steps to Reproduce:**
1. Programmatically send two messages within 1ms.
2. Observe that one message disappears from the chat.

---

### BUG-020

**Title:** ChatPanel missing ErrorBoundary — crash kills entire panel

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/ChatPanel.tsx:165`

**Description:**
ChatPanel has no ErrorBoundary. If any child (RenderMarkdown, ChatMessage, streaming update) throws, the entire chat panel crashes with no recovery UI shown to the user.

**Steps to Reproduce:**
1. Agent returns malformed visualization data.
2. ChatPanel throws during render.
3. User sees blank/crashed panel with no way to recover without reload.

---

### BUG-021

**Title:** In-flight agent request uses old connectionId after switch

**Severity:** Medium | **Status:** Open (Questionable)

**File:** `frontend/renderer/components/ChatPanel.tsx:124-141`

**Description:**
When the user switches database connections while a request is streaming, subsequent tool calls in that request continue using the old connectionId. The query result may reference the wrong database.

**Steps to Reproduce:**
1. Send a message to the AI.
2. While it's streaming, switch to a different connection via the pill menu.
3. The agent's tool calls execute against the old connection.

---

### BUG-022

**Title:** NotificationContext ID counter overflow in very long sessions

**Severity:** Low | **Status:** Open (Questionable)

**File:** `frontend/renderer/contexts/NotificationContext.tsx:54`

**Description:**
Module-scoped `idCounter` increases monotonically without bound. In a multi-day session with many notifications, it could theoretically approach `Number.MAX_SAFE_INTEGER`, causing ID collisions.

---

### BUG-023

**Title:** SQLBlock EXPLAIN triggers state update after component unmount

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/chat/SQLBlock.tsx:78-116`

**Description:**
The verification effect uses a `cancelled` flag to guard state updates, but if `executeQuery` doesn't support real cancellation via Electron API, the promise resolves after unmount and triggers a state update warning. May cause silent errors in production.

**Steps to Reproduce:**
1. Render a SQLBlock with a slow EXPLAIN query.
2. Unmount the component before the query finishes (e.g., close chat).
3. Console shows "Can't perform React state update on unmounted component".

---

### BUG-024

**Title:** ChartBlock silently fails for JSON/timestamp column types

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/chat/ChartBlock.tsx:50-62`

**Description:**
`coerceNumericData()` only handles string-encoded numbers via `Number(value)`. JSONB or timestamp columns from PostgreSQL aren't converted, so Recharts silently renders an empty chart with no error shown.

**Steps to Reproduce:**
1. Ask the AI to visualize data from a table with timestamp columns.
2. Agent returns a chart block.
3. Chart renders empty with no error message.

---

### BUG-025

**Title:** Empty query result shows confusing empty column headers

**Severity:** Low | **Status:** Open (Questionable)

**File:** `frontend/renderer/hooks/useAgentMessages.ts:48-86`

**Description:**
If a query returns rows without column metadata, the markdown table formatter produces a table with empty headers (`| | | |`), which is confusing.

---

### BUG-026

**Title:** Stale DOM ref in useChat scrollIntoView

**Severity:** Low | **Status:** Open (Questionable)

**File:** `frontend/renderer/hooks/useChat.ts:67-72`

**Description:**
`messagesEndRef.current?.scrollIntoView()` is called in a useEffect depending on `[chats, activeChatId]`. If the ref is reassigned during a render cycle, the scroll targets a stale node.

---

### BUG-027

**Title:** dangerouslySetInnerHTML in ChatMessage — potential XSS vector

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/chat/ChatMessage.tsx:391`

**Description:**
`HighlightedSQLPre` uses `dangerouslySetInnerHTML` with output from `highlightSQL()`. If the highlight function doesn't properly sanitize agent-generated SQL containing HTML entities or script payloads, this is an XSS vector if the backend is ever compromised.

**Steps to Reproduce:**
1. Agent returns SQL containing `<script>alert(1)</script>`.
2. If not sanitized, script executes in the Electron renderer process.

---

### BUG-028

**Title:** SQL action buttons not disabled during EXPLAIN verification

**Severity:** Low | **Status:** Open

**File:** `frontend/renderer/components/chat/SQLBlock.tsx:182-205`

**Description:**
While SQL verification (EXPLAIN) is in progress, the Explain, Apply, and Execute buttons remain active. Clicking them launches a second concurrent request, leading to unpredictable UI state.

**Steps to Reproduce:**
1. Open a chat message with a SQL block.
2. Click the Explain button.
3. Immediately click Explain again before the first completes.

---

### BUG-029

**Title:** WebSocket reconnect orphans all pending requests silently

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/services/agent/AgentService.ts:525-565`

**Description:**
On unexpected WebSocket disconnect + reconnect, pending requests in the `pendingRequests` Map are never resolved or rejected. The user's in-flight AI request hangs indefinitely — no error, no timeout.

**Steps to Reproduce:**
1. Send an AI request.
2. Disable and re-enable WiFi while the request is in flight.
3. Request hangs forever in the UI with the loading spinner.

---

### BUG-030

**Title:** JWT refresh timer may fire after logout

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/services/agent/AgentService.ts:581-602`

**Description:**
`scheduleJWTRefresh()` sets a timeout. If the user logs out while a refresh is scheduled and the timer fires before `disconnect()` clears it, `obtainJWT()` runs after logout, creating unnecessary network traffic and potentially refreshing a stale session.

**Steps to Reproduce:**
1. Login and wait until JWT refresh is scheduled (near token expiry).
2. Logout quickly.
3. Network tab shows a JWT refresh request firing after logout.

---

### BUG-031

**Title:** ChatInput sends message to errored connection with no feedback

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/chat/ChatInput.tsx:136,275`

**Description:**
If a database connection is in an error state, the connection pill shows an error indicator, but the user can still send a message. The message will be sent with that connection, and the agent will fail with a generic tool error rather than an upfront warning.

**Steps to Reproduce:**
1. Let a database connection drop.
2. Send a message in the chat panel connected to it.
3. No warning is shown before sending; error only appears after the agent tries to use the broken connection.

---

### BUG-032

**Title:** Markdown table cells not escaped — rendering glitches

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/components/chat/ChatMessage.tsx:124-208`

**Description:**
The `MarkdownTable` component passes cell content directly through `processInlineFormatting()`. Cells containing `|` characters break the table structure; cells containing HTML tags may render as raw HTML.

**Steps to Reproduce:**
1. Agent returns a table where a cell value contains a pipe character `|`.
2. The table layout breaks — the pipe is interpreted as a column separator.

---

### BUG-033

**Title:** QueryResults column resize event listeners may leak on unmount

**Severity:** Medium | **Status:** Open (Questionable)

**File:** `frontend/renderer/components/QueryResults.tsx`

**Description:**
Column resize logic likely attaches `mousemove` and `mouseup` listeners to `document` or `window`. If the QueryResults component unmounts during an active drag operation, these global listeners are not removed and accumulate over time.

**Steps to Reproduce:**
1. Start resizing a column in query results.
2. Close the results panel while still holding the mouse button.
3. Mouse events continue firing on document after unmount.

---

### BUG-034

**Title:** Date.now() message IDs — collision risk on fast CPU

**Severity:** Medium | **Status:** Open

**File:** `frontend/renderer/hooks/useAgentMessages.ts:311,329,441`

**Description:**
Multiple messages use `Date.now().toString()` as IDs. On modern CPUs, `Date.now()` can return the same value for consecutive calls within the same millisecond. Two messages created in the same millisecond get the same ID and one silently overwrites the other.

**Steps to Reproduce:**
1. Trigger two message creations within 1ms (e.g., fast agent response + user send).
2. One message disappears from the chat history.

---

### BUG-035

**Title:** SecurityMode accepts and persists invalid string values

**Severity:** Low | **Status:** Open (Questionable)

**File:** `frontend/renderer/contexts/AgentContext.tsx:174`

**Description:**
`setSecurityMode()` accepts any string with no validation against the allowed set (`"safe"`, `"normal"`, etc.). An invalid value stored in localStorage is loaded on next startup and may cause unexpected agent behavior.

---

### BUG-036

**Title:** Chat message list missing role="log" — screen readers silent

**Severity:** Low | **Status:** Open

**File:** `frontend/renderer/components/ChatPanel.tsx:329`

**Description:**
The message list container lacks `role="log"` or `aria-live="polite"`. Screen readers won't announce new messages as they arrive, making the chat inaccessible to visually impaired users.

---

### BUG-037

**Title:** ToolHandler silent DB disconnection causes cascading agent failures

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/services/agent/toolHandler.ts:156-169`

**Description:**
When the database is disconnected mid-conversation, each tool call returns a structured error message for the LLM. However, the agent continues trying subsequent tools, amplifying errors and burning tokens. There is no circuit-breaker to abort the pipeline and tell the user upfront.

**Steps to Reproduce:**
1. Start a multi-step AI query (e.g., "analyze all tables").
2. Disconnect the database while the agent is mid-execution.
3. Agent tries all remaining tool calls, returns multiple error messages.

---

### BUG-038

**Title:** Streaming race — deltas arriving after finishStreaming() are lost

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/hooks/useStreamingMessage.ts:75-102`

**Description:**
`finishStreaming()` cancels the pending requestAnimationFrame and flushes state. If additional delta chunks arrive after `finishStreaming()` is called but before the rAF fires, those deltas accumulate in `textRef` but are never committed to state. The final message appears truncated.

**Steps to Reproduce:**
1. Use a model that sends a burst of final chunks followed immediately by a `[DONE]`.
2. The last few tokens of the response are missing in the displayed message.

---

### BUG-039

**Title:** ChatInput loses focus after removing attached SQL

**Severity:** Low | **Status:** Open

**File:** `frontend/renderer/components/chat/ChatInput.tsx:182-197`

**Description:**
Clicking the ✕ button to remove attached SQL does not restore focus to the text input. The user must click the input manually to continue typing.

**Steps to Reproduce:**
1. Apply a SQL block to chat input.
2. Click ✕ to remove it.
3. Try typing immediately — keyboard input is lost.

---

### BUG-040

**Title:** Clear chat history has no confirmation dialog

**Severity:** Low | **Status:** Open

**File:** `frontend/renderer/hooks/useChat.ts:167`

**Description:**
`handleClearHistory()` immediately deletes all chat history without asking for confirmation. Accidental clicks permanently wipe all conversations.

**Steps to Reproduce:**
1. Click "Clear history" in the chat panel settings menu.
2. All conversations are immediately and permanently deleted.

---

### BUG-041

**Title:** SQLBlock EXPLAIN runs against wrong connection after switch

**Severity:** High | **Status:** Open

**File:** `frontend/renderer/components/chat/SQLBlock.tsx:97`

**Description:**
SQL verification uses `connectionId || ''`. If the prop is undefined or the user switched connections after the message was created, EXPLAIN runs against the wrong database, producing false positive/negative verification results.

**Steps to Reproduce:**
1. Open a chat session using connection A.
2. Switch to connection B via the pill menu.
3. A new SQL block's EXPLAIN query runs against connection A, not B.

---

### BUG-042

**Title:** Notification queue 100ms gap causes missed click targets

**Severity:** Low | **Status:** Open (Questionable)

**File:** `frontend/renderer/contexts/NotificationContext.tsx:70-73`

**Description:**
When transitioning between queued notifications, a 100ms setTimeout creates a blank gap in the notification area. Users clicking on a disappearing notification may miss it or click on nothing.

**Steps to Reproduce:**
1. Trigger multiple notifications in quick succession.
2. Try to click the action button on any notification other than the first.
3. The button disappears during the 100ms transition gap.

---

*Last updated: 2026-03-27*
