/** @type {import('ts-jest').JestConfigWithTsJest} */

// The source uses NodeNext module resolution, so relative imports carry a `.js`
// extension (e.g. `../config/index.js`). ts-jest resolves against the `.ts`
// sources, so we strip the extension for the resolver.
const tsJestTransform = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      isolatedModules: true,
    },
  ],
};

const moduleNameMapper = {
  '^(\\.{1,2}/.*)\\.js$': '$1',
};

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/unit'],
      testMatch: ['**/*.test.ts'],
      transform: tsJestTransform,
      moduleNameMapper,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/integration'],
      testMatch: ['**/*.test.ts'],
      transform: tsJestTransform,
      moduleNameMapper,
      // Integration tests hit real AWS APIs; give them room to run.
      testTimeout: 300000,
    },
  ],
};
