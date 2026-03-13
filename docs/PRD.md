# PRD: ProgressQL Backend (MVP)

**Версия:** 1.0  
**Дата:** 2026-03-13  
**Статус:** Draft  

---

## 1. Обзор и цели

ProgressQL — AI-ассистент для работы с PostgreSQL, объединяющий LLM-агента с локальным клиентом управления БД. Бэкенд является центральным компонентом системы: он принимает запросы от клиента, запускает агентный пайплайн, обращается к LLM через OpenRouter, и возвращает результаты обратно клиенту.

**Ключевой принцип архитектуры:** бэкенд не имеет прямого доступа к PostgreSQL пользователя. Все данные о схеме и результаты запросов он получает исключительно через инструменты (tools), которые клиент предоставляет по WebSocket. LLM никогда не видит реальные данные пользователя — только схему и метаданные.

**Цели MVP:**
- Реализовать агентный пайплайн Hybrid SQL Agent
- Обеспечить полную независимость бэкенда от конкретной реализации клиента (pgAdmin fork или Nextron)
- Поддержать минимальный клиент для end-to-end тестирования с первого дня

---

## 2. Целевая аудитория

Backend-разработчики и fullstack-разработчики, работающие с PostgreSQL. Они хотят ускорить написание SQL и снизить когнитивную нагрузку при работе с незнакомыми схемами.

---

## 3. Технический стек

| Компонент | Выбор | Обоснование |
|---|---|---|
| Язык | **Go** | Строгая типизация ловит ошибки контрактов на этапе компиляции; высокая производительность для конкурентных WebSocket-сессий; хорошая поддержка AI-ассистентами при написании кода |
| HTTP/WebSocket | `github.com/gorilla/websocket` + `net/http` | Стандартный выбор для Go WebSocket-серверов |
| LLM-провайдер | **OpenRouter** (OpenAI-совместимый API) | Единый интерфейс для GPT-4, Claude, DeepSeek и других моделей |
| Конфигурация | `github.com/spf13/viper` | Поддержка env-переменных и config-файлов |
| Логирование | `go.uber.org/zap` | Структурированные логи для аудита вызовов агента |
| Деплой | Docker + docker-compose | Одна команда `docker-compose up` запускает всё окружение |

---

## 4. Структура проекта

```
progressql/
  backend/
    cmd/
      server/
        main.go              # Точка входа
    internal/
      agent/                 # Агентный пайплайн
        pipeline.go          # Hybrid SQL Agent orchestrator
        steps/               # Шаги пайплайна
          schema_grounding.go
          sql_generation.go
          diagnostic_retry.go
          seed_expansion.go
          aggregation.go
      llm/
        client.go            # OpenRouter HTTP-клиент
        types.go             # Структуры запросов/ответов
      websocket/
        hub.go               # Менеджер соединений
        session.go           # Сессия клиента
        tools.go             # Вызов инструментов клиента
      auth/
        jwt.go               # JWT-токены
        middleware.go
      tools/
        registry.go          # Реестр доступных tools
        types.go             # Tool call / tool result типы
    api/
      rest/
        handlers.go          # REST-эндпоинты
        router.go
      ws/
        handlers.go          # WebSocket-хендлеры
    config/
      config.go
  client-minimal/            # Минимальный Go/Web-клиент для тестирования
    main.go                  # WebSocket-клиент + заглушки tools
  docker/
    Dockerfile.backend
  docker-compose.yml
  README.md
```

---

## 5. API-спецификация

### 5.1 REST Endpoints

Используются для простых операций и управления сессиями.

#### `POST /api/v1/auth/token`
Получение JWT-токена для авторизации WebSocket-соединения.

**Request body:**
```json
{
  "api_key": "string"
}
```

**Response:**
```json
{
  "token": "string (JWT)",
  "expires_at": "ISO8601 timestamp"
}
```

**Acceptance criteria:**
- Возвращает JWT со сроком жизни 24 часа
- При неверном api_key возвращает 401

---

#### `GET /api/v1/health`
Проверка работоспособности сервера.

**Response:**
```json
{
  "status": "ok",
  "version": "string"
}
```

---

#### `POST /api/v1/sessions`
Создание новой агентной сессии перед WebSocket-подключением.

**Headers:** `Authorization: Bearer <JWT>`

**Request body:**
```json
{
  "model": "string (например: openai/gpt-4o)",
  "db_context": {
    "db_name": "string",
    "db_version": "string"
  }
}
```

