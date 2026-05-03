# ProgreSQL

Современное клиентское приложение для работы с PostgreSQL базами данных, построенное на Nextron (Next.js + Electron) с AI-ассистентом на Go-бэкенде.

## Основные возможности

### Подключение к базе данных
- Форма для ввода параметров подключения (host, port, username, password, database)
- Поддержка именованных подключений
- Валидация параметров подключения

### SQL Редактор
- Интерактивный редактор с подсветкой синтаксиса PostgreSQL (highlight.js pgsql)
- Поддержка CodeMirror 6
- Горячие клавиши (Ctrl+Enter для выполнения запроса)
- Копирование и очистка запросов

### Навигация по структуре базы данных
- Просмотр всех таблиц, представлений и функций
- Детальная информация о колонках, индексах, констрейнтах и триггерах
- Статистика базы данных
- Интерактивное раскрытие/сворачивание элементов

### Результаты запросов
- Табличное отображение результатов
- Пагинация для больших наборов данных
- Детальный просмотр строк в JSON формате

## AI-агент

Go-бэкенд оркестрирует LLM (через OpenRouter) и предоставляет агента с набором тулов для работы с PostgreSQL.

### Тулы агента

| Тул | Описание | Параметры |
|---|---|---|
| `list_schemas` | Список всех схем в базе данных | — |
| `list_tables` | Список таблиц и представлений в схеме | `schema` (обязательный) |
| `describe_table` | Колонки, индексы, внешние ключи таблицы | `schema`, `table` (обязательные) |
| `list_indexes` | Индексы таблицы | `schema`, `table` (обязательные) |
| `list_functions` | Функции и процедуры в схеме | `schema` (обязательный) |
| `explain_query` | EXPLAIN плана выполнения SQL запроса | `sql` (обязательный) |
| `execute_query` | Выполнение read-only SQL (SELECT/EXPLAIN) | `sql` (обязательный), `limit` (опциональный) |

### Действия агента

| Действие | Описание |
|---|---|
| `generate_sql` | Генерация SQL по запросу пользователя на естественном языке |
| `improve_sql` | Улучшение/оптимизация существующего SQL запроса |
| `explain_sql` | Объяснение что делает SQL запрос |
| `analyze_schema` | Анализ структуры подключённой базы данных |

### Safe Mode vs Full Access

Все 7 тулов доступны в обоих режимах. Разница — в системном промпте и валидации SQL.

| | Safe Mode (по умолчанию) | Full Access |
|---|---|---|
| **Тулы** | Все 7 доступны | Все 7 доступны |
| **SQL генерация** | Только SELECT, EXPLAIN, WITH (CTE) | Любой SQL включая INSERT, UPDATE, DELETE, DDL |
| **Авто-выполнение** | Отключено — запросы не выполняются автоматически | Включено для SELECT/WITH |
| **Доступ к данным** | Только метаданные (схема, структура) | Полный доступ к данным |
| **Системные каталоги** | Разрешены SELECT из pg_proc, pg_class, pg_attribute, pg_constraint, pg_trigger, pg_views, pg_settings, information_schema.* | Без ограничений |
| **Тело функций** | Доступно через `execute_query` → `SELECT prosrc FROM pg_proc` | Доступно |
| **DML/DDL** | Заблокировано (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT, REVOKE, COPY, TRUNCATE) | Разрешено с предупреждением |

#### Safe Mode — допустимые системные запросы

В безопасном режиме агент может выполнять SELECT к системным каталогам для инспекции структуры БД:

```sql
-- Тело функции
SELECT proname, prosrc, pg_get_function_arguments(oid) FROM pg_proc WHERE proname = '...';

-- Структура таблицы
SELECT * FROM information_schema.columns WHERE table_name = '...';

-- Индексы
SELECT * FROM pg_indexes WHERE tablename = '...';

-- Внешние ключи
SELECT * FROM pg_constraint WHERE conrelid = '...'::regclass;

-- Триггеры
SELECT * FROM pg_trigger WHERE tgrelid = '...'::regclass;

-- Определение представления
SELECT definition FROM pg_views WHERE viewname = '...';

-- Статистика таблиц
SELECT * FROM pg_stat_user_tables;

-- Расширения
SELECT * FROM pg_extension;

-- Настройки сервера
SELECT * FROM pg_settings WHERE name = '...';
```

Эти запросы безопасны — они показывают только метаданные, не пользовательские данные.

### Язык ответов

Агент отвечает на языке, выбранном в интерфейсе (русский/английский). Язык передаётся в контексте каждого запроса. Комментарии в генерируемом SQL также на выбранном языке.

## Технологии

- **Frontend**: Next.js 14, React 18, TypeScript
- **Desktop**: Electron 37
- **UI**: Material-UI (MUI) 5
- **SQL Editor**: CodeMirror 6
- **Backend**: Go, WebSocket, OpenRouter API
- **Database**: PostgreSQL (MCP-сервер на Python)
- **Build**: Nextron, electron-builder

## Установка и запуск

### Разработка
```bash
make dev          # Клиент (Electron + Next.js)
make dev-backend  # Бэкенд (Go)
```

### Сборка
```bash
make release-mac  # macOS DMG + GitHub Release + тег для CI
```

### Тесты
```bash
make test-backend  # Go тесты
```

## Горячие клавиши

- `Ctrl+Enter` / `Cmd+Enter` — выполнить SQL запрос
- `Tab` — отступ в редакторе

## Безопасность

- Context isolation в Electron
- Safe Mode включён по умолчанию
- SQL валидация на бэкенде (блокировка DML/DDL в safe mode)
- JWT аутентификация
- Rate limiting

## Автор

ONEPANTSU
