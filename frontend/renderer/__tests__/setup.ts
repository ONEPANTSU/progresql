import '@testing-library/jest-dom';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: jest.fn((key: string) => { delete store[key]; }),
    clear: jest.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: jest.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock window.electronAPI
Object.defineProperty(window, 'electronAPI', {
  value: {
    queryDatabase: jest.fn(),
    getDatabaseStructure: jest.fn(),
    connectToDatabase: jest.fn(),
    disconnectFromDatabase: jest.fn(),
  },
  writable: true,
});

// Mock scrollIntoView (not implemented in jsdom)
Element.prototype.scrollIntoView = jest.fn();

// Mock requestAnimationFrame
global.requestAnimationFrame = jest.fn((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});
global.cancelAnimationFrame = jest.fn();

// Reset mocks between tests
beforeEach(() => {
  localStorageMock.clear();
  jest.clearAllMocks();
});
