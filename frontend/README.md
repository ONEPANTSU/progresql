# ProgreSQL

Современное клиентское приложение для работы с PostgreSQL базами данных, построенное на Nextron (Next.js + Electron).

## 🚀 Основные возможности

### Подключение к базе данных
- Форма для ввода параметров подключения (host, port, username, password, database)
- Поддержка именованных подключений
- Валидация параметров подключения

### SQL Редактор
- Интерактивный редактор с подсветкой синтаксиса SQL
- Поддержка CodeMirror 6
- Горячие клавиши (Ctrl+Enter для выполнения запроса)
- Возможность копирования и очистки запросов

### Навигация по структуре базы данных
- Просмотр всех таблиц, представлений и функций
- Детальная информация о колонках, индексах, констрейнтах и триггерах
- Статистика базы данных
- Интерактивное раскрытие/сворачивание элементов

### Результаты запросов
- Табличное отображение результатов
- Пагинация для больших наборов данных
- Детальный просмотр строк в JSON формате
- Информация о количестве строк и колонок
- Статус выполнения запросов

## 🛠 Технологии

- **Frontend**: Next.js 14, React 18, TypeScript
- **Desktop**: Electron 37
- **UI Framework**: Material-UI (MUI) 5
- **SQL Editor**: CodeMirror 6 с поддержкой SQL
- **Database**: PostgreSQL (через node-postgres)
- **Build Tool**: Nextron

## 📦 Установка и запуск

### Предварительные требования
- Node.js 18+ 
- PostgreSQL сервер
- npm или yarn

### Установка зависимостей
```bash
npm install
```

### Разработка
```bash
npm run dev
```

### Сборка
```bash
npm run build
```

### Запуск собранного приложения
```bash
npm start
```

### Создание дистрибутива
```bash
npm run dist
```

## 🔧 Конфигурация

### Параметры подключения по умолчанию
- **Host**: localhost
- **Port**: 5432
- **Username**: postgres
- **Database**: postgres

### Горячие клавиши
- `Ctrl+Enter` / `Cmd+Enter` - выполнить SQL запрос
- `Tab` - отступ в редакторе

## 🏗 Архитектура

### Структура проекта
```
app/
├── main.js              # Electron main process
├── preload.js           # Preload script для IPC
└── renderer/            # Next.js приложение
    ├── pages/           # Страницы Next.js
    ├── components/      # React компоненты
    └── types/           # TypeScript типы
```

### Компоненты
- `ConnectionForm` - форма подключения к базе данных
- `SQLEditor` - SQL редактор с CodeMirror
- `DatabaseExplorer` - навигация по структуре БД
- `QueryResults` - отображение результатов запросов

### IPC API
- `connect-database` - подключение к базе данных
- `execute-query` - выполнение SQL запроса
- `get-database-structure` - получение структуры БД
- `disconnect-database` - отключение от БД

## 🎨 Интерфейс

- **Темная тема** по умолчанию
- **Material Design** компоненты
- **Адаптивный дизайн** для разных разрешений
- **Интуитивная навигация** по структуре БД

## 🔒 Безопасность

- Context isolation в Electron
- Безопасная IPC коммуникация
- Валидация входных данных
- Отсутствие прямого доступа к файловой системе

## 🚧 Ограничения

- Поддерживается только PostgreSQL
- Одно активное подключение одновременно
- Базовое управление соединениями

## 🤝 Вклад в проект

1. Fork репозитория
2. Создайте feature branch (`git checkout -b feature/amazing-feature`)
3. Commit изменения (`git commit -m 'Add amazing feature'`)
4. Push в branch (`git push origin feature/amazing-feature`)
5. Откройте Pull Request

## 📄 Лицензия

ISC License

## 👨‍💻 Автор

ONEPANTSU

---

**ProgreSQL** - современный и удобный инструмент для работы с PostgreSQL базами данных.
