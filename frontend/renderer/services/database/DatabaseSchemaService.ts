import { DatabaseSchemaMessage, DatabaseStructureResponse } from '../../types';
import { createLogger } from '../../utils/logger';

const log = createLogger('DatabaseSchemaService');

export class DatabaseSchemaService {
  async getDatabaseSchema(): Promise<DatabaseSchemaMessage | undefined> {
    try {
      // Check if we're in Electron environment
      if (typeof window === 'undefined' || !window.electronAPI) {
        log.warn('Electron API not available');
        return undefined;
      }

      // Check if getDatabaseStructure is available
      if (!window.electronAPI.getDatabaseStructure) {
        log.warn('getDatabaseStructure method not available');
        return undefined;
      }

      // Get database structure from Electron
      const response: DatabaseStructureResponse = await window.electronAPI.getDatabaseStructure();

      if (!response || !response.success) {
        // This is expected if database is not connected - don't log as error
        if (response?.message?.includes('No database connection') ||
            response?.message?.includes('not connected') ||
            response?.message?.includes('No database')) {
          log.debug('Database not connected - schema not available');
        } else {
          log.warn('Failed to get database structure:', response?.message);
        }
        return undefined;
      }

      const db = response.databases?.[0];
      if (!db) {
        log.warn('No database info in response');
        return undefined;
      }

      // Transform DatabaseInfo to DatabaseSchemaMessage format
      const schemaMessage: DatabaseSchemaMessage = {
        dbms: 'postgresql',
        schemas: db.schemas?.map(s => s.schema_name) || [],
        entities: {
          tables: db.tables?.map(t => t.table_name) || [],
          views: db.views?.map(v => v.view_name) || [],
          sequences: db.sequences?.map(s => s.sequence_name) || [],
          functions: db.functions?.map(f => f.routine_name) || [],
        },
      };

      log.debug('Successfully fetched schema:', {
        schemasCount: schemaMessage.schemas.length,
        tablesCount: schemaMessage.entities.tables.length,
        viewsCount: schemaMessage.entities.views.length,
        functionsCount: schemaMessage.entities.functions.length,
      });

      return schemaMessage;
    } catch (error) {
      log.error('Error fetching database schema:', error);
      return undefined;
    }
  }
}