**Response:**
```json
{
  "session_id": "string (UUID)",
  "ws_url": "string (wss://...)"
}
```

---

### 5.2 WebSocket Protocol

**Endpoint:** `wss://<host>/ws/<session_id>?token=<JWT>`

Все сообщения в формате JSON. Каждое сообщение содержит поле `type`.

#### Типы сообщений: Client → Backend

**`agent.request`** — запрос к агенту:
```json
{
  "type": "agent.request",
  "request_id": "string (UUID)",
  "payload": {
    "action": "generate_sql | improve_sql | explain_sql | analyze_schema",
    "user_message": "string",
    "context": {
      "selected_sql": "string (опционально, для improve/explain)",
      "active_table": "string (опционально)"
    }
  }
}
```

**`tool.result`** — ответ клиента на вызов инструмента:
```json
{
  "type": "tool.result",
  "call_id": "string (UUID вызова)",
  "payload": {
    "success": true,
    "data": {}
  }
}
```

#### Типы сообщений: Backend → Client

**`tool.call`** — запрос к инструменту клиента:
```json
{
  "type": "tool.call",
  "call_id": "string (UUID)",
  "payload": {
    "tool_name": "list_tables | describe_table | explain_query | execute_query | ...",
    "arguments": {}
  }
}
```

**`agent.stream`** — стриминг ответа агента:
```json
{
  "type": "agent.stream",
  "request_id": "string",
  "payload": {
    "delta": "string (chunk текста)"
  }
}
```

**`agent.response`** — финальный ответ агента:
```json
{
  "type": "agent.response",
  "request_id": "string",
  "payload": {
    "action": "string",
    "result": {
      "sql": "string (для generate/improve)",
      "explanation": "string (для explain/analyze)",
      "candidates": ["string"] 
    },
    "tool_calls_log": [],
    "model_used": "string",
    "tokens_used": 0
  }
}
```

**`agent.error`** — ошибка выполнения:
```json
{
  "type": "agent.error",
  "request_id": "string",
  "payload": {
    "code": "string",
    "message": "string"
  }
}
```

---

## 6. Агентный пайплайн (Hybrid SQL Agent)

Архитектура, показавшая лучшие результаты на бенчмарках BIRD, Spider2, TPC-DS. Даёт прирост accuracy ~10% по сравнению с прямой генерацией.

### 6.1 Шаги пайплайна для `generate_sql`

```
1. Schema Grounding
   Input:  user_message, db_context
   Action: Вызов tools клиента (list_tables, describe_table для релевантных таблиц)
   Output: Обогащённый контекст схемы

2. Initial SQL Generation
   Input:  user_message + schema context
   Action: LLM генерирует N=3 кандидата SQL (parallel calls)
   Output: [sql_candidate_1, sql_candidate_2, sql_candidate_3]

3. Diagnostic Retry
   Input:  каждый кандидат
   Action: Вызов explain_query на клиенте для каждого кандидата
   Output: Диагностика ошибок; при ошибке — повторная генерация с контекстом ошибки (max 2 retry)

4. Seed Expansion
   Input:  валидные кандидаты
   Action: LLM генерирует вариации для каждого кандидата (если кандидатов < 3)
   Output: Расширенный пул кандидатов

5. Result Aggregation
   Input:  пул кандидатов
   Action: LLM выбирает лучший SQL с обоснованием
   Output: final_sql + explanation
```

### 6.2 Шаги для `improve_sql`

```
1. Анализ: LLM анализирует переданный SQL
2. explain_query: вызов EXPLAIN ANALYZE через tool клиента
3. Генерация улучшений: LLM предлагает оптимизированный SQL
4. Возврат: улучшенный SQL + список изменений
```

### 6.3 Шаги для `explain_sql`

```
1. Парсинг: структурный разбор SQL агентом
2. Объяснение: LLM генерирует объяснение на естественном языке
3. Возврат: explanation string
```

### 6.4 Шаги для `analyze_schema`

```
1. Schema dump: вызов list_schemas, list_tables, describe_table через tools
2. Анализ: LLM анализирует связи, индексы, потенциальные проблемы
3. Возврат: структурированный отчёт
```

### 6.5 Tool Timeout

Каждый `tool.call` ожидает `tool.result` максимум **10 секунд**. При таймауте — `agent.error` с кодом `tool_timeout`.

