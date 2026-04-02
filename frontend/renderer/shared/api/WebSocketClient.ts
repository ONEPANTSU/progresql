import { createLogger } from '@/shared/lib/logger';

const log = createLogger('WebSocketClient');

export interface IWebSocketClient {
  connect(url: string): Promise<void>;
  disconnect(): void;
  send(message: unknown): void;
  onMessage(callback: (message: unknown) => void): void;
  onClose(callback: () => void): void;
  onError(callback: (error: Error) => void): void;
  isConnected(): boolean;
}

export class WebSocketClient implements IWebSocketClient {
  private ws: WebSocket | null = null;
  private messageCallbacks: Array<(message: unknown) => void> = [];
  private closeCallbacks: Array<() => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];
  private connected: boolean = false;

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
          this.connected = true;
          resolve();
        };
        
        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.messageCallbacks.forEach(callback => callback(message));
          } catch (error) {
            log.error('Failed to parse WebSocket message:', error);
          }
        };
        
        this.ws.onclose = () => {
          this.connected = false;
          this.closeCallbacks.forEach(callback => callback());
        };
        
        this.ws.onerror = (error) => {
          this.connected = false;
          const errorObj = new Error('WebSocket connection error');
          this.errorCallbacks.forEach(callback => callback(errorObj));
          reject(errorObj);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  send(message: unknown): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(message));
    } else {
      log.warn('WebSocket is not connected. Cannot send message.');
    }
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
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
