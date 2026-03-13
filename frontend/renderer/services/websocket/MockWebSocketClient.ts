import { IWebSocketClient } from './WebSocketClient';
import { createLogger } from '../../utils/logger';

const log = createLogger('MockWebSocketClient');

export class MockWebSocketClient implements IWebSocketClient {
  private connected: boolean = false;
  private messageCallbacks: Array<(message: unknown) => void> = [];
  private closeCallbacks: Array<() => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private messageQueue: unknown[] = [];

  async connect(url: string): Promise<void> {
    log.debug(' Connecting to:', url);
    // Simulate connection delay
    await new Promise(resolve => setTimeout(resolve, 100));
    this.connected = true;
    log.debug(' Connected (mock mode)');

    // Process any queued messages
    this.messageQueue.forEach(msg => {
      setTimeout(() => {
        this.messageCallbacks.forEach(callback => callback(msg));
      }, 50);
    });
    this.messageQueue = [];
  }

  disconnect(): void {
    log.debug(' Disconnecting');
    this.connected = false;
    this.closeCallbacks.forEach(callback => callback());
  }

  send(message: unknown): void {
    log.debug(' Sending message:', message);

    const msg = message as Record<string, unknown>;
    // Simulate receiving a response after a delay
    setTimeout(() => {
      // Mock response - you can customize this
      const mockResponse = {
        type: 'message',
        payload: {
          text: 'This is a mock response. WebSocket server is not connected.',
          sender: 'bot',
        },
        chatId: (msg.chatId as string) || 'default',
      };

      this.messageCallbacks.forEach(callback => callback(mockResponse));
    }, 500);
  }

  onMessage(callback: (message: unknown) => void): void {
    this.messageCallbacks.push(callback);
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  isConnected(): boolean {
    return this.connected;
  }
}