---

## 7. Инструменты клиента (Tools Contract)

Бэкенд вызывает tools через WebSocket. Клиент обязан реализовать следующий контракт:

| Tool | Аргументы | Возвращает |
|---|---|---|
| `list_schemas` | `{}` | `{ schemas: [string] }` |
| `list_tables` | `{ schema: string }` | `{ tables: [{ name, type }] }` |
| `describe_table` | `{ schema: string, table: string }` | `{ columns: [{name, type, nullable, default}], indexes: [], foreign_keys: [] }` |
| `list_indexes` | `{ schema: string, table: string }` | `{ indexes: [{name, columns, unique}] }` |
| `explain_query` | `{ sql: string }` | `{ plan: string, error?: string }` |
| `execute_query` | `{ sql: string, limit: int }` | `{ rows: [], columns: [], error?: string }` |
| `list_functions` | `{ schema: string }` | `{ functions: [{name, args, return_type}] }` |

**Ограничения безопасности:**
- `execute_query` выполняет только `SELECT` и `EXPLAIN`
- `DELETE`, `DROP`, `TRUNCATE` — запрещены на уровне бэкенда (проверяется парсингом SQL до вызова tool)

---

## 8. Аутентификация и безопасность

### JWT-токены
- Алгоритм: HS256
- Поля: `session_id`, `exp`, `iat`
- Срок жизни: 24 часа

### Изоляция данных
- Бэкенд не хранит данные пользователя (схемы, результаты запросов)
- Все данные из tools используются только в рамках одного агентного запроса и не персистируются

### Аудит-лог
Каждый агентный запрос логируется в структурированном формате:
```json
{
  "timestamp": "ISO8601",
  "session_id": "string",
  "action": "string",
  "tool_calls": ["tool_name"],
  "model": "string",
  "tokens": 0,
  "duration_ms": 0,
  "error": "string | null"
}
```

---

## 9. Минимальный клиент для тестирования

Чтобы обеспечить end-to-end тестирование с первого дня, параллельно с бэкендом разрабатывается минимальный тестовый клиент.

**Требования к минимальному клиенту:**

1. Подключение к реальной PostgreSQL через `lib/pq` или `pgx`
2. Реализация всех tools из раздела 7 (полная, не заглушки)
3. WebSocket-подключение к бэкенду с JWT-авторизацией
4. Обработка входящих `tool.call` и отправка `tool.result`
5. Простой CLI-интерфейс для отправки `agent.request`:
   ```
   > generate: покажи топ 10 пользователей по заказам
   > improve: <вставить SQL>
   > explain: <вставить SQL>
   ```
6. Вывод `agent.stream` в реальном времени и финального `agent.response`

**Технология:** Go (тот же язык, что и бэкенд) — одна кодовая база, общие типы.

**Acceptance criteria:**
- Клиент стартует командой `go run ./client-minimal --dsn postgres://... --backend ws://localhost:8080`
- Успешно выполняет полный цикл: agent.request → tool.call → tool.result → agent.response
- Все 4 action (generate_sql, improve_sql, explain_sql, analyze_schema) работают end-to-end

---

## 10. Docker-окружение

```yaml
# docker-compose.yml
services:
  backend:
    build: ./docker/Dockerfile.backend
    ports:
      - "8080:8080"
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
      - JWT_SECRET=${JWT_SECRET}

  postgres-test:
    image: postgres:16
    environment:
      POSTGRES_DB: progressql_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5432:5432"
    volumes:
      - ./docker/seed.sql:/docker-entrypoint-initdb.d/seed.sql
```

`docker-compose up` поднимает бэкенд + тестовую PostgreSQL с seed-данными.

---

## 11. Этапы разработки

### Milestone 1: Скелет (1–2 недели)
- [ ] REST эндпоинты: `/health`, `/auth/token`, `/sessions`
- [ ] WebSocket hub с JWT-авторизацией
- [ ] Базовая обработка `agent.request` и `tool.call / tool.result`
- [ ] Минимальный клиент с реальным PostgreSQL-подключением
- [ ] docker-compose окружение

**Acceptance criteria Milestone 1:** Клиент подключается по WebSocket, бэкенд отправляет `tool.call`, клиент отвечает `tool.result` с реальными данными схемы.

---

