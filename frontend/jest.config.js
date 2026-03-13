/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/renderer'],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.jest.json',
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/renderer/$1',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  setupFilesAfterEnv: ['<rootDir>/renderer/__tests__/setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
