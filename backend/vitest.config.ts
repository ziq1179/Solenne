import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // This machine needs IPv4-first resolution for npm/network traffic;
    // propagate it to vitest's worker processes.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--dns-result-order=ipv4first'],
      },
    },
    testTimeout: 120_000,
    // beforeAll seeds + resets demo leave over the Neon pooler, which has real
    // cold-start latency (first pooled checkout can take a minute+ against a
    // serverless endpoint). The default 30s is too short — the suite would
    // time out on a cold DB before a single assertion runs.
    hookTimeout: 120_000,
  },
})