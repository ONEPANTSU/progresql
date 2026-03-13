/**
 * Тестовый скрипт для проверки работы MCP клиента/сервера
 * 
 * Использование:
 *   node test-mcp.js
 * 
 * Требования:
 *   - PostgreSQL база данных должна быть доступна
 *   - MCP сервер должен быть установлен в packages/mcp-postgres-server
 */

const path = require('path');
const { McpServerProcessManager } = require('./packages/mcp-client/McpServerProcessManager');
const { SafePostgresToolsApi } = require('./packages/mcp-client/SafePostgresToolsApi');

// Конфигурация подключения к БД (можно изменить)
const TEST_DB_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  username: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DATABASE || 'postgres',
};

async function testMcpServer() {
  console.log('🧪 Тестирование MCP сервера...\n');
  console.log('Конфигурация БД:', {
    ...TEST_DB_CONFIG,
    password: '[HIDDEN]',
  });
  console.log('');

  let mcpManager = null;

  try {
    // 1. Инициализация MCP сервера
    console.log('📦 Шаг 1: Инициализация MCP сервера...');
    const mcpServerPath = path.join(__dirname, 'packages', 'mcp-postgres-server');
    const fs = require('fs');
    
    if (!fs.existsSync(mcpServerPath)) {
      throw new Error('MCP сервер не найден. Убедитесь, что submodule инициализирован: git submodule update --init --recursive');
    }

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const venvPython = path.join(mcpServerPath, '.venv', 'bin', 'python');
    const pythonExecutable = fs.existsSync(venvPython) ? venvPython : pythonCmd;

    const postgresDsn = `postgresql://${TEST_DB_CONFIG.username}:${TEST_DB_CONFIG.password}@${TEST_DB_CONFIG.host}:${TEST_DB_CONFIG.port}/${TEST_DB_CONFIG.database}`;

    mcpManager = new McpServerProcessManager({
      command: pythonExecutable,
      args: ['-m', 'mcp_server.stdio_server'],
      cwd: mcpServerPath,
      env: {
        ...process.env,
        POSTGRES_DSN: postgresDsn,
        PYTHONPATH: path.join(mcpServerPath, 'src'),
      },
      logFile: path.join(__dirname, 'mcp-logs', 'test-mcp-server.log'),
      maxRestarts: 1,
      restartDelay: 1000,
    });

    // Обработка событий
    mcpManager.on('started', () => {
      console.log('✅ MCP сервер запущен\n');
    });

    mcpManager.on('error', (error) => {
      console.error('❌ Ошибка MCP сервера:', error.message);
    });

    mcpManager.on('restarting', (count) => {
      console.warn(`⚠️  Перезапуск MCP сервера (${count})...`);
    });

    // Запуск сервера
    await mcpManager.start();
    await new Promise(resolve => setTimeout(resolve, 2000)); // Даем время на инициализацию

    // 2. Получение клиента и создание Safe API
    console.log('📡 Шаг 2: Подключение к MCP серверу...');
    const client = mcpManager.getClient();
    
    if (!client || !client.isInitialized()) {
      throw new Error('MCP клиент не инициализирован');
    }

    const safeApi = new SafePostgresToolsApi(client);
    console.log('✅ Подключение установлено\n');

    // 3. Тестирование инструментов
    console.log('🔧 Шаг 3: Тестирование инструментов...\n');

    // 3.1. Получение списка схем
    console.log('📋 Тест 1: Получение списка схем...');
    try {
      const schemas = await safeApi.getSchemas();
      console.log(`✅ Найдено схем: ${schemas.length}`);
      console.log('   Схемы:', schemas.slice(0, 5).join(', '), schemas.length > 5 ? '...' : '');
      console.log('');
    } catch (error) {
      console.error('❌ Ошибка:', error.message);
      console.log('');
    }

    // 3.2. Получение списка таблиц
    console.log('📊 Тест 2: Получение списка таблиц (схема: public)...');
    try {
      const tables = await safeApi.getTables('public');
      console.log(`✅ Найдено таблиц: ${tables.length}`);
      if (tables.length > 0) {
        console.log('   Первые таблицы:', tables.slice(0, 3).map(t => t.name).join(', '));
      }
      console.log('');
    } catch (error) {
      console.error('❌ Ошибка:', error.message);
      console.log('');
    }

    // 3.3. Описание таблицы (если есть таблицы)
    let tables = [];
    try {
      const tablesResult = await safeApi.getTables('public');
      tables = tablesResult || [];
    } catch (error) {
      console.log('⚠️  Не удалось получить таблицы для теста описания');
    }

    if (tables && tables.length > 0) {
      const testTable = tables[0];
      console.log(`📝 Тест 3: Описание таблицы "${testTable.name}"...`);
      try {
        const description = await safeApi.describeTable(testTable.schema, testTable.name);
        console.log(`✅ Таблица описана`);
        console.log(`   Колонок: ${description.columns.length}`);
        console.log(`   Индексов: ${description.indexes?.length || 0}`);
        console.log(`   Ограничений: ${description.constraints?.length || 0}`);
        if (description.columns.length > 0) {
          console.log('   Первые колонки:', description.columns.slice(0, 3).map(c => c.name).join(', '));
        }
        console.log('');
      } catch (error) {
        console.error('❌ Ошибка:', error.message);
        console.log('');
      }
    }

    // 3.4. Тест allowlist (попытка вызвать запрещенный инструмент)
    console.log('🔒 Тест 4: Проверка allowlist (попытка вызвать запрещенный инструмент)...');
    try {
      // Попытка вызвать несуществующий/запрещенный инструмент
      await safeApi.mcpClient.callTool('dangerous_tool', {});
      console.error('❌ Allowlist не работает! Запрещенный инструмент был вызван');
    } catch (error) {
      if (error.message.includes('not allowed')) {
        console.log('✅ Allowlist работает корректно');
      } else {
        console.log('⚠️  Ошибка (ожидаемая):', error.message);
      }
    }
    console.log('');

    // 4. Получение списка доступных инструментов
    console.log('🛠️  Шаг 4: Список доступных инструментов...');
    try {
      const tools = client.getTools();
      console.log(`✅ Доступно инструментов: ${tools.length}`);
      tools.forEach(tool => {
        console.log(`   - ${tool.name}: ${tool.description}`);
      });
      console.log('');
    } catch (error) {
      console.error('❌ Ошибка:', error.message);
      console.log('');
    }

    console.log('✅ Все тесты завершены!\n');

  } catch (error) {
    console.error('\n❌ Критическая ошибка:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Остановка сервера
    if (mcpManager) {
      console.log('🛑 Остановка MCP сервера...');
      await mcpManager.stop();
      console.log('✅ MCP сервер остановлен');
    }
  }
}

// Запуск тестов
if (require.main === module) {
  testMcpServer().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { testMcpServer };
