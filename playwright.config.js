import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, workers: 1, fullyParallel: false,
  use: { baseURL:'http://127.0.0.1:3211', headless:true, screenshot:'only-on-failure', trace:'retain-on-failure' },
  webServer: [
    {command:'node server.js',url:'http://127.0.0.1:3211',env:{PORT:'3211'},reuseExistingServer:false},
    {command:'node tests/fixture-server.js',url:'http://127.0.0.1:4321/health',reuseExistingServer:false}
  ]
});
