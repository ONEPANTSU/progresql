import { IWebSocketClient } from './WebSocketClient';
import { createLogger } from '@/shared/lib/logger';

const log = createLogger('WebSocketClient');

export class WebSocketClientWithLogging implements IWebSocketClient {
  private client: IWebSocketClient;

  constructor(client: IWebSocketClient) {
    this.client = client;
  }

  async connect(url: string): Promise<void> {
    log.debug('Connecting to:', url);
    try {
      await this.client.connect(url);
      log.debug('Connected successfully');
    } catch (error) {
      log.error('Connection failed:', error);
      throw error;
    }
  }

  disconnect(): void {
    log.debug('Disconnecting...');
    this.client.disconnect();
    log.debug('Disconnected');
  }

  send(message: unknown): void {
    const msg = message as Record<string, unknown>;
    log.debug('Sending message:', {
      type: msg.type,
      chatId: msg.chatId,
      hasPayload: !!msg.payload,
    });
    this.client.send(message);
  }

  onMessage(callback: (message: unknown) => void): void {
    this.client.onMessage((message) => {
      const msg = message as Record<string, unknown>;
      log.debug('Received message:', {
        type: msg.type,
        chatId: msg.chatId,
        hasPayload: !!msg.payload,
      });
      callback(message);
    });
  }

  onClose(callback: () => void): void {
    this.client.onClose(() => {
      log.debug('Connection closed');
      callback();
    });
  }

  onError(callback: (error: Error) => void): void {
    this.client.onError((error) => {
      log.error('Error:', error);
      callback(error);
    });
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }
}