### Milestone 2: LLM-интеграция (1–2 недели)
- [ ] OpenRouter HTTP-клиент с retry и таймаутами
- [ ] Базовый агент: `explain_sql` и `improve_sql` (1 шаг, без мультикандидатов)
- [ ] Стриминг ответа через `agent.stream`
- [ ] Структурированный аудит-лог

**Acceptance criteria Milestone 2:** Клиент отправляет SQL, бэкенд возвращает объяснение / улучшенный SQL через LLM.

---

### Milestone 3: Hybrid SQL Agent (2–3 недели)
- [ ] Полный пайплайн `generate_sql` (schema grounding → N кандидатов → diagnostic retry → aggregation)
- [ ] `analyze_schema` — анализ всей схемы
- [ ] Параллельная генерация N кандидатов (goroutines)
- [ ] Seed expansion при нехватке валидных кандидатов
- [ ] Security check для `execute_query` (только SELECT/EXPLAIN)

**Acceptance criteria Milestone 3:** Пайплайн генерации SQL проходит на тестовой БД с seed-данными; accuracy измеряется на 20+ тестовых запросах.

---

### Milestone 4: Production-ready (1–2 недели)
- [ ] Rate limiting по session_id
- [ ] Graceful shutdown
- [ ] Метрики (токены, latency, error rate)
- [ ] README с инструкцией запуска

---

## 12. Потенциальные проблемы и решения

| Проблема | Решение |
|---|---|
| Tool timeout при медленной БД | Таймаут 10с на каждый tool.call; агент продолжает с частичным контекстом |
| LLM генерирует невалидный SQL | Diagnostic retry (шаг 3 пайплайна) с ошибкой из EXPLAIN как feedback |
| Высокая стоимость N параллельных LLM-запросов | N=3 для MVP; конфигурируемый параметр `agent.candidates_count` |
| WebSocket разрыв во время агентного запроса | Session state хранится in-memory; при реконнекте — новый запрос |
| pgAdmin fork оказался слишком сложным | Бэкенд не знает о типе клиента; Nextron-клиент подключается тем же WebSocket-протоколом |

---

## 13. Возможности будущего расширения

- **Генерация миграций** (`generate_migration` tool + новый action в агенте)
- **Мультипользовательский режим** (SaaS): добавить user_id в JWT, rate limits по плану
- **История запросов**: опциональная персистентность agent_log в PostgreSQL
- **Кастомные модели**: пользователь выбирает модель через `/sessions` (уже заложено в API)
- **pgAdmin fork-клиент**: подключается тем же протоколом без изменений бэкенда

---

## 14. Ссылки

