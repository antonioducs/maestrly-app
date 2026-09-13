import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'test/e2e',workers:1,timeout:30000,use:{trace:'retain-on-failure'}});
