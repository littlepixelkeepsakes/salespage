import serverless from 'serverless-http';
import { createApiApp } from '../../src/server/apiApp';

const app = createApiApp();

export const handler = serverless(app, {
  binary: ['image/*', 'application/pdf', 'application/octet-stream']
});