- [OpenRouter API Docs](https://openrouter.ai/docs)
- [gorilla/websocket](https://github.com/gorilla/websocket)
- [pgx — PostgreSQL driver for Go](https://github.com/jackc/pgx)
- [BIRD SQL Benchmark](https://bird-bench.github.io/)


---
---


# PRD: progresql-client — Отладка, рефакторинг и целевое состояние

**Версия:** 1.0  
**Дата:** 2026-03-13  
**Статус:** Draft  
**Стек:** Nextron (Electron + Next.js) + TypeScript + MUI + CodeMirror

---

## 1. Контекст

Существующий клиент `progresql-client` — это Electron-приложение на базе Nextron с Next.js и MUI. Реализованы базовые экраны: подключение к БД, SQL-редактор, чат с ChatGPT, интеграция с MCP-сервером на Python. Проект сырой: есть структурные баги, архитектурные долги и нереализованные TODO.

Цель этого PRD — привести клиент к состоянию, пригодному для end-to-end тестирования с новым Go-бэкендом, и зафиксировать целевую архитектуру.

---

## 2. Критические баги (исправить в первую очередь)

### BUG-01: Race condition при восстановлении соединения
**Файл:** `renderer/pages/index.tsx`, функция `handleConnect`

**Проблема:** `handleConnect` вызывает `setConnections` с функциональным апдейтом, внутри которого запускает async-операцию `performConnection`. Это антипаттерн React — side effects нельзя запускать внутри setState.

```typescript
// СЕЙЧАС (неправильно):
const handleConnect = async (connectionId: string) => {
  setConnections(currentConnections => {
    const connection = currentConnections.find(c => c.id === connectionId);
    (async () => { await performConnection(connection); })(); // ❌ side effect внутри setState
    return currentConnections;
  });
};

// КАК ДОЛЖНО БЫТЬ:
const handleConnect = async (connectionId: string) => {
  const connection = connections.find(c => c.id === connectionId);
  if (!connection) return;
  await performConnection(connection);
};
```

**Acceptance criteria:** `handleConnect` не содержит async-операций внутри `setConnections`.

---

### BUG-02: Двойной вызов setConnections при connect
**Файл:** `renderer/pages/index.tsx`, функция `performConnection`

**Проблема:** При успешном подключении `setConnections` вызывается трижды подряд:
1. `prev.map(c => ({ ...c, isActive: false }))` — сброс всех
2. `prev.map(c => c.id === connectionId ? { ...c, isActive: true } : c)` — активация
3. `prev.map(c => c.id === connectionId ? { ...c, databases: ..., isActive: true } : c)` — добавление структуры

Это три ре-рендера вместо одного, с возможными состояниями гонки.

**Исправление:** Объединить в один `setConnections` вызов.

**Acceptance criteria:** При успешном подключении `setConnections` вызывается максимум один раз с финальным состоянием.

---

### BUG-03: Утечка памяти в NotificationContext
**Файл:** `renderer/contexts/NotificationContext.tsx`

**Проблема:** `showNotification` замыкается на `currentNotification` через `useCallback`, что создаёт stale closure. Новые уведомления могут не показываться если `currentNotification` не обновился в момент вызова.

```typescript
// Проблема: currentNotification в зависимостях создаёт пересоздание callback при каждом изменении
const showNotification = useCallback((message, severity, duration) => {
  if (!currentNotification) { // ❌ stale closure
    setCurrentNotification(notification);
  }
}, [currentNotification]); // пересоздаётся при каждом показе уведомления
```

**Исправление:** Использовать `useRef` для очереди уведомлений или перейти на `useReducer`.

**Acceptance criteria:** Очередь из 3+ уведомлений показывается корректно по одному.

---

### BUG-04: ChatPanel обращается к приватному полю через индексацию
**Файл:** `renderer/components/ChatPanel.tsx`

**Проблема:**
```typescript
chatGPTServiceRef.current['openAIService'].checkAvailability()
// ❌ доступ к приватному полю через строковый индекс — сломается при минификации
```

**Исправление:** Добавить публичный метод `checkAvailability()` в `ChatGPTWithMCP`.

**Acceptance criteria:** Нет доступа к приватным полям через `['fieldName']`.

---

### BUG-05: ChatService использует неимпортированный тип
**Файл:** `renderer/services/chat/ChatService.ts`

**Проблема:**
```typescript
constructor(wsClient: WebSocketClient) { // ❌ WebSocketClient не импортирован, должен быть IWebSocketClient
```

**Исправление:** Заменить `WebSocketClient` на `IWebSocketClient` в сигнатуре конструктора.

**Acceptance criteria:** `ChatService` компилируется без ошибок TypeScript.

---

### BUG-06: DatabaseStructure.success и DatabaseStructure.schemas не совпадают с типами
**Файл:** `renderer/types/index.ts` vs `renderer/services/database/DatabaseSchemaService.ts`

**Проблема:** В `DatabaseSchemaService` используется `structure.success` и `structure.schemas`, но в интерфейсе `DatabaseStructure` нет поля `success` и `schemas` — только `schemas` через отдельный тип `Schema[]`. При этом в сервисе идёт `s.schema_name || s` — двойной fallback говорит что реальная форма ответа от Electron не совпадает с типами.

**Исправление:** Привести тип ответа `getDatabaseStructure` к единому интерфейсу с полем `success: boolean`.

**Acceptance criteria:** Нет `|| s` fallback-ов в DatabaseSchemaService; типы соответствуют реальным ответам из main process.

---

### BUG-07: setTimeout(1000) при восстановлении соединения — хрупкая логика
**Файл:** `renderer/pages/index.tsx`

**Проблема:**
```typescript
setTimeout(() => {
  handleConnect(active.id);
}, 1000); // ❌ ждём секунду что electronAPI "инициализируется"
```

Это race condition с магическим числом. На медленной машине — сломается, на быстрой — лишняя задержка.

**Исправление:** Использовать проверку готовности через IPC-сообщение `app-ready` от main process вместо таймаута.

**Acceptance criteria:** Нет `setTimeout` с хардкоженным таймаутом для ожидания API.

---

## 3. Архитектурные проблемы

### ARCH-01: LLM захардкожен на OpenAI
**Файл:** `renderer/services/chat/OpenAIService.ts`

Клиент напрямую стучится в `https://api.openai.com/v1/chat/completions`. При переходе на новый Go-бэкенд это нужно заменить на WebSocket-протокол из PRD бэкенда.

**Целевое состояние:** `ChatGPTWithMCP` → переименовать в `AgentService`, заменить прямые OpenAI вызовы на `agent.request` по WebSocket к Go-бэкенду.

---

### ARCH-02: MCP-сервер запускается как дочерний процесс клиента
**Файл:** `mcp-manager.js`

Сейчас MCP Python-сервер стартует как дочерний процесс Electron. В целевой архитектуре инструменты (tools) предоставляет клиент бэкенду через WebSocket, а не запускает отдельный сервер.

**Целевое состояние:** `mcp-manager.js` → `tool-server.js`, реализующий WebSocket-сервер с tool handlers по контракту из PRD бэкенда.

---

### ARCH-03: Auth — мок без реального бэкенда
**Файл:** `renderer/providers/AuthProvider.tsx` (не читали, но видно по использованию)

Судя по структуре — auth реализован как localStorage-мок. При подключении к Go-бэкенду нужен реальный JWT-флоу через `POST /api/v1/auth/token`.

---

### ARCH-04: Соединения хранятся в localStorage без шифрования
**Файл:** `renderer/utils/connectionStorage.ts`

Пароли PostgreSQL хранятся в localStorage в открытом виде. Для Electron-приложения нужно использовать `electron-store` с шифрованием через `safeStorage`.

---

### ARCH-05: WebSocket клиент не используется в основном флоу
**Файл:** `renderer/services/websocket/WebSocketClient.ts`

Есть полноценный `WebSocketClient`, `MockWebSocketClient`, `WebSocketClientWithLogging`, но `ChatPanel` их не использует — общается с OpenAI напрямую через fetch. WebSocket инфраструктура создана, но не подключена к UI.

---

## 4. TODO, требующие реализации

| # | Файл | Описание |
|---|---|---|
| TODO-01 | `index.tsx:handleSelectTable` | Вставка имени таблицы в SQL-редактор при клике |
| TODO-02 | `index.tsx:handleSelectView` | Вставка имени view в SQL-редактор |
| TODO-03 | `index.tsx:handleSelectFunction` | Вставка имени функции в SQL-редактор |
| TODO-04 | `index.tsx:handleSelectProcedure` | Вставка имени процедуры в SQL-редактор |

Все четыре — одна задача: пробросить ref к CodeMirror редактору и реализовать `insertText(name)`.

---

## 5. Целевое состояние клиента

### 5.1 Архитектура целевого клиента

```
Electron Main Process
  ├── main.js — BrowserWindow, IPC handlers
  ├── tool-server.js — WebSocket сервер, отвечает на tool.call от Go-бэкенда
  └── preload.js — contextBridge

Renderer (Next.js)
  ├── pages/
  │   ├── index.tsx — главный экран
  │   ├── login.tsx — авторизация через Go-бэкенд JWT
  │   └── settings.tsx — настройки модели, API
  ├── services/
  │   ├── agent/ — AgentService (WebSocket к Go-бэкенду)
  │   └── database/ — DatabaseSchemaService (через electronAPI)
  └── components/
      ├── ChatPanel.tsx — чат с агентом
      ├── SQLEditor.tsx — CodeMirror + вставка из дерева
      └── DatabasePanel.tsx — дерево объектов БД
```

### 5.2 Новый флоу взаимодействия

```
[Пользователь] → ChatPanel → AgentService
                                    ↓ WebSocket (agent.request)
                              Go Backend
                                    ↓ WebSocket (tool.call)
                              ToolServer (в Electron main)
                                    ↓ IPC
                              PostgreSQL (через pg)
                                    ↑ tool.result
                              Go Backend
                                    ↑ agent.response
                              ChatPanel
```

### 5.3 Контракт ToolServer (WebSocket сервер в Electron)

ToolServer принимает входящие WebSocket-соединения от Go-бэкенда и отвечает на `tool.call` согласно протоколу из PRD бэкенда. Реализует все инструменты из раздела 7 PRD бэкенда:

| Tool | Реализация в Electron |
|---|---|
| `list_schemas` | `SELECT schema_name FROM information_schema.schemata` |
| `list_tables` | `SELECT table_name FROM information_schema.tables WHERE table_schema = $1` |
| `describe_table` | `SELECT * FROM information_schema.columns WHERE table_name = $1` + indexes |
| `list_indexes` | `SELECT * FROM pg_indexes WHERE tablename = $1` |
| `explain_query` | `EXPLAIN (FORMAT JSON) ${sql}` |
| `execute_query` | `${sql} LIMIT ${limit}` — только SELECT |
| `list_functions` | `SELECT routine_name FROM information_schema.routines` |

---

## 6. Roadmap задач

### Milestone 1: Исправление критических багов (1 неделя)

- [ ] **BUG-01** — Убрать side effects из setState в handleConnect
- [ ] **BUG-02** — Объединить setConnections вызовы в performConnection
- [ ] **BUG-03** — Переписать NotificationContext на useReducer
- [ ] **BUG-04** — Добавить публичный `checkAvailability()` в ChatGPTWithMCP
- [ ] **BUG-05** — Исправить тип в конструкторе ChatService
- [ ] **BUG-06** — Привести DatabaseStructure типы к реальным ответам из main
- [ ] **BUG-07** — Убрать setTimeout(1000), заменить на app-ready событие
- [ ] **TODO-01..04** — Реализовать вставку объектов БД в SQL-редактор

**Acceptance criteria Milestone 1:**
- `npm run dev` запускается без ошибок TypeScript
- Подключение к PostgreSQL и выполнение SELECT работает стабильно
- Дерево объектов кликабельно и вставляет имена в редактор

---

### Milestone 2: Подготовка к интеграции с Go-бэкендом (1-2 недели)

- [ ] **ARCH-02** — Реализовать `tool-server.js` — WebSocket сервер в Electron main с handlers для всех 7 инструментов
- [ ] **ARCH-01** — Создать `AgentService` с WebSocket-подключением к Go-бэкенду (`agent.request` / `agent.response` / `agent.stream`)
- [ ] **ARCH-03** — Реализовать JWT auth через `POST /api/v1/auth/token` Go-бэкенда
- [ ] Подключить `AgentService` к `ChatPanel` вместо прямого OpenAI

**Acceptance criteria Milestone 2:**
- Клиент отправляет `agent.request` к Go-бэкенду
- Бэкенд делает `tool.call` к Electron ToolServer
- Electron отвечает `tool.result` с реальными данными из PostgreSQL
- ChatPanel показывает `agent.response` со стримингом

---

### Milestone 3: Production-ready клиент (1 неделя)

- [ ] **ARCH-04** — Шифрование паролей в хранилище через `electron-store` + `safeStorage`
- [ ] Убрать все `console.log` из production-сборки (заменить на structured logging)
- [ ] Настройки модели в UI (выбор модели через `POST /api/v1/sessions`)
- [ ] Сохранение истории чата в сессии
- [ ] Improve SQL кнопка в SQL-редакторе (выделить → отправить action=improve_sql)

---

## 7. Что не трогаем

- UI/UX и дизайн — MUI компоненты работают нормально, косметику не трогаем
- CodeMirror конфигурация — SQL-редактор работает корректно
- Структура страниц Next.js — роутинг нормальный
- `QueryResults` компонент — отображение результатов адекватное
- `DatabasePanel` дерево — работает, нужно только добавить onClick вставку

---

## 8. Тестирование

### End-to-end тест (после Milestone 2)

```
1. Запустить: docker-compose up (Go backend + PostgreSQL test)
2. Запустить: npm run dev (Nextron клиент)
3. Авторизоваться через JWT
4. Подключиться к тестовой PostgreSQL
5. В чате написать: "покажи все таблицы"
6. Проверить: бэкенд вызвал tool list_tables → Electron ответил → LLM получил схему → показал таблицы
7. В чате написать: "напиши SELECT топ 10 пользователей"
8. Проверить: в ответе есть SQL-блок с кнопкой Run
9. Нажать Run → SQL вставился в редактор и выполнился
10. Проверить результаты в QueryResults
```

### Smoke тесты для Milestone 1

```
1. npm run dev — старт без ошибок
2. Добавить соединение → подключиться → структура загружена в дерево
3. Написать SELECT * FROM pg_tables LIMIT 5 → результат отображён
4. Закрыть и открыть приложение → соединение восстановлено
5. Показать 3 уведомления подряд → отображаются по очереди без потерь
```
