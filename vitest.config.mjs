import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.mjs'],
    environment: 'node',
    globals: false,
    reporters: ['verbose'],
    // Every input is a committed file. Nothing here may open a socket.
    testTimeout: 10000,
  },
})
