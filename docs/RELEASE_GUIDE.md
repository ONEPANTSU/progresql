# ProgreSQL — Release Guide

## Инфраструктура

- **CI/CD**: Woodpecker CI — `ci.progresql.com`
- **Backend**: Docker на `81.200.157.194`
- **macOS клиент**: билд локально на маке
- **Windows клиент**: билд на сервере (Docker + Wine)

## Команды

```bash
make help              # Все команды
make bump-patch        # 1.0.5 → 1.0.6
make release-backend   # Деплой backend (tag: backend-v*)
make release-landing   # Деплой landing (tag: landing-v*)
make release-mac       # Билд macOS + Windows через CI (tag: client-v*)
make release-all       # Всё сразу
```

## Теги → Пайплайны

| Тег | Пайплайн | Действие |
|-----|----------|----------|
| `backend-v*` | deploy-backend | Docker build → .env → compose up |
| `landing-v*` | deploy-landing | Копирование static → reload nginx |
| `client-v*` | build-client | macOS DMG (локально) + Windows EXE (сервер) → downloads |
