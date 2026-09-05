const path = require('path');
process.chdir(path.join(__dirname, '..'));

const serverless = require('serverless-http');
const app = require('../server');

module.exports = serverless(app, { request: { timeout: 29000 } });
